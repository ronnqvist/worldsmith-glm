import 'aframe';
import { initLogger, log } from './core/log.js';
import { emit, on } from './core/bus.js';
import { storage, DEFAULT_SETTINGS } from './storage/localProvider.js';
import { buildExportData, downloadExport } from './storage/exportImport.js';
import { createInjector, SanitizeError } from './world/injector.js';
import { setupAmbient, primeAudio } from './audio/ambient.js';
import { buildSystemPrompt, MODELS, DEFAULT_MODEL } from './llm/systemPrompt.js';
import { chatCompletion, validateKey as validateOpenRouterKey, LlmError } from './llm/openrouter.js';
import { VoiceInput, isSpeechSupported } from './voice/speech.js';
import * as tts from './voice/tts.js';
import { initKeyboardVR, openKeyboard, suspendKeyboard } from './voice/keyboardVR.js';
import { initSession } from './xr/session.js';
import { registerXrComponents } from './xr/controllers.js';
import { registerGrab, setGrabInjector } from './xr/grab.js';
import { initDom, toast } from './ui/dom.js';
import { initPanelVR, showCaption as vrCaption, showToast as vrToast } from './ui/panelVR.js';

// Vendored font so A-Frame text never hits the CDN (see public/fonts).
const AFRAME = window.AFRAME;
if (AFRAME && AFRAME.components && AFRAME.components.text) {
  AFRAME.components.text.schema.font.default = 'fonts/Roboto-msdf.json';
}

initLogger(false);

const sceneEl = document.querySelector('a-scene');
const cameraEl = document.getElementById('camera');
const ctlRight = document.getElementById('ctl-right');
const dreamingEl = document.getElementById('dreaming');

registerXrComponents();
registerGrab();

const injector = createInjector(sceneEl);
setGrabInjector(injector);
const session = initSession(sceneEl);
const voice = new VoiceInput();

let currentSettings = { ...DEFAULT_SETTINGS };
let busy = false;
let listening = false;
let pendingSpeech = null;

function whenSceneReady() {
  return sceneEl.hasLoaded
    ? Promise.resolve()
    : new Promise((resolve) => sceneEl.addEventListener('loaded', resolve, { once: true }));
}

function persistWorld() {
  storage.saveWorldMarkup(injector.getFullMarkup());
}

function modelLabel() {
  const id = currentSettings.customModel || currentSettings.model || DEFAULT_MODEL;
  const known = MODELS.find((m) => m.id === id);
  return known ? known.label.replace(/\s*\(default\)$/, '') : id.split('/').pop();
}

async function persistSettings(patch) {
  currentSettings = await storage.saveSettings(patch);
  emit('settings:changed', currentSettings);
  return currentSettings;
}

// ---------------------------------------------------------------- voice input

async function micPress() {
  if (busy || listening) return;
  if (!isSpeechSupported() || voice.broken) {
    openKeyboard({ mode: 'prompt' });
    return;
  }
  listening = true;
  emit('mic:state', 'listening');
  try {
    pendingSpeech = voice.start({
      onPartial: (t) => { if (listening) vrCaption(t || 'Listening…', 1200); }
    });
  } catch (e) {
    log.warn('speech start failed:', e.message);
    listening = false;
    emit('mic:state', 'idle');
    openKeyboard({ mode: 'prompt' });
  }
}

async function micRelease() {
  if (!listening) return;
  listening = false;
  emit('mic:state', 'idle');
  const pending = pendingSpeech;
  pendingSpeech = null;
  voice.stop();
  let text = '';
  try {
    text = (await pending) || '';
  } catch (e) {
    log.warn('speech failed:', e.message);
    vrCaption('Speech unavailable — opening keyboard', 3000);
    openKeyboard({ mode: 'prompt' });
    return;
  }
  if (text) submitPrompt(text);
  else vrCaption('Heard nothing — hold again, or use the keyboard', 3000);
}

// ------------------------------------------------------------------- pipeline

function worldContextBlock() {
  const state = injector.getStateMarkup();
  return state ? `Current world markup:\n${state}` : 'The world is currently empty.';
}

