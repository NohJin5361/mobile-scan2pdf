// Local document store (IndexedDB).
//
// docs:  { id, title, createdAt, updatedAt, pageIds[], sync: { state, syncedAt, error } }
//        sync.state: 'local' (never uploaded) | 'synced' | 'dirty' | 'error'
// pages: { id, docId, version, processedVersion, originalId, corners (0..1, TL TR BR BL),
//          rotation, filter, adjust, srcWidth, srcHeight, width, height, createdAt, updatedAt }
// blobs: key `${pageId}/${kind}` with kind original | processed | thumb

import { Emitter, uuid, defaultTitle } from './util.js';

const DB_NAME = 'scan2pdf';
const DB_VERSION = 1;
const bus = new Emitter();
let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((v) => { result = v; }, (e) => { try { t.abort(); } catch { /* already done */ } reject(e); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export function onStoreChange(fn) {
  return bus.on('change', fn);
}

function changed(docId, kind = 'doc') {
  bus.emit('change', { docId, kind });
}

// ------------------------------------------------------------------ documents

export async function listDocs() {
  const docs = await tx(['docs'], 'readonly', (t) => req(t.objectStore('docs').getAll()));
  return docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getDoc(id) {
  return tx(['docs'], 'readonly', (t) => req(t.objectStore('docs').get(id)));
}

export async function createDoc({ id = uuid(), title = defaultTitle(), sync, createdAt } = {}) {
  const now = Date.now();
  const doc = { id, title, createdAt: createdAt || now, updatedAt: now, pageIds: [], sync: sync || { state: 'local' } };
  await tx(['docs'], 'readwrite', (t) => req(t.objectStore('docs').put(doc)));
  changed(id);
  return doc;
}

function markDirty(doc) {
  doc.updatedAt = Date.now();
  if (doc.sync?.state === 'synced' || doc.sync?.state === 'error') doc.sync = { ...doc.sync, state: 'dirty' };
}

export async function updateDoc(id, patch, { dirty = true } = {}) {
  const doc = await tx(['docs'], 'readwrite', async (t) => {
    const s = t.objectStore('docs');
    const d = await req(s.get(id));
    if (!d) throw new Error('문서를 찾을 수 없습니다');
    Object.assign(d, patch);
    if (dirty) markDirty(d);
    await req(s.put(d));
    return d;
  });
  changed(id);
  return doc;
}

export async function setSyncState(id, sync) {
  await tx(['docs'], 'readwrite', async (t) => {
    const s = t.objectStore('docs');
    const d = await req(s.get(id));
    if (!d) return;
    d.sync = sync;
    await req(s.put(d));
  });
  changed(id, 'sync');
}

export async function deleteDoc(id) {
  await tx(['docs', 'pages', 'blobs'], 'readwrite', async (t) => {
    const pages = await req(t.objectStore('pages').index('docId').getAll(id));
    for (const p of pages) {
      t.objectStore('pages').delete(p.id);
      for (const k of ['original', 'processed', 'thumb']) t.objectStore('blobs').delete(`${p.id}/${k}`);
    }
    t.objectStore('docs').delete(id);
  });
  changed(id, 'deleted');
}

// ------------------------------------------------------------------ pages

export function getPage(id) {
  return tx(['pages'], 'readonly', (t) => req(t.objectStore('pages').get(id)));
}

export async function getPages(doc) {
  const pages = await tx(['pages'], 'readonly', (t) => req(t.objectStore('pages').index('docId').getAll(doc.id)));
  const byId = new Map(pages.map((p) => [p.id, p]));
  return doc.pageIds.map((id) => byId.get(id)).filter(Boolean);
}

/** Inserts or replaces a page with its blobs, and links it into the document. */
export async function savePage(page, blobs = {}, { position } = {}) {
  await tx(['docs', 'pages', 'blobs'], 'readwrite', async (t) => {
    const docs = t.objectStore('docs');
    const doc = await req(docs.get(page.docId));
    if (!doc) throw new Error('문서를 찾을 수 없습니다');
    page.updatedAt = Date.now();
    t.objectStore('pages').put(page);
    for (const [kind, blob] of Object.entries(blobs)) {
      if (blob) t.objectStore('blobs').put(blob, `${page.id}/${kind}`);
    }
    if (!doc.pageIds.includes(page.id)) {
      const pos = position == null ? doc.pageIds.length : Math.max(0, Math.min(position, doc.pageIds.length));
      doc.pageIds.splice(pos, 0, page.id);
    }
    markDirty(doc);
    await req(docs.put(doc));
  });
  changed(page.docId, 'page');
  return page;
}

export async function deletePage(docId, pageId) {
  await tx(['docs', 'pages', 'blobs'], 'readwrite', async (t) => {
    const docs = t.objectStore('docs');
    const doc = await req(docs.get(docId));
    if (doc) {
      doc.pageIds = doc.pageIds.filter((id) => id !== pageId);
      markDirty(doc);
      await req(docs.put(doc));
    }
    t.objectStore('pages').delete(pageId);
    for (const k of ['original', 'processed', 'thumb']) t.objectStore('blobs').delete(`${pageId}/${k}`);
  });
  changed(docId, 'page');
}

export function getBlob(pageId, kind) {
  return tx(['blobs'], 'readonly', (t) => req(t.objectStore('blobs').get(`${pageId}/${kind}`)));
}

export async function storageEstimate() {
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // not supported
  }
}

export async function clearAll() {
  await tx(['docs', 'pages', 'blobs'], 'readwrite', (t) => {
    t.objectStore('docs').clear();
    t.objectStore('pages').clear();
    t.objectStore('blobs').clear();
  });
  changed(null, 'cleared');
}
