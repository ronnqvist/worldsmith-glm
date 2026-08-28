import { emit } from '../core/bus.js';
import { log } from '../core/log.js';

// VR/AR session management. immersive-vr is the default; immersive-ar
// (passthrough) is opt-in and only offered when the browser supports it.
//
// Extension point (v2): plane detection / anchors belong here — request
// 'hit-test' and 'anchors' as optionalFeatures and expose detected surfaces to
// the injector so generated content can snap to real-world planes.

export function initSession(sceneEl) {
  const state = { mode: 'desktop', arSupported: false, stripSky: false };

  function capPixelRatio() {
    // Quest 2 performance budget (spec §2): never render above 1.5x density
    if (sceneEl.renderer) {
      sceneEl.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    }
  }
  if (sceneEl.hasLoaded) capPixelRatio();
  else sceneEl.addEventListener('loaded', capPixelRatio, { once: true });

  if (navigator.xr && typeof navigator.xr.isSessionSupported === 'function') {
    navigator.xr.isSessionSupported('immersive-ar')
      .then((supported) => {
        state.arSupported = !!supported;
        log.info('immersive-ar supported:', supported);
        emit('xr:ar-supported', state.arSupported);
      })
      .catch(() => emit('xr:ar-supported', false));
  }

  function enterMrVisuals() {
    document.body.classList.add('mr');
    state.stripSky = true;
    if (sceneEl.renderer) sceneEl.renderer.setClearColor(0x000000, 0);
    const sky = sceneEl.querySelector('#default-sky');
    if (sky) sky.setAttribute('visible', 'false');
  }

  function exitMrVisuals() {
    document.body.classList.remove('mr');
    state.stripSky = false;
    if (sceneEl.renderer) sceneEl.renderer.setClearColor(0x000000, 1);
    emit('mr:exited');
  }

  // A-Frame emits enter-vr/exit-vr for both modes and flags AR via the
  // 'ar-mode' scene state — there are no separate enter-ar/exit-ar events.
  sceneEl.addEventListener('enter-vr', () => {
    if (sceneEl.is('ar-mode')) {
      state.mode = 'ar';
      enterMrVisuals();
      emit('xr:mode', 'ar');
    } else {
      state.mode = 'vr';
      emit('xr:mode', 'vr');
    }
  });
  sceneEl.addEventListener('exit-vr', () => {
    const wasAr = state.mode === 'ar';
    state.mode = 'desktop';
    if (wasAr) exitMrVisuals();
    emit('xr:mode', 'desktop');
  });

  async function enterVR() {
    try {
      await sceneEl.enterVR();
      return true;
    } catch (e) {
      log.warn('enterVR failed:', e && e.message);
      emit('xr:error', 'Could not start the VR session');
      return false;
    }
  }

  async function enterMR() {
    try {
      await sceneEl.enterAR();
      return true;
    } catch (e) {
      log.warn('enterAR failed:', e && e.message);
      emit('xr:error', 'Could not start the passthrough (MR) session');
      return false;
    }
  }

  function exit() {
    // A-Frame ends both vr and ar sessions via exitVR
    if (state.mode === 'ar' || state.mode === 'vr') sceneEl.exitVR();
  }

  return {
    enterVR,
    enterMR,
    exit,
    get mode() { return state.mode; },
    get arSupported() { return state.arSupported; },
    get stripSky() { return state.stripSky; }
  };
}
