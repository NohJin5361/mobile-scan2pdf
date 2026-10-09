// Upload local documents to the server and download server documents for editing.
import * as store from './store.js';
import { api, checkServer, cloudReady } from './api.js';
import { getSettings } from './settings.js';
import { FULL_QUAD, DEFAULT_ADJUST, whenIdle } from './pages.js';
import { Emitter } from './util.js';

const bus = new Emitter();
const running = new Map(); // docId -> promise
const again = new Set();
const activity = new Map(); // docId -> { done, total }

export const onSyncProgress = (fn) => bus.on('progress', fn);
export const syncProgress = (docId) => activity.get(docId) || null;

function progress(docId, done, total) {
  if (done == null) activity.delete(docId);
  else activity.set(docId, { done, total });
  bus.emit('progress', { docId, done, total });
}

/** Uploads a document (only pages that changed). Concurrent calls are coalesced. */
export function syncDoc(docId) {
  if (running.has(docId)) {
    again.add(docId);
    return running.get(docId);
  }
  const p = (async () => {
    try {
      do {
        again.delete(docId);
        await whenIdle(); // let pending page renders land first
        await pushDoc(docId);
      } while (again.has(docId));
    } finally {
      running.delete(docId);
      progress(docId, null);
    }
  })();
  running.set(docId, p);
  return p;
}

async function pushDoc(docId) {
  const doc = await store.getDoc(docId);
  if (!doc) return;
  const stamp = doc.updatedAt;
  try {
    const remote = await api.putDoc(doc.id, { title: doc.title, created_at: new Date(doc.createdAt).toISOString() });
    const byId = new Map(remote.pages.map((p) => [p.id, p]));
    const pages = await store.getPages(doc);
    const todo = pages.filter((p) => {
      const r = byId.get(p.id);
      return !r || r.version !== p.version || r.original_id !== p.originalId || !r.has_original;
    });
    let done = 0;
    progress(docId, 0, todo.length);
    for (const page of todo) {
      const r = byId.get(page.id);
      const files = {
        processed: await store.getBlob(page.id, 'processed'),
        thumb: await store.getBlob(page.id, 'thumb'),
      };
      if (!r || r.original_id !== page.originalId || !r.has_original) files.original = await store.getBlob(page.id, 'original');
      if (!files.processed) continue;
      await api.putPage(doc.id, page.id, {
        version: page.version,
        original_id: page.originalId,
        corners: page.corners,
        rotation: page.rotation,
        filter: page.filter,
        adjust: page.adjust,
        src_width: page.srcWidth,
        src_height: page.srcHeight,
        detected: !!page.detected,
      }, files);
      progress(docId, ++done, todo.length);
    }
    const current = await store.getDoc(docId);
    if (!current) return;
    await api.patchDoc(doc.id, { title: current.title, page_order: current.pageIds.filter((id) => pages.some((p) => p.id === id)) });
    if (current.updatedAt !== stamp) {
      again.add(docId); // edited while uploading: run once more
      return;
    }
    await store.setSyncState(docId, { state: 'synced', syncedAt: Date.now() });
  } catch (e) {
    await store.setSyncState(docId, { ...(doc.sync || {}), state: 'error', error: e.message });
    throw e;
  }
}

/** Downloads a server document into local storage (replacing any local copy). */
export async function pullDoc(id, onProgress = () => {}) {
  const remote = await api.getDoc(id);
  await store.deleteDoc(id).catch(() => {});
  await store.createDoc({ id, title: remote.title, createdAt: Date.parse(remote.created_at) || Date.now() });
  let i = 0;
  for (const rp of remote.pages) {
    onProgress(i, remote.pages.length);
    const processed = await api.pageImage(id, rp.id, 'processed');
    const thumb = await api.pageImage(id, rp.id, 'thumb');
    const original = rp.has_original ? await api.pageImage(id, rp.id, 'original') : processed;
    const m = rp.meta || {};
    const page = {
      id: rp.id,
      docId: id,
      version: rp.version,
      processedVersion: rp.version,
      originalId: rp.original_id || rp.id,
      corners: rp.has_original && Array.isArray(m.corners) && m.corners.length === 4 ? m.corners : FULL_QUAD,
      detected: !!m.detected,
      rotation: rp.has_original ? m.rotation || 0 : 0,
      filter: rp.has_original ? m.filter || 'auto' : 'original',
      adjust: rp.has_original ? { ...DEFAULT_ADJUST, ...(m.adjust || {}) } : { ...DEFAULT_ADJUST },
      srcWidth: m.src_width || rp.width,
      srcHeight: m.src_height || rp.height,
      width: rp.width,
      height: rp.height,
      createdAt: Date.now(),
    };
    await store.savePage(page, { original, processed, thumb });
    i++;
  }
  onProgress(i, remote.pages.length);
  await store.setSyncState(id, { state: 'synced', syncedAt: Date.now() });
  return store.getDoc(id);
}

// ------------------------------------------------------------------ auto sync

const timers = new Map();

function schedule(docId, delay = 2500) {
  clearTimeout(timers.get(docId));
  timers.set(docId, setTimeout(async () => {
    timers.delete(docId);
    if (!getSettings().autoSync || !navigator.onLine) return;
    const doc = await store.getDoc(docId);
    if (!doc || doc.sync?.state === 'synced' || !doc.pageIds.length) return;
    if (!cloudReady()) {
      const st = await checkServer();
      if (!(st.reachable && st.authOk)) return;
    }
    syncDoc(docId).catch((e) => console.warn('sync failed', e));
  }, delay));
}

export async function syncAllPending() {
  if (!getSettings().autoSync) return;
  const docs = await store.listDocs();
  for (const d of docs) {
    if (d.sync?.state !== 'synced' && d.pageIds.length) schedule(d.id, 500);
  }
}

export function startAutoSync() {
  store.onStoreChange(({ docId, kind }) => {
    if (!docId || kind === 'sync' || kind === 'deleted') return;
    schedule(docId);
  });
  window.addEventListener('online', () => syncAllPending());
}
