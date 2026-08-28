// In-VR QWERTY keyboard: a ray-interactive panel attached to the camera, used
// whenever SpeechRecognition is unavailable or fails (spec §6.2). The panel is
// fully detached from the scene when closed so it can never intercept laser
// raycasts while invisible.

const PANEL_W = 0.78;
const KEY_W = 0.062;
const KEY_H = 0.056;
const GAP = 0.006;

const ROWS_LETTERS = [
  'QWERTYUIOP'.split(''),
  'ASDFGHJKL'.split(''),
  'ZXCVBNM'.split('')
];
const ROWS_DIGITS = [
  '1234567890'.split(''),
  '-/:;()$&@"'.split(''),
  ".,?!'".split('')
];

let root = null;
let cameraEl = null;
let mounted = false;
let open = false;
let mode = 'prompt';
let layer = 'letters';
let buffer = '';
let onSend = null;
let refs = {};

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.setAttribute('value', text);
  return node;
}

function makeKey(label, { width = KEY_W, color = '#2a3242', handler }) {
  const key = el('a-entity', {
    geometry: `primitive: plane; width: ${width}; height: ${KEY_H}`,
    material: `color: ${color}; shader: flat`,
    class: 'clickable'
  });
  key.__w = width;
  const label2 = el('a-text', {
    align: 'center', width: width * 4.2, 'wrap-count': 14,
    color: '#dfe7ff', 'z-offset': 0.01
  }, label);
  key.appendChild(label2);
  key.addEventListener('click', (e) => {
    e.stopPropagation();
    handler();
  });
  return key;
}

// Row layout honors each key's own width (wide space/del/send keys).
function layoutRow(rowEntities, y) {
  const widths = rowEntities.map((k) => k.__w || KEY_W);
  const total = widths.reduce((a, b) => a + b, 0) + (rowEntities.length - 1) * GAP;
  let x = -total / 2;
  rowEntities.forEach((k, i) => {
    k.setAttribute('position', `${x + widths[i] / 2} ${y} 0`);
    x += widths[i] + GAP;
  });
}

function addWideKey(rowEntities, label, color, handler, width) {
  const k = makeKey(label, { width, color, handler });
  rowEntities.push(k);
  refs.keysLayer.appendChild(k);
  return k;
}

function buildLayer() {
  while (refs.keysLayer.firstChild) refs.keysLayer.removeChild(refs.keysLayer.firstChild);
  const rows = layer === 'letters' ? ROWS_LETTERS : ROWS_DIGITS;
  const y0 = 0.02;
  const dy = KEY_H + GAP;

  rows.forEach((chars, i) => {
    const row = [];
    for (const ch of chars) {
      row.push(makeKey(ch, { handler: () => { buffer += ch; refresh(); } }));
    }
    if (i === 2) {
      row.push(makeKey('DEL', { color: '#5a3040', width: KEY_W * 1.6, handler: () => { buffer = buffer.slice(0, -1); refresh(); } }));
    }
    layoutRow(row, y0 - i * dy);
    for (const k of row) refs.keysLayer.appendChild(k);
  });

  const bottom = [];
  addWideKey(bottom, layer === 'letters' ? '123' : 'ABC', '#33406a', () => {
    layer = layer === 'letters' ? 'digits' : 'letters';
    buildLayer();
  }, KEY_W * 1.4);
  addWideKey(bottom, 'space', '#2a3242', () => { buffer += ' '; refresh(); }, KEY_W * 3.4);
  addWideKey(bottom, 'Send', '#2f6b4f', () => {
    const value = buffer.trim();
    if (value && onSend) onSend(value, mode);
    buffer = '';
    closeKeyboard();
  }, KEY_W * 1.6);
  layoutRow(bottom, y0 - 3 * dy - 0.01);
}

function refresh() {
  refs.buffer.setAttribute('value', buffer || ' ');
}

function build() {
  root = el('a-entity', { id: 'vk-panel', position: `0 0 0`, rotation: '-8 0 0' });

  const bg = el('a-entity', {
    geometry: `primitive: plane; width: ${PANEL_W + 0.06}; height: 0.44`,
    material: 'color: #10141f; shader: flat; opacity: 0.92; transparent: true'
  });
  root.appendChild(bg);

  refs.title = el('a-text', {
    align: 'center', position: `0 0.185 0.01`, width: 0.6, 'wrap-count': 48, color: '#9ad8ff'
  }, 'Type your prompt');
  root.appendChild(refs.title);

  refs.buffer = el('a-text', {
    align: 'center', position: `0 0.135 0.01`, width: 0.72, 'wrap-count': 46, color: '#ffffff'
  }, ' ');
  root.appendChild(refs.buffer);

  refs.keysLayer = el('a-entity', { position: '0 -0.02 0.01' });
  root.appendChild(refs.keysLayer);

  const closeKey = makeKey('X', { color: '#5a3040', width: KEY_W * 0.9, handler: () => { buffer = ''; closeKeyboard(); } });
  closeKey.setAttribute('position', `${PANEL_W / 2 + 0.005} 0.185 0.01`);
  root.appendChild(closeKey);

  buildLayer();
  refresh();
}

export function initKeyboardVR(camera, sendHandler) {
  cameraEl = camera;
  onSend = sendHandler;
  if (!root) build();
}

export function openKeyboard({ mode: m = 'prompt', initial = '' } = {}) {
  mode = m;
  buffer = initial || '';
  layer = 'letters';
  open = true;
  refs.title.setAttribute('value',
    m === 'apikey' ? 'Paste your OpenRouter API key' :
    m === 'model' ? 'Enter custom model id' : 'Type your prompt');
  buildLayer(); // reset to the letters layer on every open
  refresh();
  if (!mounted && cameraEl && root) {
    cameraEl.appendChild(root);
    mounted = true;
  }
  if (root) root.setAttribute('visible', 'true');
}

export function closeKeyboard() {
  open = false;
  if (root) root.setAttribute('visible', 'false');
}

// Detaching from the scene entirely guarantees invisible keys can never catch
// the controller raycast when the keyboard is not in use.
export function suspendKeyboard() {
  if (mounted && root && root.parentNode) {
    root.parentNode.removeChild(root);
    mounted = false;
  }
  open = false;
}

export function isKeyboardOpen() {
  return open;
}
