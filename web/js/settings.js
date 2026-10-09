// Per-device preferences (localStorage, guarded: storage may be unavailable).
import { Emitter } from './util.js';

const KEY = 'scan2pdf.settings.v1';

function defaultApiBase() {
  const meta = document.querySelector('meta[name="scan2pdf-api"]');
  return meta?.content || './api';
}

export const DEFAULTS = {
  apiBase: '',            // empty = use <meta name="scan2pdf-api"> / ./api
  apiToken: '',
  autoSync: true,
  defaultFilter: 'auto',
  autoCapture: true,
  batchMode: false,
  highResCapture: true,   // ImageCapture.takePhoto when supported
  outputMaxDim: 3508,     // long side of processed pages (A4 @ 300 dpi)
  sourceMaxDim: 4096,     // decoded original long side (memory / canvas limits)
  jpegQuality: 0.9,
  snapPaper: true,
  pdfPageSize: 'auto',
  pdfMarginMm: 0,
  pdfQuality: 'original',
};

const bus = new Emitter();
let current = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSettings() {
  return current;
}

export function updateSettings(patch) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode or blocked storage: keep settings for this session only.
  }
  bus.emit('change', current);
  return current;
}

export function onSettingsChange(fn) {
  return bus.on('change', fn);
}

export function apiBaseUrl() {
  const base = current.apiBase || defaultApiBase();
  return new URL(base.endsWith('/') ? base : `${base}/`, document.baseURI).href;
}
