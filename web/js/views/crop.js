// Corner editor: drag corners or edges, with a magnifier showing the original pixels.
import { h, iconButton, toast, withBusy } from '../ui.js';
import * as store from '../store.js';
import { loadOriginal, updatePage, detectCorners, FULL_QUAD } from '../pages.js';
import { drawScaled, releaseCanvas } from '../imageio.js';
import { isConvexQuad } from '../core/geometry.js';

const CORNER_HIT = 34;  // touch radius in CSS px
const EDGE_HIT = 28;
const MAG_SIZE = 132;   // CSS px
const MAG_ZOOM = 3;     // relative to the on-screen scale

export default async function cropView({ params: [docId, pageId], query, navigate, goBack }) {
  const page = await store.getPage(pageId);
  if (!page) throw new Error('페이지를 찾을 수 없습니다');
  const loaded = await loadOriginal(page);
  const next = query.get('next');
  let quad = page.corners.map((p) => [...p]);
  const initial = JSON.stringify(quad);

  const canvas = h('canvas', { class: 'crop-canvas', 'aria-label': '문서 모서리 조정 영역' });
  const mag = h('canvas', { class: 'magnifier' });
  const stage = h('div', { class: 'stage' }, canvas, mag);
  const applyBtn = iconButton('check', '적용', apply, { class: 'active' });
  const status = h('span', { class: 'sr-only', role: 'status' });

  const el = h('div', { class: 'view editor' },
    h('header', { class: 'bar' },
      iconButton('back', '취소', () => goBack(`/doc/${docId}`)),
      h('div', { class: 'bar-title' }, '모서리 조정', h('div', { class: 'bar-sub' }, '모서리나 변을 끌어 문서 영역을 맞추세요')),
      applyBtn),
    stage,
    status,
    h('div', { class: 'bottombar' },
      iconButton('magic', '자동 감지', autoDetect, { text: '자동 감지' }),
      iconButton('expand', '전체 선택', () => { quad = FULL_QUAD.map((p) => [...p]); changed(); }, { text: '전체' }),
      iconButton('refresh', '원래대로', () => { quad = JSON.parse(initial); changed(); }, { text: '원래대로' }),
      iconButton('check', '적용', apply, { text: '적용' })));

  // ---------------------------------------------------------------- layout & drawing
  let L = null;
  let disp = null;

  function relayout() {
    const dpr = window.devicePixelRatio || 1;
    const ew = stage.clientWidth, eh = stage.clientHeight;
    if (!ew || !eh) return;
    canvas.width = Math.round(ew * dpr);
    canvas.height = Math.round(eh * dpr);
    const pad = 30;
    const s = Math.min((ew - 2 * pad) / loaded.width, (eh - 2 * pad) / loaded.height);
    const w = loaded.width * s, hgt = loaded.height * s;
    L = { x: (ew - w) / 2, y: (eh - hgt) / 2, w, h: hgt, dpr, ew, eh };
    const want = Math.round(Math.max(w, hgt) * dpr);
    if (!disp || Math.max(disp.width, disp.height) !== want) {
      if (disp) releaseCanvas(disp);
      disp = drawScaled(loaded.source, loaded.width, loaded.height, want);
    }
    mag.width = MAG_SIZE * dpr;
    mag.height = MAG_SIZE * dpr;
    draw();
  }

  const toScreen = ([x, y]) => [L.x + x * L.w, L.y + y * L.h];
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const valid = () => isConvexQuad(quad);

  function quadPath(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }

  function draw() {
    if (!L) return;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.clearRect(0, 0, L.ew, L.eh);
    ctx.drawImage(disp, L.x, L.y, L.w, L.h);
    const pts = quad.map(toScreen);
    // Dim everything outside the selection.
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.x, L.y, L.w, L.h);
    pts.slice().reverse().forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill('evenodd');
    ctx.restore();
    const ok = valid();
    const color = ok ? '#4f7bff' : '#ef4444';
    quadPath(ctx, pts);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    // Edge handles.
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(-13, -5, 26, 10, 5) : ctx.rect(-13, -5, 26, 10);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    }
    // Corner handles.
    pts.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, drag && drag.type === 'corner' && drag.index === i ? 15 : 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
    });
    applyBtn.disabled = !ok;
  }

  function drawMagnifier(focus) {
    const dpr = L.dpr;
    const ctx = mag.getContext('2d');
    const size = MAG_SIZE * dpr;
    const onScreenScale = L.w / loaded.width; // css px per source px
    const srcSpan = MAG_SIZE / (onScreenScale * MAG_ZOOM); // source px shown
    const fx = focus[0] * loaded.width, fy = focus[1] * loaded.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(loaded.source, fx - srcSpan / 2, fy - srcSpan / 2, srcSpan, srcSpan, 0, 0, size, size);
    // Selection lines in magnifier coordinates.
    const k = size / srcSpan;
    const mp = quad.map(([x, y]) => [(x * loaded.width - fx) * k + size / 2, (y * loaded.height - fy) * k + size / 2]);
    quadPath(ctx, mp);
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = valid() ? '#4f7bff' : '#ef4444';
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(size / 2 - 10 * dpr, size / 2);
    ctx.lineTo(size / 2 + 10 * dpr, size / 2);
    ctx.moveTo(size / 2, size / 2 - 10 * dpr);
    ctx.lineTo(size / 2, size / 2 + 10 * dpr);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- dragging
  let drag = null;

  function local(e) {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function hitTest(p) {
    const pts = quad.map(toScreen);
    let best = null;
    pts.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < CORNER_HIT && (!best || d < best.d)) best = { type: 'corner', index: i, d };
    });
    if (best) return best;
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const d = Math.hypot(m[0] - p[0], m[1] - p[1]);
      if (d < EDGE_HIT && (!best || d < best.d)) best = { type: 'edge', index: i, d };
    }
    return best;
  }

  function placeMagnifier(p) {
    const leftSide = p[0] < L.ew / 2 && p[1] < MAG_SIZE + 40;
    mag.style.left = leftSide ? '' : '12px';
    mag.style.right = leftSide ? '12px' : '';
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!L) return;
    const p = local(e);
    const hit = hitTest(p);
    if (!hit) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    const handle = hit.type === 'corner' ? toScreen(quad[hit.index]) : p;
    drag = { ...hit, pointerId: e.pointerId, start: p, startQuad: quad.map((q) => [...q]), offset: [handle[0] - p[0], handle[1] - p[1]] };
    mag.classList.add('show');
    move(p);
  });

  function move(p) {
    if (drag.type === 'corner') {
      const sx = p[0] + drag.offset[0], sy = p[1] + drag.offset[1];
      quad[drag.index] = [clamp01((sx - L.x) / L.w), clamp01((sy - L.y) / L.h)];
      placeMagnifier(p);
      drawMagnifier(quad[drag.index]);
    } else {
      // Move the edge along its normal (keeps its direction, like other scanner apps).
      const i = drag.index, j = (i + 1) % 4;
      const a = toScreenFrom(drag.startQuad[i]), b = toScreenFrom(drag.startQuad[j]);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
      const d = (p[0] - drag.start[0]) * nx + (p[1] - drag.start[1]) * ny;
      for (const k of [i, j]) {
        const s = toScreenFrom(drag.startQuad[k]);
        quad[k] = [clamp01((s[0] + nx * d - L.x) / L.w), clamp01((s[1] + ny * d - L.y) / L.h)];
      }
      placeMagnifier(p);
      drawMagnifier([(quad[i][0] + quad[j][0]) / 2, (quad[i][1] + quad[j][1]) / 2]);
    }
    draw();
  }

  const toScreenFrom = (q) => toScreen(q);

  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    move(local(e));
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    mag.classList.remove('show');
    draw();
    status.textContent = valid() ? '' : '모서리가 꼬였습니다. 사각형 모양이 되도록 조정하세요.';
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  function changed() {
    draw();
  }

  async function autoDetect() {
    const res = await withBusy('문서 영역을 찾는 중…', () => detectCorners(loaded)).catch(() => null);
    if (!res) {
      toast('문서를 찾지 못했습니다. 모서리를 직접 맞춰주세요.');
      return;
    }
    quad = res.corners;
    changed();
  }

  async function apply() {
    if (!valid()) {
      toast('모서리가 꼬였습니다. 사각형 모양이 되도록 조정하세요.', { error: true });
      return;
    }
    if (JSON.stringify(quad) !== initial) {
      try {
        await withBusy('적용하는 중…', () => updatePage(pageId, { corners: quad, detected: true }));
      } catch (e) {
        toast(e.message, { error: true });
        return;
      }
    }
    if (next === 'page') navigate(`/doc/${docId}/page/${pageId}?from=capture`, { replace: true });
    else goBack(`/doc/${docId}`);
  }

  const ro = new ResizeObserver(() => relayout());

  return {
    el,
    mounted() {
      ro.observe(stage);
      relayout();
    },
    destroy() {
      ro.disconnect();
      if (disp) releaseCanvas(disp);
    },
  };
}