async function submitPrompt(text) {
  const value = String(text || '').trim();
  if (!value || busy) {
    if (busy) toast('Still working on the last change…');
    return;
  }
  if (!currentSettings.apiKey) {
    const msg = 'Add your OpenRouter API key in Settings first';
    toast(msg, { error: true, ms: 6000 });
    vrCaption(msg, 6000);
    return;
  }

  busy = true;
  emit('llm:start');
  emit('mic:state', 'thinking');
  dreamingEl.setAttribute('visible', 'true');

  try {
    const model = currentSettings.customModel || currentSettings.model || DEFAULT_MODEL;
    const mrMode = session.mode === 'ar';
    const messages = [
      { role: 'system', content: buildSystemPrompt({ mrMode }) },
      { role: 'user', content: `${worldContextBlock()}\n\nUser request: ${value}` }
    ];
    const t0 = performance.now();
    const envelope = await chatCompletion({
      apiKey: currentSettings.apiKey,
      model,
      messages,
      referer: currentSettings.httpReferer || undefined,
      title: currentSettings.xTitle || undefined
    });
    log.debug(`LLM round-trip ${Math.round(performance.now() - t0)}ms`);

    const result = injector.applyResponse(envelope, { mrMode });
    persistWorld();
    await storage.addHistoryEntry({ prompt: value, ts: Date.now(), narration: result.narration });

    tts.speak(result.narration || 'Done', {
      caption: (t) => { vrCaption(t, 5000); toast(t); }
    });
    emit('llm:success', result);
  } catch (e) {
    const msg = e instanceof LlmError || e instanceof SanitizeError
      ? e.message
      : (e && e.message) || 'Something went wrong';
    log.error('prompt failed:', msg, e && e.stack);
    toast(msg, { error: true, ms: 6000 });
    vrCaption(msg, 6000);
    emit('llm:error', msg);
  } finally {
    busy = false;
    dreamingEl.setAttribute('visible', 'false');
    if (!listening) emit('mic:state', 'idle');
    emit('llm:done');
  }
}

// ------------------------------------------------------------------- handlers

async function validateKey() {
  const r = await validateOpenRouterKey({
    apiKey: currentSettings.apiKey,
    referer: currentSettings.httpReferer || undefined,
    title: currentSettings.xTitle || undefined
  });
  return r;
}

const domHandlers = {
  enterVR: () => session.enterVR(),
  enterMR: () => session.enterMR(),
  submitPrompt,
  undo: () => {
    const ok = injector.undo();
    if (ok) persistWorld();
    return ok;
  },
  resetWorld: () => {
    injector.reset();
    persistWorld();
  },
  restoreWorld: (markup) => {
    injector.restoreFromMarkup(markup);
    persistWorld();
  },
  getWorldMarkup: () => injector.getFullMarkup(),
  entityCount: () => injector.getEntityCount(),
  modelLabel,
  micAvailable: () => isSpeechSupported(),
  micPress,
  micRelease,
  validateKey
};

const panelHandlers = {
  submitPrompt,
  toggleListen: () => (listening ? micRelease() : micPress()),
  openKeyboard: () => openKeyboard({ mode: 'prompt' }),
  undo: () => {
    const ok = injector.undo();
    vrCaption(ok ? 'Reverted last change' : 'Nothing to undo', 2200);
  },
  resetWorld: () => {
    injector.reset();
    persistWorld();
    vrCaption('World reset', 2200);
  },
  exportWorld: async () => {
    const data = await buildExportData(storage);
    downloadExport(data);
    vrCaption('Export downloaded', 2500);
  },
  importWorld: () => {
    session.exit();
    setTimeout(() => {
      const panel = document.getElementById('panel-worlds');
      if (panel) panel.open = true;
      toast('Use Import in the Saved worlds panel to choose a file', { ms: 7000 });
    }, 500);
  },
  isMrSupported: () => session.arSupported,
  enterMR: () => {
    if (!session.arSupported) {
      toast('Passthrough (MR) is not supported on this device', { error: true });
      return;
    }
    session.enterMR();
  },
  hasApiKey: () => !!currentSettings.apiKey,
  editApiKey: () => openKeyboard({ mode: 'apikey' }),
  modelLabel,
  cycleModel: async () => {
    const ids = MODELS.map((m) => m.id);
    const idx = ids.indexOf(currentSettings.model);
    const next = MODELS[(idx + 1) % ids.length].id;
    await persistSettings({ model: next, customModel: '' });
  },
  validateKey,
  muted: () => !!currentSettings.muteTTS,
  toggleMute: async () => {
    const next = !currentSettings.muteTTS;
    await persistSettings({ muteTTS: next });
    tts.setMuted(next);
    return next;
  },
  micPress,
  micRelease
};

