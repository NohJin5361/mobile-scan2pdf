// App bootstrap and hash router.
import { toast } from './ui.js';
import { requestPersistence, initStorage } from './store.js';
import { checkServer } from './api.js';
import { startAutoSync, syncAllPending } from './sync.js';
import { warmUp } from './processor.js';
import { EMBEDDED } from './util.js';

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

// Embedded pages cannot rely on the URL, so routes live in memory there.
const memStack = ['/'];

function parseHash() {
  const raw = EMBEDDED ? memStack[memStack.length - 1] : location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: new URLSearchParams(qs) };
}

const depth = () => (history.state && history.state.depth) || 0;

/** Navigates to a route. `replace` swaps the current history entry. */
export function navigate(path, { replace = false } = {}) {
  if (EMBEDDED) {
    if (replace) memStack[memStack.length - 1] = path;
    else memStack.push(path);
    render();
    return;
  }
  const url = `#${path}`;
  if (replace) history.replaceState({ depth: depth() }, '', url);
  else history.pushState({ depth: depth() + 1 }, '', url);
  render();
}

/** Goes back if there is in-app history, otherwise to `fallback`. */
export function goBack(fallback = '/') {
  if (EMBEDDED) {
    if (memStack.length > 1) {
      memStack.pop();
      render();
    } else navigate(fallback, { replace: true });
    return;
  }
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

// Surface unexpected failures on screen so problems on a phone can be reported.
function showErrors() {
  let last = '';
  const report = (msg) => {
    if (!msg || msg === last) return;
    last = msg;
    toast(`오류: ${msg}`, { error: true, duration: 7000 });
  };
  window.addEventListener('error', (e) => report(e.message));
  window.addEventListener('unhandledrejection', (e) => report(e.reason?.message || String(e.reason || '')));
}

async function boot() {
  if (!EMBEDDED && !history.state) history.replaceState({ depth: 0 }, '', location.href);
  showErrors();
  if (await initStorage()) {
    setTimeout(() => toast('이 화면에서는 기기 저장소를 쓸 수 없어 문서가 임시로만 보관됩니다. 창을 닫기 전에 PDF/JPG로 저장하세요.', { duration: 7000 }), 600);
  }
  warmUp();
  requestPersistence();
  if (!EMBEDDED) {
    registerServiceWorker();
    startAutoSync();
    checkServer().then((st) => {
      if (st.reachable && st.authOk) syncAllPending();
    });
  }
  render();
}

boot();
