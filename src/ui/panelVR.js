import { on } from '../core/bus.js';

// In-VR UI: wrist-mounted panel (left hand), mic orb state machine (spec §6),
// floating caption, and the 3-second undo toast (spec §7).

const MIC_COLORS = {
  idle: '#3a6ea5',
  listening: '#35c26e',
  thinking: '#8a5cf6',
  speaking: '#35c2c2'
};

let handlers = null;
let refs = {};
let micState = 'idle';
let initialized = false;

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.setAttribute('value', text);
  return node;
}

// Hidden panels are teleported far below the scene as well as set invisible:
// three.js raycasts ignore visibility, so invisible clickables could otherwise
// still catch the controller laser.
function setPanelVisible(panelEl, visible) {
  if (!panelEl) return;
  panelEl.setAttribute('visible', String(visible));
  const y = visible ? panelEl.__homeY || '0' : '-1000';
  panelEl.setAttribute('position', `0 ${y} 0.005`);
}

function mkButton(parent, { label, x, y, w = 0.17, h = 0.08, color = '#223052', textColor = '#dfe7ff', onClick }) {
  const btn = el('a-entity', {
    position: `${x} ${y} 0.01`,
    geometry: `primitive: plane; width: ${w}; height: ${h}`,
    material: `color: ${color}; shader: flat`,
    class: 'clickable'
  });
  // size text so the label always fits inside the button
  const chars = Math.max(6, label.length);
  const t = el('a-text', {
    align: 'center', width: w * 0.85, 'wrap-count': chars,
    color: textColor, 'z-offset': 0.01
  }, label);
  btn.appendChild(t);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick && onClick(btn);
  });
  parent.appendChild(btn);
  return btn;
}

function mkText(parent, attrs, value) {
  const t = el('a-text', { align: 'center', color: '#dfe7ff', ...attrs }, value);
  parent.appendChild(t);
  return t;
}

function buildMainMenu() {
  const panel = el('a-entity', { id: 'vp-main', position: '0 0 0.005' });
  panel.__homeY = '0';

  mkText(panel, { position: '0 0.185 0.01', width: 0.5, 'wrap-count': 24, color: '#9ad8ff' }, 'Worldsmith');

  const grid = [
    // [label, handler]
    ['Listen', () => handlers.toggleListen()],
    ['Keyboard', () => handlers.openKeyboard()],
    ['Settings', () => showPanel('settings')],
    ['History', () => { buildHistoryPanel(); showPanel('history'); }],
    ['Undo', () => handlers.undo()],
    ['Export', () => handlers.exportWorld()],
    ['Import', () => handlers.importWorld()],
    ['Reset', () => handlers.resetWorld()],
    ['MR', () => handlers.enterMR()]
  ];
  const xs = [-0.19, 0, 0.19];
  const ys = [0.09, -0.005, -0.1];
  grid.forEach(([label, fn], i) => {
    const x = xs[i % 3];
    const y = ys[Math.floor(i / 3)];
    const b = mkButton(panel, { label, x, y });
    b.addEventListener('click', fn);
    if (label === 'MR') refs.mrButton = b;
  });

  refs.main = panel;
  return panel;
}

