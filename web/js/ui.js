// DOM helpers, icons and common UI pieces (toast, sheets, dialogs, busy overlay).

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const PATHS = {
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-9 9"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  rotl: '<path d="M4 4v5h5"/><path d="M4.6 9A8 8 0 1 1 6 16.5"/>',
  rotr: '<path d="M20 4v5h-5"/><path d="M19.4 9A8 8 0 1 0 18 16.5"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
  magic: '<path d="M4 20L15 9"/><path d="M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 11l.7 1.3L21 13l-1.3.7L19 15l-.7-1.3L17 13l1.3-.7z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 8.5 4.75 4.75 0 0 1 17.5 18z"/>',
  cloudUp: '<path d="M7 18a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 8.5 4.75 4.75 0 0 1 17.5 18"/><path d="M12 12v8M9 15l3-3 3 3"/>',
  cloudOk: '<path d="M7 18a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 8.5 4.75 4.75 0 0 1 17.5 18z"/><path d="M9.5 13.5l2 2 3.5-3.5"/>',
  cloudOff: '<path d="M7 18a4.5 4.5 0 0 1-.7-8.95M10 5.5a6 6 0 0 1 7.8 3A4.75 4.75 0 0 1 19.6 17"/><path d="M3 3l18 18"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  more: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  flash: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  flashOff: '<path d="M13 2L9.5 6.7M7.5 9.4L4 14h7l-1 8 4.3-5.7M16.2 12.4L20 10h-7l.3-2.2"/><path d="M3 3l18 18"/>',
  auto: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8.5 16l3.5-8 3.5 8M9.8 13h4.4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  file: '<path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v5h5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
};

export function icon(name, size = 24) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ''}</svg>`;
  return span;
}

export function iconButton(name, label, onClick, extra = {}) {
  return h('button', { type: 'button', class: `icon-btn ${extra.class || ''}`, 'aria-label': label, title: label, onclick: onClick, ...extra.attrs }, icon(name), extra.text != null ? h('span', { class: 'icon-btn-label' }, extra.text) : null);
}

// ------------------------------------------------------------------ toast

let toastTimer = null;
export function toast(message, { error = false, duration = 2600 } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ------------------------------------------------------------------ busy overlay

let busyCount = 0;
export function busy(message = '처리 중…') {
  let el = document.getElementById('busy');
  if (!el) {
    el = h('div', { id: 'busy', role: 'alert', 'aria-busy': 'true' }, h('div', { class: 'spinner' }), h('div', { class: 'busy-text' }));
    document.body.append(el);
  }
  busyCount++;
  el.querySelector('.busy-text').textContent = message;
  el.classList.add('show');
  let finished = false;
  return {
    update(msg) {
      if (!finished) el.querySelector('.busy-text').textContent = msg;
    },
    done() {
      if (finished) return;
      finished = true;
      busyCount = Math.max(0, busyCount - 1);
      if (!busyCount) el.classList.remove('show');
    },
  };
}

export async function withBusy(message, fn) {
  const b = busy(message);
  try {
    return await fn(b);
  } finally {
    b.done();
  }
}

// ------------------------------------------------------------------ sheets & dialogs

/** Bottom sheet. `build(close)` returns the content. Resolves with the close value. */
export function sheet(title, build, { className = '' } = {}) {
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'backdrop' });
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      panel.classList.remove('open');
      backdrop.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => {
        backdrop.remove();
        panel.remove();
      }, 220);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(undefined);
    };
    const panel = h('div', { class: `sheet ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-handle' }),
      title ? h('div', { class: 'sheet-title' }, title) : null,
      h('div', { class: 'sheet-body' }, build(close)));
    backdrop.addEventListener('click', () => close(undefined));
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop, panel);
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      panel.classList.add('open');
      const first = panel.querySelector('input, button.primary, button');
      first?.focus({ preventScroll: true });
    });
  });
}

/** Action list sheet: items [{label, icon, danger, value}] → resolves value. */
export function actionSheet(title, items) {
  return sheet(title, (close) => h('div', { class: 'action-list' },
    items.filter(Boolean).map((it) => h('button', { type: 'button', class: `action-item ${it.danger ? 'danger' : ''}`, onclick: () => close(it.value) },
      it.icon ? icon(it.icon) : null, h('span', {}, it.label)))));
}

export function confirmDialog(message, { ok = '확인', cancel = '취소', danger = false } = {}) {
  return sheet('', (close) => h('div', { class: 'dialog' },
    h('p', { class: 'dialog-msg' }, message),
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, cancel),
      h('button', { type: 'button', class: `btn primary ${danger ? 'danger' : ''}`, onclick: () => close(true) }, ok)))).then((v) => !!v);
}

export function promptDialog(message, value = '', { ok = '확인', placeholder = '' } = {}) {
  return sheet(message, (close) => {
    const input = h('input', { type: 'text', class: 'input', value, placeholder, maxlength: 200 });
    const form = h('form', { class: 'dialog', onsubmit: (e) => { e.preventDefault(); close(input.value.trim()); } },
      input,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, '취소'),
        h('button', { type: 'submit', class: 'btn primary' }, ok)));
    setTimeout(() => { input.focus(); input.select(); }, 50);
    return form;
  }).then((v) => (v == null ? null : v));
}

export function segmented(options, value, onChange, { name = '' } = {}) {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': name });
  const render = () => {
    wrap.replaceChildren(...options.map((o) => h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(o.value === value),
      class: o.value === value ? 'active' : '',
      onclick: () => {
        value = o.value;
        render();
        onChange(value);
      },
    }, o.label)));
  };
  render();
  return wrap;
}

export function toggle(label, checked, onChange, hint) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, onchange: () => onChange(input.checked) });
  return h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, label, hint ? h('small', {}, hint) : null), input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
}

export function objectUrl(blob, registry) {
  const url = URL.createObjectURL(blob);
  registry?.push(url);
  return url;
}

export function revokeAll(registry) {
  for (const u of registry.splice(0)) URL.revokeObjectURL(u);
}
