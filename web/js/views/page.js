// Page editor: filters, rotation, brightness/contrast, retake, duplicate, delete.
import { h, icon, iconButton, toast, actionSheet, confirmDialog, revokeAll, objectUrl } from '../ui.js';
import * as store from '../store.js';
import { run } from '../processor.js';
import { loadOriginal, updatePage, duplicatePage, DEFAULT_ADJUST } from '../pages.js';
import { drawToImageData } from '../imageio.js';
import { FILTERS } from '../core/enhance.js';
import { getSettings, updateSettings } from '../settings.js';
import { openViewer } from './common.js';

const PREVIEW_DIM = 1400;

export default async function pageView({ params: [docId, pageId], query, navigate, goBack }) {
  const doc = await store.getDoc(docId);
  if (!doc) throw new Error('문서를 찾을 수 없습니다');
  let pages = await store.getPages(doc);
  let index = pages.findIndex((p) => p.id === pageId);
  if (index < 0) throw new Error('페이지를 찾을 수 없습니다');
  const from = query.get('from');
  const urls = [];
  let page = null;
  let state = null;
  let dirty = false;
  let key = null;
  let previewSeq = 0;
  let thumbSeq = 0;
  let destroyed = false;

  // ---------------------------------------------------------------- DOM
  const img = h('img', { alt: '스캔 미리보기' });
  const preview = h('canvas', { style: { display: 'none' } });
  const spinner = h('div', { class: 'stage-busy' }, h('div', { class: 'spinner small' }));
  const prevBtn = iconButton('left', '이전 페이지', () => go(index - 1), { class: 'stage-nav prev' });
  const nextBtn = iconButton('right', '다음 페이지', () => go(index + 1), { class: 'stage-nav next' });
  const stage = h('div', { class: 'stage', style: { touchAction: 'pan-y' } }, h('div', { class: 'preview-wrap' }, img, preview), prevBtn, nextBtn, spinner);
  const title = h('div', { class: 'bar-title', style: { textAlign: 'center' } });

  const filterButtons = new Map();
  const filterStrip = h('div', { class: 'filter-strip', role: 'radiogroup', 'aria-label': '필터' },
    FILTERS.map((f) => {
      const c = h('canvas', { width: 64, height: 84 });
      const b = h('button', { type: 'button', class: 'filter-item', role: 'radio', onclick: () => setFilter(f.id) }, c, f.label);
      filterButtons.set(f.id, { button: b, canvas: c });
      return b;
    }));

  const bright = slider('밝기', 'brightness');
  const contrast = slider('대비', 'contrast');
  const adjustPanel = h('div', { class: 'adjust-panel' }, bright.row, contrast.row,
    h('div', { style: { textAlign: 'right' } }, h('button', { type: 'button', class: 'btn small', style: { background: '#23262d', color: '#fff', borderColor: '#2e323b' }, onclick: resetAdjust }, '초기화')));
  const adjustBtn = iconButton('sun', '밝기/대비', () => {
    adjustPanel.classList.toggle('show');
    adjustBtn.classList.toggle('active', adjustPanel.classList.contains('show'));
  }, { text: '조정' });

  const el = h('div', { class: 'view editor' },
    h('header', { class: 'bar' },
      iconButton('back', '뒤로', done),
      title,
      iconButton('more', '더보기', more)),
    stage,
    filterStrip,
    adjustPanel,
    h('div', { class: 'editor-actions' },
      h('button', { type: 'button', class: 'btn', onclick: applyToAll }, icon('layers'), '모든 페이지에 적용'),
      h('button', { type: 'button', class: 'btn primary', onclick: done }, icon('check'), '완료')),
    h('div', { class: 'bottombar' },
      iconButton('crop', '자르기', crop, { text: '자르기' }),
      iconButton('rotl', '왼쪽으로 회전', () => rotate(-90), { text: '왼쪽' }),
      iconButton('rotr', '오른쪽으로 회전', () => rotate(90), { text: '오른쪽' }),
      adjustBtn,
      iconButton('camera', '다시 찍기', retake, { text: '다시 찍기' }),
      iconButton('trash', '삭제', remove, { text: '삭제' })));

  function slider(label, prop) {
    const out = h('output', {}, '0');
    const input = h('input', { type: 'range', min: -100, max: 100, step: 1, value: 0, 'aria-label': label });
    input.addEventListener('input', () => {
      state.adjust = { ...state.adjust, [prop]: Number(input.value) };
      out.textContent = input.value;
      dirty = true;
      schedulePreview();
    });
    return { row: h('div', { class: 'adjust-row' }, h('label', {}, label), input, out), input, out };
  }

  // ---------------------------------------------------------------- page loading
  async function show(i) {
    index = i;
    page = pages[index];
    state = { filter: page.filter, rotation: page.rotation || 0, adjust: { ...DEFAULT_ADJUST, ...(page.adjust || {}) } };
    dirty = false;
    title.textContent = `${index + 1} / ${pages.length}`;
    prevBtn.hidden = index === 0;
    nextBtn.hidden = index === pages.length - 1;
    for (const [s, ctl] of [['brightness', bright], ['contrast', contrast]]) {
      ctl.input.value = String(state.adjust[s] || 0);
      ctl.out.textContent = ctl.input.value;
    }
    markFilter();
    revokeAll(urls);
    const blob = await store.getBlob(page.id, 'processed');
    if (blob) img.src = objectUrl(blob, urls);
    img.style.display = '';
    preview.style.display = 'none';
    prepare(page).catch((e) => console.warn(e));
  }

  async function prepare(p) {
    const k = `pv:${p.id}:${p.version}`;
    if (key === k) return;
    key = null;
    spinner.classList.add('show');
    try {
      const loaded = await loadOriginal(p);
      const s = getSettings();
      const src = drawToImageData(loaded.source, loaded.width, loaded.height, 2000);
      await run('warp', {
        image: src,
        corners: p.corners.map(([x, y]) => [x * src.width, y * src.height]),
        maxDim: PREVIEW_DIM,
        snap: s.snapPaper,
        key: k,
        thumbDim: 168,
      }, [src.data.buffer]);
      if (destroyed || page.id !== p.id) return;
      key = k;
      renderThumbs();
      if (dirty) renderPreview();
    } finally {
      spinner.classList.remove('show');
    }
  }

  async function renderThumbs() {
    if (!key) return;
    const my = ++thumbSeq;
    const res = await run('filterPreviews', { imageKey: `${key}:small`, filters: FILTERS.map((f) => f.id), rotation: state.rotation, adjust: {} });
    if (my !== thumbSeq || destroyed) return;
    FILTERS.forEach((f, i) => {
      const out = res[i];
      const c = filterButtons.get(f.id).canvas;
      c.width = out.width;
      c.height = out.height;
      c.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    });
  }

  let previewQueued = false;
  function schedulePreview() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      renderPreview();
    });
  }

  async function renderPreview() {
    if (!key) return; // prepare() will render once ready
    const my = ++previewSeq;
    spinner.classList.add('show');
    try {
      const out = await run('preview', { imageKey: key, filter: state.filter, adjust: state.adjust, rotation: state.rotation });
      if (my !== previewSeq || destroyed) return;
      preview.width = out.width;
      preview.height = out.height;
      preview.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
      preview.style.display = '';
      img.style.display = 'none';
    } finally {
      if (my === previewSeq) spinner.classList.remove('show');
    }
  }

  function markFilter() {
    for (const [id, { button }] of filterButtons) {
      button.classList.toggle('active', id === state.filter);
      button.setAttribute('aria-checked', String(id === state.filter));
    }
  }

  // ---------------------------------------------------------------- edits
  function setFilter(id) {
    if (state.filter === id) return;
    state.filter = id;
    dirty = true;
    markFilter();
    renderPreview();
    updateSettings({ defaultFilter: id }); // remember the last choice for new scans
  }

  function rotate(deg) {
    state.rotation = (((state.rotation + deg) % 360) + 360) % 360;
    dirty = true;
    renderPreview();
    renderThumbs();
  }

  function resetAdjust() {
    state.adjust = { ...DEFAULT_ADJUST };
    bright.input.value = contrast.input.value = '0';
    bright.out.textContent = contrast.out.textContent = '0';
    dirty = true;
    renderPreview();
  }

  /** Saves pending edits; the full-resolution render runs in the background queue. */
  function commit() {
    if (!dirty || !page) return Promise.resolve();
    dirty = false;
    const p = page;
    const patch = { filter: state.filter, rotation: state.rotation, adjust: { ...state.adjust } };
    Object.assign(p, patch);
    return updatePage(p.id, patch).catch((e) => toast(`저장 실패: ${e.message}`, { error: true }));
  }

  async function go(i) {
    if (i < 0 || i >= pages.length || i === index) return;
    commit();
    await show(i);
  }

  function done() {
    commit();
    if (from === 'capture') navigate(`/doc/${docId}`, { replace: true });
    else goBack(`/doc/${docId}`);
  }

  function crop() {
    commit();
    navigate(`/doc/${docId}/crop/${page.id}`);
  }

  function retake() {
    commit();
    navigate(`/camera?doc=${docId}&retake=${page.id}`);
  }

  async function applyToAll() {
    commit();
    const others = pages.filter((p) => p.id !== page.id && (p.filter !== state.filter || JSON.stringify(p.adjust || DEFAULT_ADJUST) !== JSON.stringify(state.adjust)));
    for (const p of others) {
      p.filter = state.filter;
      p.adjust = { ...state.adjust };
      updatePage(p.id, { filter: state.filter, adjust: { ...state.adjust } }).catch((e) => toast(e.message, { error: true }));
    }
    toast(others.length ? `${others.length}개 페이지에 적용하는 중…` : '모든 페이지에 이미 적용되어 있습니다');
  }

  async function remove() {
    if (!(await confirmDialog('이 페이지를 삭제할까요?', { ok: '삭제', danger: true }))) return;
    dirty = false;
    await store.deletePage(docId, page.id);
    pages.splice(index, 1);
    if (!pages.length) {
      navigate(`/doc/${docId}`, { replace: true });
      return;
    }
    key = null;
    await show(Math.min(index, pages.length - 1));
  }

  async function more() {
    const choice = await actionSheet('페이지', [
      { label: '원본 사진 보기', icon: 'image', value: 'original' },
      index > 0 ? { label: '앞으로 이동', icon: 'left', value: 'earlier' } : null,
      index < pages.length - 1 ? { label: '뒤로 이동', icon: 'right', value: 'later' } : null,
      { label: '페이지 복제', icon: 'copy', value: 'dup' },
      { label: '다시 찍기', icon: 'camera', value: 'retake' },
      { label: '삭제', icon: 'trash', value: 'delete', danger: true },
    ]);
    if (choice === 'original') {
      const blob = await store.getBlob(page.id, 'original');
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      closeViewer = openViewer('원본 사진', url, [], () => {
        URL.revokeObjectURL(url);
        closeViewer = null;
      });
    } else if (choice === 'earlier' || choice === 'later') {
      const to = index + (choice === 'earlier' ? -1 : 1);
      const ids = pages.map((p) => p.id);
      [ids[index], ids[to]] = [ids[to], ids[index]];
      await store.updateDoc(docId, { pageIds: ids });
      [pages[index], pages[to]] = [pages[to], pages[index]];
      index = to;
      title.textContent = `${index + 1} / ${pages.length}`;
      prevBtn.hidden = index === 0;
      nextBtn.hidden = index === pages.length - 1;
      toast(`${index + 1}번째로 옮겼습니다`);
    } else if (choice === 'dup') {
      await commit();
      const copy = await duplicatePage(page.id);
      pages = await store.getPages(await store.getDoc(docId));
      await show(pages.findIndex((p) => p.id === copy.id));
      toast('페이지를 복제했습니다');
    } else if (choice === 'retake') retake();
    else if (choice === 'delete') remove();
  }

  // ---------------------------------------------------------------- gestures
  let touch = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    touch = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!touch) return;
    const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 90) go(index + (dx < 0 ? 1 : -1));
  });
  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') go(index - 1);
    else if (e.key === 'ArrowRight') go(index + 1);
  };
  document.addEventListener('keydown', onKey);

  let closeViewer = null;
  await show(index);

  return {
    el,
    destroy() {
      destroyed = true;
      commit();
      document.removeEventListener('keydown', onKey);
      closeViewer?.();
      revokeAll(urls);
      run('forget', { prefix: 'pv:' }).catch(() => {});
    },
  };
}