function buildSettingsPanel() {
  const panel = el('a-entity', { id: 'vp-settings' });
  panel.__homeY = '0';

  mkText(panel, { position: '0 0.185 0.01', width: 0.5, 'wrap-count': 24, color: '#9ad8ff' }, 'Settings');

  const rows = [
    { y: 0.11, label: 'API key', getLabel: () => handlers.hasApiKey() ? 'API key: set' : 'API key: not set', action: (b) => handlers.editApiKey(b) },
    { y: 0.02, label: 'Model', getLabel: () => `Model: ${handlers.modelLabel()}`, action: async (b) => {
        await handlers.cycleModel();
        updateButtonLabel(b, `Model: ${handlers.modelLabel()}`);
      } },
    { y: -0.07, label: 'Validate key', getLabel: () => 'Validate key', action: (b) => handlers.validateKey().then((r) => {
        if (refs.validateText) refs.validateText.setAttribute('value', r.message || (r.ok ? 'Key valid' : 'Key rejected'));
      }) }
  ];
  for (const row of rows) {
    const b = mkButton(panel, { label: row.getLabel(), x: 0, y: row.y, w: 0.4, h: 0.07 });
    b.addEventListener('click', () => row.action(b));
  }

  refs.validateText = mkText(panel, { position: '0 -0.135 0.01', width: 0.5, 'wrap-count': 42, color: '#9ad8ff' }, '');

  const muteBtn = mkButton(panel, { label: handlers.muted() ? 'Mute: on' : 'Mute: off', x: -0.11, y: -0.185, w: 0.19, h: 0.07 });
  muteBtn.addEventListener('click', async () => {
    const m = await handlers.toggleMute();
    updateButtonLabel(muteBtn, m ? 'Mute: on' : 'Mute: off');
  });
  const backBtn = mkButton(panel, { label: 'Back', x: 0.11, y: -0.185, w: 0.19, h: 0.07, color: '#4a2a4a' });
  backBtn.addEventListener('click', () => showPanel('main'));

  refs.settings = panel;
  return panel;
}

function buildHistoryPanel() {
  if (refs.history) refs.history.parentNode.removeChild(refs.history);
  const panel = el('a-entity', { id: 'vp-history' });
  panel.__homeY = '0';

  mkText(panel, { position: '0 0.185 0.01', width: 0.5, 'wrap-count': 24, color: '#9ad8ff' }, 'History (tap to rerun)');

  const history = handlers.getHistory().slice(0, 8);
  history.forEach((entry, i) => {
    const y = 0.12 - i * 0.037;
    const label = (entry.prompt || '').slice(0, 34);
    const b = mkButton(panel, { label, x: 0, y, w: 0.52, h: 0.032, color: '#1a2338', textColor: '#b9c6e8' });
    b.addEventListener('click', () => {
      showPanel('main');
      handlers.submitPrompt(entry.prompt);
    });
  });
  if (!history.length) {
    mkText(panel, { position: '0 0.05 0.01', width: 0.5, 'wrap-count': 30, color: '#8a94aa' }, 'No prompts yet');
  }

  const backBtn = mkButton(panel, { label: 'Back', x: 0, y: -0.185, w: 0.19, h: 0.07, color: '#4a2a4a' });
  backBtn.addEventListener('click', () => showPanel('main'));

  refs.history = panel;
  refs.wrist.appendChild(panel);
  return panel;
}

function updateButtonLabel(btn, label) {
  const t = btn.querySelector('a-text');
  if (t) {
    t.setAttribute('value', label);
    t.setAttribute('wrap-count', Math.max(6, label.length));
  }
}

function showPanel(name) {
  setPanelVisible(refs.main, name === 'main');
  setPanelVisible(refs.settings, name === 'settings');
  if (refs.history) setPanelVisible(refs.history, name === 'history');
  if (refs.validateText) refs.validateText.setAttribute('value', '');
}

function setMicState(state) {
  if (!refs.orb || micState === state) return;
  micState = state;
  refs.orb.setAttribute('material', 'color', MIC_COLORS[state] || MIC_COLORS.idle);
  if (state === 'listening' || state === 'thinking') {
    refs.orb.setAttribute('animation__pulse',
      'property: scale; from: 1 1 1; to: 1.18 1.18 1.18; dur: 900; dir: alternate; loop: true; easing: easeInOutSine');
  } else {
    refs.orb.removeAttribute('animation__pulse');
    refs.orb.setAttribute('scale', '1 1 1');
  }
}

let captionTimer = null;
function showCaption(text, ms = 5000) {
  if (!refs.caption) return;
  refs.caption.setAttribute('visible', 'true');
  refs.captionText.setAttribute('value', text);
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => refs.caption.setAttribute('visible', 'false'), ms);
}

