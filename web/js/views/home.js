// Home: local documents and cloud documents.
import { h, icon, iconButton, toast, actionSheet, confirmDialog, promptDialog, revokeAll, objectUrl } from '../ui.js';
import * as store from '../store.js';
import { api, checkServer, serverStatus, onServerStatus, cloudReady } from '../api.js';
import { onSyncProgress, syncDoc } from '../sync.js';
import { pickFiles, importImages, syncBadge, openExportSheet, captureWithCameraApp } from './common.js';
import { formatDate, formatBytes, debounce, EMBEDDED } from '../util.js';

let lastTab = 'local';

export default async function homeView({ navigate }) {
  const urls = [];
  let tab = lastTab;
  let query = '';
  let cloudDocs = null;
  let cloudError = '';

  const list = h('div', { class: 'doc-list' });
  const searchInput = h('input', { type: 'search', placeholder: '문서 이름 검색', 'aria-label': '문서 검색', oninput: debounce(() => { query = searchInput.value.trim(); renderList(); }, 150) });
  const tabLocal = h('button', { type: 'button', class: 'tab', onclick: () => setTab('local') });
  const tabCloud = h('button', { type: 'button', class: 'tab', onclick: () => setTab('cloud') });
  const cloudNotice = h('div');

  function setTab(t) {
    tab = lastTab = t;
    renderList();
    if (t === 'cloud') loadCloud();
  }

  async function loadCloud() {
    cloudError = '';
    if (EMBEDDED) {
      cloudDocs = null;
      cloudError = '체험 페이지에서는 클라우드 저장이 꺼져 있습니다. 스캔한 문서는 이 휴대폰에 저장되고, PDF/JPG로 내보낼 수 있습니다.';
      renderList();
      return;
    }
    const st = await checkServer();
    if (!st.reachable || !st.authOk) {
      cloudDocs = null;
      cloudError = st.reachable ? st.error : '클라우드 서버에 연결할 수 없습니다.';
      renderList();
      return;
    }
    try {
      cloudDocs = (await api.listDocs()).items;
    } catch (e) {
      cloudError = e.message;
    }
    renderList();
  }

  const matches = (title) => !query || title.toLowerCase().includes(query.toLowerCase());

  let seq = 0;
  let cardUrls = [];
  // Renders may overlap (store/sync events): only the latest one touches the DOM, and
  // object URLs of the previous render are released after the swap.
  function show(nodes, newUrls) {
    list.replaceChildren(...nodes);
    revokeAll(urls);
    urls.push(...newUrls);
  }

  async function renderList() {
    const my = ++seq;
    cardUrls = [];
    const newUrls = cardUrls;
    tabLocal.classList.toggle('active', tab === 'local');
    tabCloud.classList.toggle('active', tab === 'cloud');
    const docs = await store.listDocs();
    if (my !== seq) return;
    tabLocal.textContent = `이 기기 (${docs.length})`;
    tabCloud.textContent = cloudDocs ? `클라우드 (${cloudDocs.length})` : '클라우드';
    cloudNotice.replaceChildren();
    if (tab === 'local') {
      const shown = docs.filter((d) => matches(d.title));
      if (!docs.length) {
        show([h('div', { class: 'empty' }, icon('scan'), h('h3', {}, '스캔한 문서가 없습니다'),
          h('p', {}, '아래 ‘스캔’ 버튼으로 문서를 촬영하거나 ‘가져오기’로 사진을 불러오세요.'))], newUrls);
        return;
      }
      const cards = [];
      for (const d of shown) cards.push(await localCard(d, newUrls));
      if (my !== seq) {
        revokeAll(newUrls);
        return;
      }
      show(cards.length ? cards : [h('div', { class: 'empty' }, '검색 결과가 없습니다')], newUrls);
    } else {
      if (cloudError || !cloudDocs) {
        show([h('div', { class: 'notice' }, cloudError || '불러오는 중…',
          cloudError && !EMBEDDED ? h('div', { style: { marginTop: '10px' } }, h('button', { type: 'button', class: 'btn small', onclick: () => navigate('/settings') }, icon('gear'), '서버 설정')) : null)], newUrls);
        return;
      }
      const local = new Map(docs.map((d) => [d.id, d]));
      const shown = cloudDocs.filter((d) => matches(d.title));
      if (!shown.length) {
        show([h('div', { class: 'empty' }, icon('cloud'), h('h3', {}, query ? '검색 결과가 없습니다' : '클라우드에 저장된 문서가 없습니다'))], newUrls);
        return;
      }
      show(shown.map((d) => cloudCard(d, local.get(d.id), newUrls)), newUrls);
    }
  }

  async function localCard(doc, newUrls) {
    const cover = doc.pageIds[0] ? await store.getBlob(doc.pageIds[0], 'thumb') : null;
    const thumb = h('div', { class: 'doc-thumb', style: cover ? { backgroundImage: `url(${objectUrl(cover, newUrls)})` } : {} });
    return h('div', { class: 'doc-card', role: 'button', tabindex: '0', onclick: () => navigate(`/doc/${doc.id}`), onkeydown: (e) => { if (e.key === 'Enter') navigate(`/doc/${doc.id}`); } },
      thumb,
      h('div', { class: 'doc-info' },
        h('div', { class: 'doc-title' }, doc.title),
        h('div', { class: 'doc-meta' }, `${doc.pageIds.length}쪽 · ${formatDate(doc.updatedAt)}`, syncBadge(doc))),
      iconButton('more', '더보기', (e) => { e.stopPropagation(); docMenu(doc); }));
  }

  function cloudCard(d, local, newUrls) {
    const thumb = h('div', { class: 'doc-thumb' });
    if (d.cover) {
      api.pageImage(d.id, d.cover.page_id, 'thumb').then((b) => {
        if (newUrls !== cardUrls) return; // a newer render replaced this card
        thumb.style.backgroundImage = `url(${objectUrl(b, urls)})`;
      }).catch(() => {});
    }
    return h('div', { class: 'doc-card', role: 'button', tabindex: '0', onclick: () => navigate(`/cloud/${d.id}`), onkeydown: (e) => { if (e.key === 'Enter') navigate(`/cloud/${d.id}`); } },
      thumb,
      h('div', { class: 'doc-info' },
        h('div', { class: 'doc-title' }, d.title || '(제목 없음)'),
        h('div', { class: 'doc-meta' }, `${d.page_count}쪽 · ${formatBytes(d.size)} · ${formatDate(Date.parse(d.updated_at))}`,
          local ? h('span', { class: 'badge ok' }, '이 기기에도 있음') : null)));
  }

  async function docMenu(doc) {
    const choice = await actionSheet(doc.title, [
      { label: 'PDF로 저장 / 공유', icon: 'file', value: 'export' },
      { label: '이름 변경', icon: 'edit', value: 'rename' },
      cloudReady() ? { label: '지금 클라우드에 저장', icon: 'cloudUp', value: 'sync' } : null,
      doc.sync?.state === 'synced' ? { label: '이 기기에서만 삭제 (클라우드 유지)', icon: 'trash', value: 'removeLocal' } : null,
      { label: '삭제', icon: 'trash', value: 'delete', danger: true },
    ]);
    if (choice === 'export') {
      openExportSheet(doc, await store.getPages(doc));
    } else if (choice === 'rename') {
      const t = await promptDialog('문서 이름', doc.title);
      if (t) await store.updateDoc(doc.id, { title: t });
    } else if (choice === 'sync') {
      syncDoc(doc.id).then(() => toast('클라우드에 저장했습니다'), (e) => toast(e.message, { error: true }));
    } else if (choice === 'removeLocal') {
      if (await confirmDialog('이 기기의 사본만 삭제합니다.\n클라우드 탭에서 언제든 다시 받을 수 있습니다.', { ok: '삭제', danger: true })) {
        await store.deleteDoc(doc.id);
      }
    } else if (choice === 'delete') {
      const synced = doc.sync?.state && doc.sync.state !== 'local';
      if (!(await confirmDialog(synced ? `‘${doc.title}’을(를) 이 기기와 클라우드에서 모두 삭제할까요?` : `‘${doc.title}’을(를) 삭제할까요?`, { ok: '삭제', danger: true }))) return;
      if (synced && cloudReady()) {
        try {
          await api.deleteDoc(doc.id);
        } catch (e) {
          if (e.status !== 404) {
            toast(`클라우드 삭제 실패: ${e.message}`, { error: true });
            return;
          }
        }
      }
      await store.deleteDoc(doc.id);
      if (cloudDocs) cloudDocs = cloudDocs.filter((d) => d.id !== doc.id);
      toast('삭제했습니다');
    }
  }

  async function importFromGallery() {
    const files = await pickFiles({ multiple: true });
    if (!files.length) return;
    const res = await importImages(files);
    if (!res) return;
    if (res.added.length === 1) navigate(`/doc/${res.doc.id}/crop/${res.added[0].id}?next=page`);
    else navigate(`/doc/${res.doc.id}`);
  }

  async function scan() {
    if (!EMBEDDED) {
      navigate('/camera?doc=new');
      return;
    }
    const res = await captureWithCameraApp();
    if (res) navigate(`/doc/${res.doc.id}/crop/${res.added[0].id}?next=page`);
  }

  const offStore = store.onStoreChange(debounce(renderList, 120));
  const offSync = onSyncProgress(debounce(renderList, 200));
  const offServer = onServerStatus(() => renderList());

  const el = h('div', { class: 'view' },
    h('header', { class: 'bar' },
      h('div', { class: 'bar-title' }, 'Scan2PDF'),
      iconButton('refresh', '새로고침', () => { checkServer({ force: true }); if (tab === 'cloud') loadCloud(); else renderList(); }),
      iconButton('gear', '설정', () => navigate('/settings'))),
    h('main', { class: 'content' },
      h('label', { class: 'search' }, icon('search', 20), searchInput),
      h('div', { class: 'tabs', role: 'tablist' }, tabLocal, tabCloud),
      cloudNotice,
      list),
    h('div', { class: 'fab-row' },
      h('button', { type: 'button', class: 'fab secondary', onclick: importFromGallery }, icon('image'), '가져오기'),
      h('button', { type: 'button', class: 'fab', onclick: scan }, icon('camera'), '스캔')));

  await renderList();
  if (tab === 'cloud') loadCloud();
  else if (!serverStatus().checked && !EMBEDDED) checkServer();

  return {
    el,
    destroy() {
      offStore();
      offSync();
      offServer();
      revokeAll(urls);
    },
  };
}
