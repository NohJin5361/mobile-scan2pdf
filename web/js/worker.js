// Module worker: runs heavy image processing off the UI thread.
import { handle } from './worker-ops.js';

self.onmessage = (e) => {
  const { id, op, args } = e.data;
  try {
    const { result, transfer } = handle(op, args || {});
    self.postMessage({ id, ok: true, result }, transfer || []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
