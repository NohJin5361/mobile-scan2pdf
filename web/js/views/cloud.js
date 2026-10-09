// A document stored on the server: preview, download PDF/ZIP, import for editing, delete.
import { h, icon, iconButton, toast, sheet, segmented, confirmDialog, promptDialog, busy, revokeAll, objectUrl, actionSheet } from '../ui.js';
import * as store from '../store.js';
import { api, checkServer } from '../api.js';
import { pullDoc } from '../sync.js';
import { downloadBlob, canShareFiles, shareFiles, QUALITY } from '../exporter.js';
import { PAGE_SIZES } from '../core/pdf.js';
import { field, openViewer } from './common.js';
import { getSettings, updateSettings } from '../settings.js';
import { formatBytes, formatDate, safeFilename } from '../util.js';

export default async function cloudView({ params: [docId], navigate, goBack }) {
  const st = await checkServer();
  if (!st.reachable || !st.authOk) throw new Error(st.error || '클라우드 서버에 연결할 수 없습니다');
  let remote = await api.getDoc(docId);
  const urls = [];
  let destroyed = false;
  let closeViewer = null;

  const title = h('div', { class: 'bar-title' });
  const meta = h('div', { class: 'notice' });
  const grid = h('div', { class: 'page-grid' });

  const el = h('div', { class: 'view' },
    h('header', { class: 'bar' },
      iconButton('back', '뒤로', () => goBack('/')),
      title,
      iconButton('more', '더보기', more)),
    h('main', { class: 'content', style: { paddingBottom: '24px' } }, meta, grid),
    h('div', { class: 'bottombar' },
      iconButton('file', 'PDF 다운로드', exportPdf, { text: 'PDF' }),
      iconButton('download', '이미지 ZIP 다운로드', exportZip, { text: 'JPG(ZIP)' }),
      iconButton('edit', '이 기기로 가져와 편집', edit, { text: '편집' }),
      iconButton('trash', '삭제', remove, { text: '삭제' })));

  function render() {
    title.textContent = remote.title || '(제목 없음)';
    meta.textContent = `클라우드 문서 · ${remote.page_count}쪽 · ${formatBytes(remote.size)} · ${formatDate(Date.parse(remote.updated_at))}`;
    revokeAll(urls);
    grid.replaceChildren(...remote.pages.map((p, i) => {
      const img = h('img', { alt: '' });
      api.pageImage(docId, p.id, 'thumb').then((b) => {
        if (!destroyed) img.src = objectUrl(b, urls);
      }).catch(() => {});
      return h('div', { class: 'page-card', role: 'button', tabindex: '0', 'aria-label': `${i + 1}쪽 보기`, onclick: () => view(p, i) }, img, h('span', { class: 'page-num' }, String(i + 1)));
    }));
  }

  async function view(p, i) {
    const b = busy('불러오는 중…');
    let blob;
    try {
      blob = await api.pageImage(docId, p.id, 'processed');
    } catch (e) {
      toast(e.message, { error: true });
      return;
    } finally {
      b.done();
    }
    const url = URL.createObjectURL(blob);
    const name = safeFilename(`${remote.title}_${String(i + 1).padStart(2, '0')}`, 'jpg');
    closeViewer = openViewer(`${i + 1}쪽`, url, [{ icon: 'download', label: 'JPG 저장', onClick: () => downloadBlob(blob, name) }], () => {
      URL.revokeObjectURL(url);
      closeViewer = null;
    });
  }

  async function deliver(blob, filename, type) {
    const file = new File([blob], filename, { type });
    if (canShareFiles([file]) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
      const choice = await actionSheet(`${filename} · ${formatBytes(blob.size)}`, [
        { label: '기기에 저장', icon: 'download', value: 'save' },
        { label: '공유', icon: 'share', value: 'share' },
      ]);
      if (choice === 'share') {
        await shareFiles([file], remote.title).catch((e) => toast(e.message, { error: true }));
        return;
      }
      if (choice !== 'save') return;
    }
    downloadBlob(blob, filename);
    toast(`저장됨 · ${formatBytes(blob.size)}`);
  }

  function exportPdf() {
    const s = getSettings();
    const opts = { page_size: s.pdfPageSize, margin: s.pdfMarginMm, quality: s.pdfQuality };
    sheet('PDF 다운로드', (close) => h('div', {},
      field('용지 크기', segmented([{ value: 'auto', label: '자동' }, ...['a4', 'letter', 'legal', 'a5', 'b5'].map((k) => ({ value: k, label: PAGE_SIZES[k].label }))], opts.page_size, (v) => { opts.page_size = v; })),
      field('여백', segmented([{ value: 0, label: '없음' }, { value: 5, label: '좁게' }, { value: 12, label: '보통' }], opts.margin, (v) => { opts.margin = v; })),
      field('화질', segmented(Object.entries(QUALITY).map(([value, q]) => ({ value, label: q.label })), opts.quality, (v) => { opts.quality = v; })),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => close() }, '취소'),
        h('button', { type: 'button', class: 'btn primary', onclick: async () => {
          close();
          updateSettings({ pdfPageSize: opts.page_size, pdfMarginMm: opts.margin, pdfQuality: opts.quality });
          const b = busy('서버에서 PDF를 만드는 중…');
          try {
            const blob = await api.exportPdf(docId, opts);
            b.done();
            await deliver(blob, safeFilename(remote.title, 'pdf'), 'application/pdf');
          } catch (e) {
            toast(e.message, { error: true });
          } finally {
            b.done();
          }
        } }, icon('download'), '다운로드'))));
  }

  async function exportZip() {
    const b = busy('이미지를 묶는 중…');
    try {
      const blob = await api.exportZip(docId);
      b.done();
      await deliver(blob, safeFilename(remote.title, 'zip'), 'application/zip');
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      b.done();
    }
  }

  async function edit() {
    const local = await store.getDoc(docId);
    if (local && local.sync?.state === 'synced') {
      navigate(`/doc/${docId}`, { replace: true });
      return;
    }
    if (local && !(await confirmDialog('이 기기에 있는 사본을 클라우드 버전으로 바꿀까요?\n이 기기에서 업로드하지 않은 변경 사항은 사라집니다.', { ok: '바꾸기', danger: true }))) {
      return;
    }
    const b = busy('기기로 가져오는 중…');
    try {
      await pullDoc(docId, (i, n) => b.update(`기기로 가져오는 중… ${i}/${n}`));
    } catch (e) {
      toast(`가져오기 실패: ${e.message}`, { error: true });
      return;
    } finally {
      b.done();
    }
    navigate(`/doc/${docId}`, { replace: true });
  }

  async function remove() {
    if (!(await confirmDialog(`‘${remote.title}’을(를) 클라우드에서 삭제할까요?\n이 기기에 있는 사본은 그대로 남습니다.`, { ok: '삭제', danger: true }))) return;
    try {
      await api.deleteDoc(docId);
    } catch (e) {
      toast(e.message, { error: true });
      return;
    }
    if (await store.getDoc(docId)) await store.setSyncState(docId, { state: 'local' });
    toast('클라우드에서 삭제했습니다');
    goBack('/');
  }

  async function more() {
    const choice = await actionSheet(remote.title, [
      { label: '이름 변경', icon: 'edit', value: 'rename' },
      { label: '삭제', icon: 'trash', value: 'delete', danger: true },
    ]);
    if (choice === 'rename') {
      const t = await promptDialog('문서 이름', remote.title);
      if (!t) return;
      try {
        remote = await api.patchDoc(docId, { title: t });
        if (await store.getDoc(docId)) await store.updateDoc(docId, { title: t }, { dirty: false });
        render();
      } catch (e) {
        toast(e.message, { error: true });
      }
    } else if (choice === 'delete') remove();
  }

  render();

  return {
    el,
    destroy() {
      destroyed = true;
      closeViewer?.();
      revokeAll(urls);
    },
  };
}
