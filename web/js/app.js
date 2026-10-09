// App bootstrap and hash router.
import { h, toast } from './ui.js';
import { requestPersistence } from './store.js';
import { checkServer } from './api.js';
import { startAutoSync, syncAllPending } from './sync.js';
import { warmUp } from './processor.js';

import homeView from './views/home.js';
import cameraView from './views/camera.js';
import docView from './views/doc.js';
import cropView from './views/crop.js';
import pageView from './views/page.js';
import cloudView from './views/cloud.js';
import settingsView from './views/settings.js';

const routes = [
  [/^\/?$/, homeView],
  [/^\/camera$/, cameraView],
  [/^\/doc\/([^/]+)$/, docView],
  [/^\/doc\/([^/]+)\/crop\/([^/]+)$/, cropView],
  [/^\/doc\/([^/]+)\/page\/([^/]+)$/, pageView],
  [/^\/cloud\/([^/]+)$/, cloudView],
  [/^\/settings$/, settingsView],
];

const root = document.getElementById('app');
let current = null;
let renderSeq = 0;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: new URLSearchParams(qs) };
}

const depth = () => (history.state && history.state.depth) || 0;

/** Navigates to a route. `replace` swaps the current history entry. */
export function navigate(path, { replace = false } = {}) {
  const url = `#${path}`;
  if (replace) history.replaceState({ depth: depth() }, '', url);
  else history.pushState({ depth: depth() + 1 }, '', url);
  render();
}

/** Goes back if there is in-app history, otherwise to `fallback`. */
export function goBack(fallback = '/') {
  if (depth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

async function render() {
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  let match = null;
  let viewFn = null;
  for (const [re, fn] of routes) {
    match = path.match(re);
    if (match) {
      viewFn = fn;
      break;
    }
  }
  if (!viewFn) {
    navigate('/', { replace: true });
    return;
  }
  if (current?.destroy) {
    try {
      current.destroy();
    } catch (e) {
      console.error(e);
    }
  }
  current = null;
  let view;
  try {
    view = await viewFn({ params: match.slice(1).map(decodeURIComponent), query, navigate, goBack });
  } catch (e) {
    console.error(e);
    if (seq !== renderSeq) return;
    toast(e.message || '화면을 열 수 없습니다', { error: true });
    if (path !== '/') navigate('/', { replace: true });
    return;
  }
  if (seq !== renderSeq) {
    view?.destroy?.();
    return;
  }
  current = view;
  root.replaceChildren(view.el);
  view.mounted?.();
}

window.addEventListener('popstate', render);

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}

function boot() {
  if (!history.state) history.replaceState({ depth: 0 }, '', location.href);
  if (!window.indexedDB) {
    root.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, '이 브라우저는 저장 기능(IndexedDB)을 지원하지 않습니다.'), '최신 Chrome, Safari, Samsung Internet, Firefox를 사용해 주세요.'));
    return;
  }
  warmUp();
  requestPersistence();
  registerServiceWorker();
  startAutoSync();
  checkServer().then((st) => {
    if (st.reachable && st.authOk) syncAllPending();
  });
  render();
}

boot();
