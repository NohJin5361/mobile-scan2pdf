// Detection accuracy benchmark on synthetic scenes: node tools/bench-detect.mjs [count]
import { detectDocument } from '../web/js/core/detect.js';
import { makeScene, maxCornerError } from '../tests/js/synth.js';

const N = Number(process.argv[2] || 40);
const kinds = ['wood', 'dark', 'light', 'clutter', 'table-edge'];
const stats = {};
let fails = 0;
for (let s = 1; s <= N; s++) {
  const bg = kinds[s % kinds.length];
  const occlude = s % 7 === 0;
  const { image, corners } = makeScene({ seed: s, bg, occlude, width: 1200, height: 900 });
  const t0 = performance.now();
  const res = detectDocument(image);
  const ms = performance.now() - t0;
  const diag = Math.hypot(image.width, image.height);
  const err = res ? maxCornerError(res.corners, corners) / diag : 1;
  const st = (stats[bg] ||= { n: 0, ok: 0, err: [], ms: [] });
  st.n++; st.ms.push(ms); st.err.push(err);
  st.max = Math.max(st.max || 0, err);
  if (err < 0.01) st.ok++; else { fails++; console.log(`seed ${s} bg=${bg}${occlude ? ' occluded' : ''} err=${(err * 100).toFixed(2)}% conf=${res?.confidence}`); }
}
for (const [k, st] of Object.entries(stats)) {
  const med = st.err.slice().sort((a, b) => a - b)[st.err.length >> 1];
  console.log(`${k.padEnd(11)} ok ${st.ok}/${st.n}  median err ${(med * 100).toFixed(3)}%  max ${(st.max * 100).toFixed(3)}%  avg ${Math.round(st.ms.reduce((a, b) => a + b) / st.ms.length)}ms`);
}
console.log(`fails: ${fails}/${N}`);
