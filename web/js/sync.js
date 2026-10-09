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
    const onServer = new Set(byId.keys());
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
      onServer.add(page.id);
      progress(docId, ++done, todo.length);
    }
    const current = await store.getDoc(docId);
    if (!current) return;
    const deleted = current.deletedPageIds || [];
    const merged = await api.patchDoc(doc.id, {
      title: current.title,
      page_order: current.pageIds.filter((id) => onServer.has(id)),
      delete_pages: deleted,
    });
    if (deleted.length) {
      const latest = await store.getDoc(docId);
      await store.updateDoc(docId, { deletedPageIds: (latest.deletedPageIds || []).filter((id) => !deleted.includes(id)) }, { dirty: false });
    }
    // Pages added to this document from another device: bring them here as well.
    const known = new Set([...current.pageIds, ...deleted]);
    const extra = merged.pages.map((rp, i) => [rp, i]).filter(([rp]) => !known.has(rp.id));
    for (const [rp, position] of extra) {
      const { page, blobs } = await downloadPage(docId, rp);
      await store.savePage(page, blobs, { position });
    }
    const latest = await store.getDoc(docId);
    if (extra.length || latest.updatedAt !== stamp) {
      again.add(docId); // changed while uploading (or merged): run once more
      return;
    }
    await store.setSyncState(docId, { state: 'synced', syncedAt: Date.now() });
  } catch (e) {
    await store.setSyncState(docId, { ...(doc.sync || {}), state: 'error', error: e.message });
    throw e;
  }
}

async function downloadPage(docId, rp) {
  const processed = await api.pageImage(docId, rp.id, 'processed');
  const thumb = await api.pageImage(docId, rp.id, 'thumb');
  const original = rp.has_original ? await api.pageImage(docId, rp.id, 'original') : processed;
  const m = rp.meta || {};
  const editable = rp.has_original;
  const page = {
    id: rp.id,
    docId,
    version: rp.version,
    processedVersion: rp.version,
    originalId: rp.original_id || rp.id,
    corners: editable && Array.isArray(m.corners) && m.corners.length === 4 ? m.corners : FULL_QUAD,
    detected: !!m.detected,
    rotation: editable ? m.rotation || 0 : 0,
    filter: editable ? m.filter || 'auto' : 'original',
    adjust: editable ? { ...DEFAULT_ADJUST, ...(m.adjust || {}) } : { ...DEFAULT_ADJUST },
    srcWidth: m.src_width || rp.width,
    srcHeight: m.src_height || rp.height,
    width: rp.width,
    height: rp.height,
    createdAt: Date.now(),
  };
  return { page, blobs: { original, processed, thumb } };
}

/**
 * Downloads a server document into local storage, replacing any local copy. Everything
 * is fetched first, so an interrupted download leaves the local copy untouched.
 */
export async function pullDoc(id, onProgress = () => {}) {
  const remote = await api.getDoc(id);
  const items = [];
  for (const rp of remote.pages) {
    onProgress(items.length, remote.pages.length);
    items.push(await downloadPage(id, rp));
  }
  onProgress(items.length, remote.pages.length);
  await store.deleteDoc(id).catch(() => {});
  await store.createDoc({ id, title: remote.title, createdAt: Date.parse(remote.created_at) || Date.now() });
  for (const { page, blobs } of items) await store.savePage(page, blobs);
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
