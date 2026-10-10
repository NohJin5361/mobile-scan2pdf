// Document: page grid with drag-to-reorder, add pages, export, cloud sync.
import { h, icon, iconButton, toast, actionSheet, confirmDialog, promptDialog, revokeAll, objectUrl, withBusy } from '../ui.js';
import * as store from '../store.js';
import { api, cloudReady, checkServer, ocrReady } from '../api.js';
import { syncDoc, onSyncProgress, syncProgress } from '../sync.js';
import { pendingRenders } from '../pages.js';
import { importImages, syncBadge, openExportSheet, extractText, fileButton } from './common.js';
import { pdfBlob } from '../exporter.js';
import { debounce, EMBEDDED } from '../util.js';

const LONG_PRESS_MS = 320;

export default async function docView({ params: [docId], navigate, goBack }) {
  let doc = await store.getDoc(docId);
  if (!doc) throw new Error('문서를 찾을 수 없습니다');
  let pages = [];
  const urls = [];
  let destroyed = false;

  const grid = h('div', { class: 'page-grid' });
  const titleText = h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } });
  const titleBtn = h('button', { type: 'button', class: 'bar-title', onclick: rename, 'aria-label': '문서 이름 변경' }, titleText, icon('edit', 16));
  const syncBtn = h('button', { type: 'button', class: 'icon-btn', onclick: syncNow, 'aria-label': '클라우드에 저장' });
  const badgeSlot = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', minHeight: '22px', color: 'var(--muted)', fontSize: '14px' } });

  const el = h('div', { class: 'view' },
    h('header', { class: 'bar' },
      iconButton('back', '뒤로', () => goBack('/')),
      titleBtn,
      syncBtn,
      iconButton('more', '더보기', more)),
    h('main', { class: 'content', style: { paddingBottom: '24px' } },
      badgeSlot,
      grid,
      h('p', { class: 'hint' }, '페이지를 길게 눌러 끌면 순서를 바꿀 수 있습니다')),
    h('div', { class: 'bottombar' },
      EMBEDDED
        ? fileButton({ label: '촬영', iconName: 'camera', variant: 'icon', capture: true, onFiles: addPhotos })
        : iconButton('camera', '촬영 추가', () => navigate(`/camera?doc=${docId}`), { text: '촬영' }),
      fileButton({ label: '가져오기', iconName: 'image', variant: 'icon', multiple: true, onFiles: addPhotos }),
      iconButton('file', 'PDF 저장', () => openExportSheet(doc, pages, { format: 'pdf' }), { text: 'PDF' }),
      iconButton('download', 'JPG 저장', () => openExportSheet(doc, pages, { format: 'jpg' }), { text: 'JPG' }),
      iconButton('share', '공유', () => openExportSheet(doc, pages, { format: 'pdf' }), { text: '공유' })));

  // ---------------------------------------------------------------- rendering
  let renderSeq = 0;
  async function render() {
    const my = ++renderSeq;
    const d = await store.getDoc(docId);
    if (destroyed || my !== renderSeq) return;
    if (!d) {
      goBack('/');
      return;
    }
    doc = d;
    pages = await store.getPages(doc);
    titleText.textContent = doc.title;
    renderSync();
    const newUrls = [];
    const cards = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const thumb = await store.getBlob(p.id, 'thumb');
      cards.push(h('div', { class: 'page-card', dataset: { id: p.id }, role: 'button', tabindex: '0', 'aria-label': `${i + 1}쪽 편집` },
        thumb ? h('img', { src: objectUrl(thumb, newUrls), alt: '' }) : null,
        h('span', { class: 'page-num' }, String(i + 1))));
    }
    if (destroyed || my !== renderSeq) {
      revokeAll(newUrls);
      return;
    }
    const pending = pendingRenders();
    const addLabel = pending ? '처리 중…' : '페이지 추가';
    cards.push(EMBEDDED
      ? fileButton({ label: addLabel, iconName: 'plus', className: 'page-card add', capture: true, onFiles: addPhotos })
      : h('button', { type: 'button', class: 'page-card add', onclick: () => navigate(`/camera?doc=${docId}`) },
        pending ? h('div', { class: 'spinner small dark' }) : icon('plus', 32), addLabel));
    grid.replaceChildren(...cards);
    revokeAll(urls);
    urls.push(...newUrls);
  }

  function renderSync() {
    const prog = syncProgress(docId);
    const st = doc.sync?.state || 'local';
    let name = 'cloudUp';
    let cls = '';
    if (prog) name = 'refresh';
    else if (st === 'synced') { name = 'cloudOk'; cls = 'active'; }
    else if (st === 'error') name = 'cloudOff';
    syncBtn.replaceChildren(icon(name));
    syncBtn.firstChild.classList.toggle('spin', !!prog);
    syncBtn.className = `icon-btn ${cls}`;
    badgeSlot.replaceChildren(...[`${pages.length}쪽`, syncBadge(doc), st === 'error' ? h('span', { style: { color: 'var(--danger)', fontSize: '13px' } }, doc.sync.error || '') : null].filter(Boolean));
  }

  // ---------------------------------------------------------------- actions
  async function rename() {
    const t = await promptDialog('문서 이름', doc.title);
    if (t) await store.updateDoc(docId, { title: t });
  }

  async function syncNow() {
    if (!cloudReady()) {
      const st = await checkServer({ force: true });
      if (!st.reachable || !st.authOk) {
        toast(st.error || '클라우드 서버에 연결할 수 없습니다', { error: true });
        return;
      }
    }
    try {
      await syncDoc(docId);
      toast('클라우드에 저장했습니다');
    } catch (e) {
      toast(`업로드 실패: ${e.message}`, { error: true });
    }
  }

  async function addPhotos(files) {
    const res = await importImages(files, { docId });
    if (res && res.added.length === 1) navigate(`/doc/${docId}/crop/${res.added[0].id}`);
  }

  async function more() {
    const choice = await actionSheet(doc.title, [
      { label: '이름 변경', icon: 'edit', value: 'rename' },
      EMBEDDED ? null : { label: 'PDF 미리보기', icon: 'file', value: 'preview' },
      ocrReady() ? { label: '텍스트 추출 (OCR)', icon: 'search', value: 'ocr' } : null,
      EMBEDDED ? null : { label: '지금 클라우드에 저장', icon: 'cloudUp', value: 'sync' },
      { label: '문서 삭제', icon: 'trash', value: 'delete', danger: true },
    ]);
    if (choice === 'rename') rename();
    else if (choice === 'sync') syncNow();
    else if (choice === 'preview') previewPdf();
    else if (choice === 'ocr') extractText(doc);
    else if (choice === 'delete') removeDoc();
  }

  async function previewPdf() {
    if (!pages.length) return;
    const blob = await withBusy('PDF를 만드는 중…', () => pdfBlob(doc, pages));
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  async function removeDoc() {
    const onCloud = doc.sync?.state && doc.sync.state !== 'local';
    const ok = await confirmDialog(onCloud ? '이 문서를 이 기기와 클라우드에서 모두 삭제할까요?' : '이 문서를 삭제할까요?', { ok: '삭제', danger: true });
    if (!ok) return;
    if (onCloud && cloudReady()) {
      try {
        await api.deleteDoc(docId);
      } catch (e) {
        if (e.status !== 404) {
          toast(`클라우드 삭제 실패: ${e.message}`, { error: true });
          return;
        }
      }
    }
    await store.deleteDoc(docId);
    toast('삭제했습니다');
    goBack('/');
  }

  // ---------------------------------------------------------------- drag to reorder
  let press = null;
  let drag = null;
  let suppressClick = false;

  grid.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.page-card[data-id]');
    if (!card || (e.pointerType === 'mouse' && e.button !== 0)) return;
    press = { card, x: e.clientX, y: e.clientY, id: e.pointerId };
    press.timer = setTimeout(() => startDrag(e), LONG_PRESS_MS);
  });

  function startDrag() {
    if (!press) return;
    const { card, x, y, id } = press;
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('dragging');
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${r.left}px`, top: `${r.top}px` });
    document.body.append(ghost);
    card.classList.add('placeholder');
    drag = { card, ghost, dx: x - r.left, dy: y - r.top, id, order: pages.map((p) => p.id).join() };
    try {
      grid.setPointerCapture(id);
    } catch {
      // pointer already released
    }
    navigator.vibrate?.(15);
  }

  grid.addEventListener('pointermove', (e) => {
    if (press && !drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) {
      clearTimeout(press.timer); // it's a scroll, not a long press
      press = null;
    }
    if (!drag || e.pointerId !== drag.id) return;
    drag.ghost.style.left = `${e.clientX - drag.dx}px`;
    drag.ghost.style.top = `${e.clientY - drag.dy}px`;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.page-card[data-id]');
    if (target && target !== drag.card && target.parentElement === grid) {
      const cards = [...grid.querySelectorAll('.page-card[data-id]')];
      const from = cards.indexOf(drag.card), to = cards.indexOf(target);
      grid.insertBefore(drag.card, from < to ? target.nextSibling : target);
    }
    // Auto-scroll near the edges.
    const scroller = grid.closest('.content');
    const sr = scroller.getBoundingClientRect();
    if (e.clientY < sr.top + 50) scroller.scrollTop -= 12;
    else if (e.clientY > sr.bottom - 50) scroller.scrollTop += 12;
  });

  // While dragging, keep the browser from scrolling the page.
  grid.addEventListener('touchmove', (e) => {
    if (drag) e.preventDefault();
  }, { passive: false });

  async function endDrag(e) {
    if (press) {
      clearTimeout(press.timer);
      press = null;
    }
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const { card, ghost, order } = drag;
    drag = null;
    ghost.remove();
    card.classList.remove('placeholder');
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    const ids = [...grid.querySelectorAll('.page-card[data-id]')].map((c) => c.dataset.id);
    if (ids.join() !== order) {
      await store.updateDoc(docId, { pageIds: ids });
      toast('페이지 순서를 바꿨습니다');
    }
  }

  grid.addEventListener('pointerup', endDrag);
  grid.addEventListener('pointercancel', endDrag);

  grid.addEventListener('click', (e) => {
    if (suppressClick) return;
    const card = e.target.closest('.page-card[data-id]');
    if (card) navigate(`/doc/${docId}/page/${card.dataset.id}`);
  });
  grid.addEventListener('keydown', (e) => {
    const card = e.target.closest('.page-card[data-id]');
    if (card && e.key === 'Enter') navigate(`/doc/${docId}/page/${card.dataset.id}`);
  });
  grid.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.page-card')) e.preventDefault();
  });

  const refresh = debounce(() => { if (!drag) render(); }, 100);
  const offStore = store.onStoreChange(({ docId: id }) => { if (!id || id === docId) refresh(); });
  const offSync = onSyncProgress(({ docId: id }) => { if (id === docId) renderSync(); });

  if (EMBEDDED) syncBtn.hidden = true;
  await render();

  return {
    el,
    destroy() {
      destroyed = true;
      offStore();
      offSync();
      if (drag) drag.ghost.remove();
      revokeAll(urls);
    },
  };
}
