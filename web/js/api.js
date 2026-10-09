// Client for the Scan2PDF server REST API.
import { apiBaseUrl, getSettings } from './settings.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', json, body, responseType = 'json', signal, timeout = 120000 } = {}) {
  const url = new URL(path, apiBaseUrl());
  const headers = {};
  const token = getSettings().apiToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  signal?.addEventListener('abort', () => ctrl.abort());
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: ctrl.signal, cache: 'no-store' });
  } catch (e) {
    throw new ApiError(0, ctrl.signal.aborted ? '서버 응답 시간이 초과되었습니다' : '서버에 연결할 수 없습니다');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.detail) msg = typeof j.detail === 'string' ? j.detail : j.detail.message || JSON.stringify(j.detail);
    } catch {
      // non-JSON error body
    }
    if (res.status === 401) msg = '접속 토큰이 없거나 올바르지 않습니다 (설정에서 입력하세요)';
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return null;
  if (responseType === 'blob') return res.blob();
  return res.json();
}

const enc = encodeURIComponent;

export const api = {
  health: () => request('health', { timeout: 8000 }),
  authCheck: () => request('auth/check', { timeout: 8000 }),
  listDocs: (q = '') => request(`documents?${new URLSearchParams({ q, limit: '500' })}`),
  getDoc: (id) => request(`documents/${enc(id)}`),
  putDoc: (id, data) => request(`documents/${enc(id)}`, { method: 'PUT', json: data }),
  patchDoc: (id, data) => request(`documents/${enc(id)}`, { method: 'PATCH', json: data }),
  deleteDoc: (id) => request(`documents/${enc(id)}`, { method: 'DELETE' }),
  putPage(docId, pageId, meta, files) {
    const fd = new FormData();
    fd.append('meta', JSON.stringify(meta));
    for (const [name, blob] of Object.entries(files)) {
      if (!blob) continue;
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      fd.append(name, blob, `${name}.${ext}`);
    }
    return request(`documents/${enc(docId)}/pages/${enc(pageId)}`, { method: 'PUT', body: fd, timeout: 300000 });
  },
  deletePage: (docId, pageId) => request(`documents/${enc(docId)}/pages/${enc(pageId)}`, { method: 'DELETE' }),
  pageImage: (docId, pageId, variant = 'thumb') => request(`documents/${enc(docId)}/pages/${enc(pageId)}/${variant}`, { responseType: 'blob' }),
  exportPdf: (docId, params = {}) => request(`documents/${enc(docId)}/export.pdf?${new URLSearchParams(params)}`, { responseType: 'blob', timeout: 300000 }),
  exportZip: (docId, params = {}) => request(`documents/${enc(docId)}/export.zip?${new URLSearchParams(params)}`, { responseType: 'blob', timeout: 300000 }),
  text: (docId, params = {}) => request(`documents/${enc(docId)}/text?${new URLSearchParams(params)}`, { timeout: 600000 }),
};

// ------------------------------------------------------------------ server status

let status = { checked: false, reachable: false, authOk: false, authRequired: false, error: '', ocr: null };
let checking = null;
const listeners = new Set();

export function serverStatus() {
  return status;
}

export function onServerStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function checkServer({ force = false } = {}) {
  if (checking && !force) return checking;
  checking = (async () => {
    let next;
    try {
      const h = await api.health();
      next = { checked: true, reachable: true, authRequired: !!h.auth_required, authOk: true, error: '', ocr: h.ocr || null };
      if (h.auth_required) {
        try {
          await api.authCheck();
        } catch (e) {
          next = { ...next, authOk: false, error: e.message };
        }
      }
    } catch (e) {
      next = { checked: true, reachable: false, authOk: false, authRequired: false, error: e.message, ocr: null };
    }
    status = next;
    for (const fn of listeners) fn(status);
    return status;
  })().finally(() => {
    setTimeout(() => { checking = null; }, 0);
  });
  return checking;
}

export const cloudReady = () => status.reachable && status.authOk;
export const ocrReady = () => cloudReady() && !!status.ocr?.available;
