// Settings: cloud server, scanning defaults, storage.
import { h, icon, iconButton, toast, segmented, toggle, confirmDialog } from '../ui.js';
import { getSettings, updateSettings, apiBaseUrl, DEFAULTS } from '../settings.js';
import { checkServer } from '../api.js';
import { syncAllPending } from '../sync.js';
import * as store from '../store.js';
import { processorMode } from '../processor.js';
import { FILTERS } from '../core/enhance.js';
import { field } from './common.js';
import { formatBytes, EMBEDDED } from '../util.js';

export default async function settingsView({ goBack }) {
  const s = getSettings();
  const statusLine = h('p', { class: 'status-line' });
  const apiInput = h('input', { class: 'input', type: 'url', inputmode: 'url', placeholder: './api (이 서버)', value: s.apiBase, autocomplete: 'off', spellcheck: 'false' });
  const tokenInput = h('input', { class: 'input', type: 'password', placeholder: '서버에 토큰을 설정한 경우 입력', value: s.apiToken, autocomplete: 'off' });
  const showToken = h('button', { type: 'button', class: 'btn small', style: { flex: 'none', whiteSpace: 'nowrap' }, onclick: () => {
    tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
  } }, '보기');
  const usage = h('span', {}, '계산 중…');
  const diag = h('div', { style: { fontSize: '14px', paddingBottom: '12px', lineHeight: '1.7' } }, '확인 중…');
  (async () => {
    const downloads = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
    const rows = [
      ['저장소', store.isTemporaryStorage() ? '임시 메모리 (창을 닫으면 사라짐)' : '기기 저장소 (IndexedDB)'],
      ['이미지 처리', (await processorMode()) === 'worker' ? '백그라운드 작업자' : '메인 스레드'],
      ['카메라 앱 촬영', 'capture' in document.createElement('input') ? '지원' : '사진 선택으로 대체'],
      ['파일 저장', EMBEDDED ? (downloads ? 'Claude 저장 확인창' : '사용할 수 없음') : '브라우저 다운로드'],
      ['화면', `${window.innerWidth}×${window.innerHeight} · ${navigator.userAgent.match(/(iPhone|iPad|Android)[^;)]*/)?.[0] || 'PC'}`],
    ];
    diag.replaceChildren(...rows.map(([k, v]) => h('div', {}, h('b', {}, `${k}: `), v)));
  })();

  async function test() {
    updateSettings({ apiBase: apiInput.value.trim(), apiToken: tokenInput.value.trim() });
    statusLine.className = 'status-line';
    statusLine.replaceChildren(h('span', { class: 'spinner small dark' }), '연결 확인 중…');
    const st = await checkServer({ force: true });
    if (st.reachable && st.authOk) {
      statusLine.className = 'status-line ok';
      statusLine.replaceChildren(icon('cloudOk'), `연결됨 · ${apiBaseUrl()}`);
      syncAllPending();
    } else {
      statusLine.className = 'status-line err';
      statusLine.replaceChildren(icon('cloudOff'), st.error || '연결할 수 없습니다');
    }
  }

  const resolutionOptions = [
    { value: 4096, label: '최고' },
    { value: 3508, label: '고화질' },
    { value: 2480, label: '표준' },
    { value: 1654, label: '저용량' },
  ];
  const qualityOptions = [
    { value: 0.95, label: '최고' },
    { value: 0.9, label: '높음' },
    { value: 0.8, label: '보통' },
  ];

  const el = h('div', { class: 'view' },
    h('header', { class: 'bar' }, iconButton('back', '뒤로', () => goBack('/')), h('div', { class: 'bar-title' }, '설정')),
    h('main', { class: 'content', style: { paddingBottom: '32px' } },
      EMBEDDED ? null : h('section', { class: 'settings-group' },
        h('h2', {}, '클라우드 서버'),
        field('서버 API 주소', apiInput),
        field('접속 토큰', h('div', { style: { display: 'flex', gap: '8px' } }, tokenInput, showToken)),
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn small primary', onclick: test }, '저장 및 연결 확인')),
        statusLine,
        toggle('자동 업로드', s.autoSync, (v) => { updateSettings({ autoSync: v }); if (v) syncAllPending(); }, '스캔하거나 편집하면 클라우드에 자동으로 저장합니다')),
      h('section', { class: 'settings-group' },
        h('h2', {}, '스캔'),
        field('기본 필터', segmented(FILTERS.map((f) => ({ value: f.id, label: f.label })), s.defaultFilter, (v) => updateSettings({ defaultFilter: v }))),
        field('스캔 해상도', segmented(resolutionOptions, s.outputMaxDim, (v) => updateSettings({ outputMaxDim: v }))),
        field('JPEG 화질', segmented(qualityOptions, s.jpegQuality, (v) => updateSettings({ jpegQuality: v }))),
        toggle('자동 촬영', s.autoCapture, (v) => updateSettings({ autoCapture: v }), '문서가 안정적으로 잡히면 자동으로 촬영합니다'),
        toggle('고해상도 사진 촬영', s.highResCapture, (v) => updateSettings({ highResCapture: v }), '지원 기기에서 미리보기 대신 카메라 최대 해상도로 촬영합니다'),
        toggle('용지 비율 자동 맞춤', s.snapPaper, (v) => updateSettings({ snapPaper: v }), 'A4·Letter 등에 가까우면 정확한 비율로 맞춥니다')),
      h('section', { class: 'settings-group' },
        h('h2', {}, '저장 공간'),
        h('p', { class: 'status-line' }, '이 기기 사용량: ', usage),
        h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn small', onclick: async () => {
            if (!(await confirmDialog('이 기기에 저장된 모든 문서를 삭제할까요?\n클라우드에 저장된 문서는 남습니다.', { ok: '모두 삭제', danger: true }))) return;
            await store.clearAll();
            toast('이 기기의 문서를 모두 삭제했습니다');
            showUsage();
          } }, icon('trash'), '이 기기의 문서 모두 삭제'),
          h('button', { type: 'button', class: 'btn small', onclick: () => {
            updateSettings({ ...DEFAULTS, apiBase: getSettings().apiBase, apiToken: getSettings().apiToken });
            toast('스캔 설정을 기본값으로 되돌렸습니다');
            goBack('/');
          } }, '스캔 설정 초기화'))),
      h('section', { class: 'settings-group' },
        h('h2', {}, '기기 진단'),
        diag),
      h('section', { class: 'settings-group' },
        h('h2', {}, '정보'),
        h('p', { class: 'status-line' }, `Scan2PDF 1.1${EMBEDDED ? ' · 체험판' : ''} · 문서 스캐너`),
        h('p', { class: 'status-line' }, h('a', { href: new URL('docs', apiBaseUrl()).href, target: '_blank', rel: 'noopener' }, 'API 문서 열기')))));

  async function showUsage() {
    const est = await store.storageEstimate();
    usage.textContent = est ? `${formatBytes(est.usage)} / ${formatBytes(est.quota)}` : '알 수 없음';
  }

  showUsage();
  if (!EMBEDDED) checkServer().then((st) => {
    statusLine.className = `status-line ${st.reachable && st.authOk ? 'ok' : 'err'}`;
    statusLine.replaceChildren(icon(st.reachable && st.authOk ? 'cloudOk' : 'cloudOff'), st.reachable && st.authOk ? `연결됨 · ${apiBaseUrl()}` : (st.error || '연결되지 않음'));
  });

  return { el };
}