// ----------------------------------------------------------------------- boot

async function boot() {
  // settings
  currentSettings = await storage.getSettings();
  if (currentSettings.diagnostics) initLogger(true);
  tts.setMuted(currentSettings.muteTTS);
  log.info('settings loaded, model:', currentSettings.model);

  // custom components onto the shell entities
  document.getElementById('ctl-left').setAttribute('smooth-locomotion', '');
  ctlRight.setAttribute('snap-turn', '');
  const vignetteEl = document.getElementById('vignette');
  vignetteEl.setAttribute('comfort-vignette', 'enabled', currentSettings.vignette);
  dreamingEl.setAttribute('dreaming-swirl', '');

  on('settings:changed', (s) => {
    const comp = vignetteEl.components['comfort-vignette'];
    if (comp) comp.setEnabled(s.vignette);
    tts.setMuted(s.muteTTS);
    if (s.diagnostics) initLogger(true);
  });

  // ambient loop registered as #generated-ambient — must exist BEFORE any
  // restored entities init their sound components (A-Frame resolves #id at
  // sound-component init time and does not retry)
  await setupAmbient(sceneEl);

  // restore the persisted world
  const saved = await storage.getWorldMarkup();
  if (saved) {
    try {
      injector.restoreFromMarkup(saved);
    } catch (e) {
      log.warn('could not restore saved world:', e.message);
    }
  }

  // in-VR keyboard + panels + 2D UI
  initKeyboardVR(cameraEl, async (text, mode) => {
    if (mode === 'apikey') {
      await persistSettings({ apiKey: text });
      const r = await validateKey();
      toast(r.message, { error: !r.ok });
      vrCaption(r.message, 4000);
    } else if (mode === 'model') {
      await persistSettings({ customModel: text });
    } else {
      submitPrompt(text);
    }
  });
  initPanelVR({ sceneEl, handlers: panelHandlers });
  initDom({ handlers: domHandlers });

  // hold trigger in empty space = listen (spec §6); UI/interactive targets
  // are handled by the cursor and grab components instead
  ctlRight.addEventListener('triggerdown', () => {
    const ray = ctlRight.components.raycaster;
    const hits = ray && ray.intersectedEls && ray.intersectedEls.length > 0;
    if (!hits) micPress();
  });
  ctlRight.addEventListener('triggerup', () => {
    if (listening) micRelease();
  });

  // world persistence + grab delete toast
  on('world:changed', (detail) => {
    persistWorld();
    if (detail && detail.action === 'delete') {
      vrToast('Deleted', { undoable: true, ms: 3000 });
      toast('Deleted — use Undo to restore', { ms: 3000 });
    }
  });

  // audio priming on first user gesture
  const prime = () => primeAudio(sceneEl);
  window.addEventListener('pointerdown', prime, { once: true });
  sceneEl.addEventListener('mousedown', prime, { once: true });

  // keyboard is a camera child in VR; fully detached on desktop
  on('xr:mode', (mode) => {
    if (mode === 'desktop') suspendKeyboard();
    injector.syncSky();
  });
  on('mr:exited', () => injector.syncSky());

  // error boundaries
  window.addEventListener('error', (e) => {
    log.error('window error:', e.message);
    toast(e.message, { error: true });
  });
  window.addEventListener('unhandledrejection', (e) => {
    log.error('unhandled rejection:', e.reason && (e.reason.message || e.reason));
  });

  // loading screen: scene ready + ambient registered (with a hard fallback)
  const loading = document.getElementById('loading');
  const dismiss = () => {
    if (!loading) return;
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 600);
  };
  dismiss();
  setTimeout(dismiss, 6000);

  log.info('Worldsmith booted');
}

whenSceneReady().then(boot);

// Dev-only hook: feed a canned envelope through the full pipeline without an
// API key, e.g. __worldsmith.test({action:"create_world",markup:"<a-box .../>",removed_ids:[],narration:"test"})
window.__worldsmith = {
  injector,
  submitPrompt,
  test: (envelope) => injector.applyResponse(
    typeof envelope === 'string' ? JSON.parse(envelope) : envelope,
    { mrMode: session.mode === 'ar' }
  )
};
