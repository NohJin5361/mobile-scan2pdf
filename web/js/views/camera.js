// Camera: live page detection, auto-capture when steady, single or batch mode.
import { h, icon, iconButton, toast, busy } from '../ui.js';
import * as store from '../store.js';
import { run } from '../processor.js';
import { addPageFromBlob, replaceOriginal } from '../pages.js';
import { getSettings, updateSettings } from '../settings.js';
import { canvasToBlob, releaseCanvas } from '../imageio.js';
import { pickFiles, importImages } from './common.js';

const STABLE_FRAMES = 7;      // consecutive steady detections before auto-capture
const STEADY_MOVE = 0.018;    // max corner movement (fraction of frame) to count as steady
const LIVE_DIM = 360;         // detection frame size

function quadDelta(a, b) {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}

// Tiny grey thumbnail of a frame, used to notice when the next page is in view.
function signature(frame) {
  const W = 16, H = 12;
  const out = new Float32Array(W * H);
  const { width: w, height: h, data } = frame;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.floor(((x + 0.5) * w) / W), sy = Math.floor(((y + 0.5) * h) / H);
      const i = (sy * w + sx) * 4;
      out[y * W + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  return out;
}

function sigDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export default async function cameraView({ query, navigate, goBack }) {
  let docId = query.get('doc') || 'new';
  const retakeId = query.get('retake');
  const insertAt = query.get('at') != null ? Number(query.get('at')) : null;
  const settings = getSettings();
  let batch = retakeId ? false : settings.batchMode;
  let auto = settings.autoCapture;
  let torchOn = false;
  let stream = null;
  let track = null;
  let imageCapture = null;
  let destroyed = false;
  let capturing = false;
  let captured = 0;
  let processing = 0;
  let thumbUrl = null;
  let loopTimer = null;
  let detecting = false;
  let smooth = null;
  let stable = 0;
  let lost = 0;
  let armed = true;
  let captureSig = null;
  let lastSig = null;

  // ---------------------------------------------------------------- DOM
  const video = h('video', { playsinline: true, muted: true, autoplay: true, 'aria-label': '카메라 미리보기' });
  video.setAttribute('webkit-playsinline', '');
  video.muted = true;
  const overlay = h('canvas', { class: 'cam-overlay' });
  const flash = h('div', { class: 'cam-flash' });
  const hint = h('div', { class: 'cam-hint', role: 'status' }, '카메라를 준비하는 중…');
  const procText = h('span');
  const procBadge = h('div', { class: 'cam-processing', style: { display: 'none' } }, h('span', { class: 'spinner small' }), procText);
  const stage = h('div', { class: 'cam-stage' }, video, overlay, flash, hint, procBadge);

  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('viewBox', '0 0 76 76');
  ring.innerHTML = '<circle cx="38" cy="38" r="35" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="4"/><circle class="prog" cx="38" cy="38" r="35" fill="none" stroke="#22c55e" stroke-width="5" stroke-dasharray="219.9" stroke-dashoffset="219.9" stroke-linecap="round"/>';
  const ringProg = ring.querySelector('.prog');
  const shutter = h('button', { type: 'button', class: 'shutter', 'aria-label': '촬영', onclick: () => capture() }, ring);

  const torchBtn = iconButton('flashOff', '플래시', toggleTorch);
  torchBtn.hidden = true;
  const autoBtn = iconButton('auto', '자동 촬영', toggleAuto, { text: '' });
  const thumbImg = h('img', { alt: '' });
  const countEl = h('span', { class: 'count' }, '0');
  const doneBtn = h('button', { type: 'button', class: 'cam-done', onclick: finish, style: { visibility: 'hidden' } }, thumbImg, countEl, '완료');
  const galleryBtn = iconButton('image', '사진 가져오기', importGallery, { text: '가져오기' });

  const singleBtn = h('button', { type: 'button', onclick: () => setBatch(false) }, '한 장');
  const batchBtn = h('button', { type: 'button', onclick: () => setBatch(true) }, '여러 장');
  const modeRow = h('div', { class: 'cam-mode', role: 'radiogroup', 'aria-label': '촬영 방식' }, singleBtn, batchBtn);
  if (retakeId) modeRow.style.visibility = 'hidden';

  const el = h('div', { class: 'camera' },
    h('div', { class: 'cam-top' },
      iconButton('close', '닫기', close),
      h('div', { style: { display: 'flex', gap: '4px' } }, torchBtn, autoBtn)),
    stage,
    modeRow,
    h('div', { class: 'cam-bottom' }, galleryBtn, shutter, doneBtn));

  function refreshButtons() {
    autoBtn.classList.toggle('active', auto);
    autoBtn.querySelector('.icon-btn-label').textContent = auto ? '자동' : '수동';
    singleBtn.classList.toggle('active', !batch);
    batchBtn.classList.toggle('active', batch);
    singleBtn.setAttribute('aria-checked', String(!batch));
    batchBtn.setAttribute('aria-checked', String(batch));
    torchBtn.replaceChildren(icon(torchOn ? 'flash' : 'flashOff'));
    torchBtn.classList.toggle('active', torchOn);
  }

  function setBatch(v) {
    batch = v;
    updateSettings({ batchMode: v });
    refreshButtons();
  }

  function toggleAuto() {
    auto = !auto;
    updateSettings({ autoCapture: auto });
    stable = 0;
    refreshButtons();
    updateHint();
  }

  async function toggleTorch() {
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      torchOn = !torchOn;
    } catch {
      toast('플래시를 켤 수 없습니다', { error: true });
    }
    refreshButtons();
  }

  // ---------------------------------------------------------------- camera
  function showFallback(message) {
    hint.style.display = 'none';
    shutter.disabled = true;
    stage.append(h('div', { class: 'cam-fallback' },
      icon('camera', 48),
      h('p', {}, message),
      h('button', { type: 'button', class: 'btn primary', onclick: nativeCamera }, icon('camera'), '카메라 앱으로 촬영'),
      h('button', { type: 'button', class: 'btn', onclick: importGallery }, icon('image'), '사진 가져오기')));
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      showFallback(window.isSecureContext
        ? '이 브라우저는 실시간 카메라를 지원하지 않습니다. 휴대폰 카메라 앱으로 촬영해도 똑같이 자동 보정됩니다.'
        : '실시간 카메라는 HTTPS 주소에서만 사용할 수 있습니다. 대신 휴대폰 카메라 앱으로 촬영하면 똑같이 자동 보정됩니다.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
      });
    } catch (e) {
      showFallback(e.name === 'NotAllowedError'
        ? '카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라를 허용하거나 아래 버튼을 사용하세요.'
        : `카메라를 시작할 수 없습니다 (${e.name || e.message}).`);
      return;
    }
    if (destroyed) {
      stopStream();
      return;
    }
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // autoplay is allowed for muted inline video; ignore transient errors
    }
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) torchBtn.hidden = false;
      if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch {
      // optional capabilities
    }
    if ('ImageCapture' in window) {
      try {
        imageCapture = new window.ImageCapture(track);
      } catch {
        imageCapture = null;
      }
    }
    updateHint();
    loop();
  }

  function stopStream() {
    clearTimeout(loopTimer);
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    track = null;
    torchOn = false;
  }

  // ---------------------------------------------------------------- live detection
  const det = document.createElement('canvas');
  const dctx = det.getContext('2d', { willReadFrequently: true });

  async function loop() {
    if (destroyed || !stream) return;
    if (!detecting && !capturing && video.readyState >= 2 && video.videoWidth) {
      detecting = true;
      try {
        const vw = video.videoWidth, vh = video.videoHeight;
        const sc = Math.min(1, LIVE_DIM / Math.max(vw, vh));
        det.width = Math.round(vw * sc);
        det.height = Math.round(vh * sc);
        dctx.drawImage(video, 0, 0, det.width, det.height);
        const img = dctx.getImageData(0, 0, det.width, det.height);
        const frame = { width: img.width, height: img.height, data: img.data };
        lastSig = signature(frame);
        const res = await run('detect', { image: frame, maxDim: LIVE_DIM, minConfidence: 0.45, regions: false }, [frame.data.buffer]);
        onDetection(res ? res.corners.map(([x, y]) => [x / det.width, y / det.height]) : null, res ? res.confidence : 0);
      } catch (e) {
        console.warn(e);
      }
      detecting = false;
    }
    loopTimer = setTimeout(loop, 70);
  }

  function onDetection(q, conf) {
    if (q && conf >= 0.5) {
      lost = 0;
      if (smooth && quadDelta(smooth, q) < 0.08) {
        const moved = quadDelta(smooth, q);
        smooth = smooth.map((p, i) => [p[0] * 0.45 + q[i][0] * 0.55, p[1] * 0.45 + q[i][1] * 0.55]);
        stable = moved < STEADY_MOVE ? stable + 1 : Math.max(0, stable - 2);
      } else {
        smooth = q;
        stable = 0;
      }
    } else if (++lost >= 3) {
      smooth = null;
      stable = 0;
    }
    if (!armed) {
      // After a capture wait for a new page: the page left the view or its content changed.
      if (!smooth && lost >= 3) armed = true;
      else if (captureSig && lastSig && sigDiff(captureSig, lastSig) > 14) armed = true;
    }
    draw();
    updateHint();
    if (auto && armed && smooth && stable >= STABLE_FRAMES && !capturing) capture();
  }

  function contentRect() {
    const ew = stage.clientWidth, eh = stage.clientHeight;
    const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
    const s = Math.min(ew / vw, eh / vh);
    return { x: (ew - vw * s) / 2, y: (eh - vh * s) / 2, w: vw * s, h: vh * s, ew, eh };
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const r = contentRect();
    if (overlay.width !== Math.round(r.ew * dpr) || overlay.height !== Math.round(r.eh * dpr)) {
      overlay.width = Math.round(r.ew * dpr);
      overlay.height = Math.round(r.eh * dpr);
    }
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.ew, r.eh);
    const progress = auto && armed && smooth ? Math.min(1, stable / STABLE_FRAMES) : 0;
    ringProg.setAttribute('stroke-dashoffset', String(219.9 * (1 - progress)));
    if (!smooth) return;
    const pts = smooth.map(([x, y]) => [r.x + x * r.w, r.y + y * r.h]);
    const ready = stable >= STABLE_FRAMES / 2;
    const color = ready ? '34,197,94' : '59,130,246';
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = `rgba(${color},0.18)`;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgb(${color})`;
    ctx.stroke();
    for (const [x, y] of pts) {
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.stroke();
    }
  }

  function updateHint() {
    if (!stream) return;
    let text;
    if (capturing) text = '촬영 중…';
    else if (!smooth) text = '문서를 화면 안에 맞춰주세요';
    else if (!auto) text = '문서를 찾았습니다 · 버튼을 눌러 촬영';
    else if (!armed) text = batch ? '다음 페이지를 놓아주세요' : '촬영했습니다';
    else text = '움직이지 마세요…';
    if (hint.textContent !== text) hint.textContent = text;
  }

  function updateProcessing() {
    procBadge.style.display = processing ? '' : 'none';
    procText.textContent = `처리 중 ${processing}`;
  }

  function updateDone() {
    doneBtn.style.visibility = captured ? 'visible' : 'hidden';
    countEl.textContent = String(captured);
  }

  // ---------------------------------------------------------------- capture
  async function grabPhoto() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (getSettings().highResCapture && imageCapture?.takePhoto) {
      try {
        const blob = await Promise.race([
          imageCapture.takePhoto(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        if (blob && blob.size) {
          // Some devices return the photo in sensor orientation: keep it only if it
          // matches the preview, otherwise use the preview frame.
          const bmp = await createImageBitmap(blob);
          const sameOrientation = (bmp.width >= bmp.height) === (vw >= vh);
          bmp.close?.();
          if (sameOrientation) return blob;
        }
      } catch (e) {
        console.warn('takePhoto failed, using the video frame', e);
      }
    }
    const c = document.createElement('canvas');
    c.width = vw;
    c.height = vh;
    c.getContext('2d').drawImage(video, 0, 0, vw, vh);
    try {
      return await canvasToBlob(c, 'image/jpeg', 0.95);
    } finally {
      releaseCanvas(c);
    }
  }

  async function ensureDoc() {
    if (docId !== 'new') return docId;
    const doc = await store.createDoc();
    docId = doc.id;
    history.replaceState(history.state, '', `#/camera?doc=${docId}`);
    return docId;
  }

  const insertPosition = () => (insertAt == null ? undefined : insertAt + captured);

  async function capture() {
    if (capturing || !stream) return;
    capturing = true;
    shutter.disabled = true;
    updateHint();
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 80);
    navigator.vibrate?.(25);
    const hintCorners = smooth;
    const hintAspect = video.videoWidth / video.videoHeight;
    try {
      const blob = await grabPhoto();
      armed = false;
      captureSig = lastSig;
      stable = 0;
      await ensureDoc();
      if (retakeId) {
        const b = busy('문서를 처리하는 중…');
        try {
          await replaceOriginal(retakeId, blob, { hintCorners, hintAspect });
        } finally {
          b.done();
        }
        navigate(`/doc/${docId}/crop/${retakeId}`, { replace: true });
        return;
      }
      if (batch) {
        const position = insertPosition();
        captured++;
        updateDone();
        if (thumbUrl) URL.revokeObjectURL(thumbUrl);
        thumbUrl = URL.createObjectURL(blob);
        thumbImg.src = thumbUrl;
        processing++;
        updateProcessing();
        addPageFromBlob(docId, blob, { hintCorners, hintAspect, position })
          .catch((e) => toast(e.message || '페이지 처리 실패', { error: true }))
          .finally(() => {
            processing--;
            updateProcessing();
          });
      } else {
        const b = busy('문서를 처리하는 중…');
        let page;
        try {
          page = await addPageFromBlob(docId, blob, { hintCorners, hintAspect, position: insertPosition() });
        } finally {
          b.done();
        }
        captured++;
        navigate(`/doc/${docId}/crop/${page.id}?next=page`, { replace: true });
      }
    } catch (e) {
      console.error(e);
      toast(e.message || '촬영하지 못했습니다', { error: true });
    } finally {
      capturing = false;
      shutter.disabled = false;
      updateHint();
    }
  }

  async function handleFiles(files) {
    if (!files.length) return;
    if (retakeId) {
      const b = busy('문서를 처리하는 중…');
      try {
        await replaceOriginal(retakeId, files[0]);
      } catch (e) {
        toast(e.message, { error: true });
        return;
      } finally {
        b.done();
      }
      navigate(`/doc/${docId}/crop/${retakeId}`, { replace: true });
      return;
    }
    const id = await ensureDoc();
    const res = await importImages(files, { docId: id, position: insertPosition() });
    if (!res) return;
    captured += res.added.length;
    if (res.added.length === 1 && !batch) navigate(`/doc/${id}/crop/${res.added[0].id}?next=page`, { replace: true });
    else navigate(`/doc/${id}`, { replace: true });
  }

  async function importGallery() {
    handleFiles(await pickFiles({ multiple: !retakeId }));
  }

  async function nativeCamera() {
    handleFiles(await pickFiles({ capture: true }));
  }

  async function finish() {
    if (docId === 'new' || !captured) {
      close();
      return;
    }
    navigate(`/doc/${docId}`, { replace: true });
  }

  async function close() {
    if (docId !== 'new' && !retakeId) {
      const doc = await store.getDoc(docId);
      if (doc && !doc.pageIds.length && !processing) await store.deleteDoc(docId);
      if (doc && (doc.pageIds.length || processing) && query.get('doc') === 'new') {
        navigate(`/doc/${docId}`, { replace: true });
        return;
      }
    }
    goBack('/');
  }

  const onVisibility = () => {
    if (document.hidden) stopStream();
    else if (!stream && !destroyed) start();
  };
  const onResize = () => draw();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);

  refreshButtons();
  start();

  return {
    el,
    destroy() {
      destroyed = true;
      stopStream();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      releaseCanvas(det);
    },
  };
}
