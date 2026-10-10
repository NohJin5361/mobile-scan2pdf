// Shared view helpers: file picking/import, sync badges, export sheet.
import { h, icon, busy, toast, sheet, segmented, toggle } from '../ui.js';
import * as store from '../store.js';
import { addPageFromBlob } from '../pages.js';
import { syncProgress, syncDoc } from '../sync.js';
import { api, cloudReady, ocrReady } from '../api.js';
import { getSettings, updateSettings } from '../settings.js';
import { PAGE_SIZES } from '../core/pdf.js';
import { QUALITY, pdfBlob, jpgFiles, zipBlob, downloadBlob, canShareFiles, shareFiles } from '../exporter.js';
import { formatBytes, safeFilename } from '../util.js';

/** Opens the system file picker. `capture` opens the camera app directly on phones. */
export function pickFiles({ multiple = true, capture = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*', multiple: multiple && !capture, class: 'sr-only' });
    if (capture) input.setAttribute('capture', 'environment');
    input.addEventListener('change', () => {
      resolve([...(input.files || [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i;

/** Takes a photo with the phone's camera app and adds it (used where live camera is unavailable). */
export async function captureWithCameraApp(docId = null, position) {
  const files = await pickFiles({ capture: true });
  if (!files.length) return null;
  return importImages(files, { docId, position });
}

/** Adds image files as pages. Creates a document when `docId` is null. */
export async function importImages(files, { docId = null, position } = {}) {
  const imgs = files.filter((f) => (f.type || '').startsWith('image/') || IMAGE_RE.test(f.name));
  if (!imgs.length) {
    if (files.length) toast('이미지 파일만 가져올 수 있습니다', { error: true });
    return null;
  }
  const doc = docId ? await store.getDoc(docId) : await store.createDoc();
  const b = busy(`가져오는 중… 0/${imgs.length}`);
  const added = [];
  let failed = 0;
  try {
    for (let i = 0; i < imgs.length; i++) {
      b.update(imgs.length > 1 ? `가져오는 중… ${i + 1}/${imgs.length}` : '문서 영역을 찾는 중…');
      try {
        added.push(await addPageFromBlob(doc.id, imgs[i], { position: position == null ? undefined : position + added.length }));
      } catch (e) {
        console.error(e);
        failed++;
      }
    }
  } finally {
    b.done();
  }
  if (failed) toast(`${failed}개 파일을 열 수 없습니다`, { error: true });
  if (!added.length && !docId) await store.deleteDoc(doc.id);
  return added.length ? { doc, added } : null;
}

/** Badge describing where a document is stored. */
export function syncBadge(doc) {
  const st = doc.sync?.state || 'local';
  const prog = syncProgress(doc.id);
  if (prog) {
    return h('span', { class: 'badge warn' }, h('span', { class: 'spinner small dark' }), prog.total ? `업로드 ${prog.done}/${prog.total}` : '업로드 중');
  }
  if (st === 'synced') return h('span', { class: 'badge ok' }, icon('cloudOk'), '클라우드');
  if (st === 'error') return h('span', { class: 'badge err', title: doc.sync?.error || '' }, icon('cloudOff'), '업로드 실패');
  if (!getSettings().autoSync || !cloudReady()) return h('span', { class: 'badge' }, '이 기기');
  return h('span', { class: 'badge warn' }, icon('cloudUp'), '업로드 대기');
}

// ------------------------------------------------------------------ export sheet

const MARGINS = [
  { value: 0, label: '없음' },
  { value: 5, label: '좁게' },
  { value: 12, label: '보통' },
];

/** Export/share dialog for a local document. */
export function openExportSheet(doc, pages, { format = 'pdf' } = {}) {
  const s = getSettings();
  const opts = {
    format,
    pageSize: s.pdfPageSize,
    marginMm: s.pdfMarginMm,
    quality: s.pdfQuality,
    name: doc.title,
    ocr: false,
  };
  return sheet('내보내기', (close) => {
    const body = h('div');
    const nameInput = h('input', { class: 'input', value: opts.name, maxlength: 120, oninput: () => { opts.name = nameInput.value; } });
    const pdfOptions = h('div', {},
      field('용지 크기', segmented([
        { value: 'auto', label: '자동' },
        ...['a4', 'letter', 'legal', 'a5', 'b5'].map((k) => ({ value: k, label: PAGE_SIZES[k].label })),
      ], opts.pageSize, (v) => { opts.pageSize = v; }, { name: '용지 크기' })),
      field('여백', segmented(MARGINS, opts.marginMm, (v) => { opts.marginMm = v; }, { name: '여백' })));
    const ocrToggle = ocrReady()
      ? toggle('검색 가능한 PDF (OCR)', false, (v) => { opts.ocr = v; render(); }, '글자를 인식해 PDF 안에서 검색·복사할 수 있게 합니다 (서버 처리)')
      : null;
    const render = () => {
      pdfOptions.style.display = opts.format === 'pdf' && !opts.ocr ? '' : 'none';
      if (ocrToggle) ocrToggle.style.display = opts.format === 'pdf' ? '' : 'none';
      shareBtn.style.display = typeof navigator.share === 'function' ? '' : 'none';
    };
    const run = async (mode) => {
      updateSettings({ pdfPageSize: opts.pageSize, pdfMarginMm: opts.marginMm, pdfQuality: opts.quality });
      const name = opts.name.trim() || doc.title;
      const b = busy('파일을 만드는 중…');
      try {
        const progress = (i, n) => b.update(`파일을 만드는 중… ${i + 1}/${n}`);
        let files;
        if (opts.format === 'pdf' && opts.ocr) {
          b.update('클라우드에 올리는 중…');
          await syncDoc(doc.id);
          b.update('글자를 인식하는 중… (페이지당 몇 초)');
          const blob = await api.exportPdf(doc.id, { ocr: 1, quality: opts.quality, pages: pages.map((p) => p.id).join(',') });
          files = [new File([blob], safeFilename(name, 'pdf'), { type: 'application/pdf' })];
        } else if (opts.format === 'pdf') {
          const blob = await pdfBlob({ ...doc, title: name }, pages, opts, progress);
          files = [new File([blob], safeFilename(name, 'pdf'), { type: 'application/pdf' })];
        } else {
          files = await jpgFiles({ ...doc, title: name }, pages, { quality: opts.quality }, progress);
        }
        b.done();
        if (mode === 'share') {
          if (!canShareFiles(files)) {
            toast('이 브라우저는 파일 공유를 지원하지 않습니다. 다운로드를 사용하세요.', { error: true });
            return;
          }
          try {
            await shareFiles(files, name);
          } catch (e) {
            if (e.name !== 'NotAllowedError') throw e;
            // Safari drops the user gesture during long work: ask for one more tap.
            close(true);
            await shareAgainSheet(files, name);
            return;
          }
        } else if (files.length === 1) {
          if (!(await downloadBlob(files[0], files[0].name))) return;
          toast(`저장됨 · ${formatBytes(files[0].size)}`);
        } else {
          const zip = await zipBlob(files);
          if (!(await downloadBlob(zip, safeFilename(name, 'zip')))) return;
          toast(`${files.length}장을 ZIP으로 저장 · ${formatBytes(zip.size)}`);
        }
        close(true);
      } catch (e) {
        console.error(e);
        toast(e.message || '내보내기 실패', { error: true });
      } finally {
        b.done();
      }
    };
    const shareBtn = h('button', { type: 'button', class: 'btn', onclick: () => run('share') }, icon('share'), '공유');
    body.append(
      field('형식', segmented([
        { value: 'pdf', label: 'PDF' },
        { value: 'jpg', label: pages.length > 1 ? `JPG (${pages.length}장)` : 'JPG' },
      ], opts.format, (v) => { opts.format = v; render(); }, { name: '형식' })),
      field('파일 이름', nameInput),
      ocrToggle,
      pdfOptions,
      field('화질', segmented(Object.entries(QUALITY).map(([value, q]) => ({ value, label: q.label })), opts.quality, (v) => { opts.quality = v; }, { name: '화질' })),
      h('p', { class: 'hint', style: { textAlign: 'left', margin: '0 2px' } }, '원본: 스캔 화질 그대로 · 저용량: 이메일/메신저 전송용'),
      h('div', { class: 'sheet-actions' },
        shareBtn,
        h('button', { type: 'button', class: 'btn primary', onclick: () => run('download') }, icon('download'), '저장')),
    );
    render();
    return body;
  });
}

/** Runs OCR for a document on the server (uploading local changes first) and shows the text. */
export async function extractText(doc, { local = true } = {}) {
  const b = busy(local ? '클라우드에 올리는 중…' : '글자를 인식하는 중…');
  let res;
  try {
    if (local) {
      await syncDoc(doc.id);
      b.update('글자를 인식하는 중… (페이지당 몇 초)');
    }
    res = await api.text(doc.id);
  } catch (e) {
    toast(`글자 인식 실패: ${e.message}`, { error: true });
    return;
  } finally {
    b.done();
  }
  openTextSheet(doc.title, res.text);
}

export function openTextSheet(title, text) {
  return sheet('인식된 텍스트', (close) => {
    const area = h('textarea', { class: 'input', readonly: true, style: { height: '46vh', padding: '10px 12px', lineHeight: '1.5', resize: 'none' } });
    area.value = text || '';
    return h('div', {},
      text ? area : h('p', { class: 'dialog-msg' }, '인식된 글자가 없습니다.'),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => {
          downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), safeFilename(title, 'txt')).catch((e) => toast(e.message, { error: true }));
        } }, icon('download'), 'TXT 저장'),
        h('button', { type: 'button', class: 'btn primary', onclick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast('복사했습니다');
          } catch {
            area.select();
            document.execCommand?.('copy');
            toast('복사했습니다');
          }
          close();
        } }, icon('copy'), '복사')));
  });
}

function shareAgainSheet(files, name) {
  const size = files.reduce((n, f) => n + f.size, 0);
  return sheet('파일이 준비되었습니다', (close) => h('div', { class: 'dialog' },
    h('p', { class: 'dialog-msg' }, `${files.length}개 파일 · ${formatBytes(size)}`),
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, '닫기'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => shareFiles(files, name).then(() => close(), (e) => toast(e.message, { error: true })) }, icon('share'), '공유'))));
}

export function field(label, control) {
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
}

/** Full-screen image viewer. `onClose` runs once when it is dismissed. */
export function openViewer(title, url, actions = [], onClose = () => {}) {
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    el.remove();
    document.removeEventListener('keydown', onKey);
    onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const el = h('div', { class: 'viewer', role: 'dialog', 'aria-label': title },
    h('div', { class: 'bar' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫기', onclick: close }, icon('close')),
      h('div', { class: 'bar-title' }, title),
      ...actions.map((a) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': a.label, title: a.label, onclick: a.onClick }, icon(a.icon)))),
    h('div', { class: 'viewer-img', onclick: (e) => { if (e.target === e.currentTarget) close(); } }, h('img', { src: url, alt: title })));
  document.addEventListener('keydown', onKey);
  document.body.append(el);
  return close;
}
