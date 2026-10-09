// Promise API over the image worker, with a main-thread fallback for browsers that
// cannot start module workers.

let worker = null;
let ready = null;
let seq = 0;
const pending = new Map();
let fallback = null;

function startWorker() {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(false);
      return;
    }
    let started = false;
    const timer = setTimeout(() => resolve(false), 8000);
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      if (id === 0) {
        started = true;
        clearTimeout(timer);
        resolve(true);
        return;
      }
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      clearTimeout(timer);
      for (const [, p] of pending) p.reject(new Error('이미지 처리 중 오류가 발생했습니다 (메모리 부족일 수 있습니다)'));
      pending.clear();
      if (!started) {
        resolve(false); // module workers unsupported: stay on the main-thread fallback
      } else {
        // Crashed later (e.g. out of memory): start a fresh worker on the next call.
        worker.terminate();
        worker = null;
        ready = null;
      }
    };
    worker.postMessage({ id: 0, op: 'ping', args: {} });
  });
  return ready;
}

async function runLocal(op, args) {
  fallback = fallback || (await import('./worker-ops.js'));
  await new Promise((r) => setTimeout(r, 0)); // let the UI paint a spinner first
  return fallback.handle(op, args).result;
}

/** Runs an image operation; `transfer` buffers are moved to the worker (zero copy). */
export async function run(op, args = {}, transfer = []) {
  const ok = await startWorker();
  if (!ok) return runLocal(op, args);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args }, transfer);
  });
}

export function warmUp() {
  startWorker();
}