let toastTimer = null;
function hideToast() {
  if (!refs.toast) return;
  refs.toast.setAttribute('visible', 'false');
  // teleport out of the ray path: three.js raycasts ignore visibility
  refs.toast.setAttribute('position', '0 -1000 0');
}

function showToast(text, { undoable = false, ms = 3000 } = {}) {
  if (!refs.toast) return;
  refs.toast.setAttribute('position', '0 -0.28 -0.85');
  refs.toast.setAttribute('visible', 'true');
  refs.toastText.setAttribute('value', text);
  refs.toastUndo.setAttribute('visible', undoable ? 'true' : 'false');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

export function initPanelVR({ sceneEl, handlers: h }) {
  if (initialized) return api;
  handlers = h;
  initialized = true;

  const wrist = sceneEl.querySelector('#wrist-panel');
  const camera = sceneEl.querySelector('#camera');

  refs.wrist = wrist;

  // panel body
  const body = el('a-entity', {
    geometry: 'primitive: plane; width: 0.66; height: 0.5',
    material: 'color: #0e1424; shader: flat; opacity: 0.92; transparent: true'
  });
  wrist.appendChild(body);

  refs.main = buildMainMenu();
  refs.settings = buildSettingsPanel();
  wrist.appendChild(refs.main);
  wrist.appendChild(refs.settings);
  setPanelVisible(refs.settings, false);

  wrist.setAttribute('face-camera', '');

  // mic orb wiring
  refs.orb = sceneEl.querySelector('#mic-orb');
  if (refs.orb) {
    refs.orb.setAttribute('face-camera', '');
    refs.orb.addEventListener('mousedown', () => handlers.micPress());
    refs.orb.addEventListener('mouseup', () => handlers.micRelease());
  }

  // caption
  refs.caption = sceneEl.querySelector('#caption');
  refs.captionText = sceneEl.querySelector('#caption-text');
  if (refs.caption) refs.caption.setAttribute('face-camera', '');

  // undo toast (created here, attached to the camera so it is always readable)
  const toast = el('a-entity', { id: 'vr-toast', position: '0 -0.28 -0.85', visible: 'false' });
  const toastBg = el('a-entity', {
    geometry: 'primitive: plane; width: 0.5; height: 0.09',
    material: 'color: #101826; shader: flat; opacity: 0.95; transparent: true'
  });
  toast.appendChild(toastBg);
  refs.toastText = el('a-text', {
    align: 'center', position: '-0.04 0 0.01', width: 0.4, 'wrap-count': 40, color: '#ffffff'
  }, 'Deleted');
  toast.appendChild(refs.toastText);
  refs.toastUndo = mkButton(toast, {
    label: 'Undo', x: 0.2, y: 0, w: 0.09, h: 0.07, color: '#2f6b4f',
    onClick: () => {
      handlers.undo();
      hideToast();
    }
  });
  camera.appendChild(toast);
  refs.toast = toast;

  // MR button only lights up when immersive-ar is supported
  if (refs.mrButton) {
    const applyMrSupport = (supported) => {
      refs.mrButton.setAttribute('material', 'color', supported ? '#223052' : '#2a2f3a');
      refs.mrUnsupported = !supported;
    };
    refs.mrButton.addEventListener('click', () => {
      if (refs.mrUnsupported) {
        showCaption('Passthrough (MR) is not supported on this device', 3000);
        return;
      }
    });
    applyMrSupport(handlers.isMrSupported());
    on('xr:ar-supported', applyMrSupport);
  }

  on('mic:state', (state) => setMicState(state));
  on('xr:mode', (mode) => {
    if (mode === 'desktop') showPanel('main');
  });

  return api;
}

const api = { setMicState, showCaption, showToast };
export { setMicState, showCaption, showToast };
