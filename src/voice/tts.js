import { emit } from '../core/bus.js';
import { log } from '../core/log.js';

let muted = false;

export function setMuted(m) {
  muted = !!m;
  if (muted && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

export function isMuted() {
  return muted;
}

export function isTTSAvailable() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// Speaks narration when TTS is available and unmuted; otherwise (or on
// failure) shows the floating caption instead so the user never misses it.
export function speak(text, { caption } = {}) {
  const value = String(text || '').trim();
  if (!value) return;
  if (isTTSAvailable() && !muted) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(value);
      u.rate = 1.05;
      u.pitch = 1;
      u.onstart = () => emit('mic:state', 'speaking');
      u.onend = () => emit('mic:state', 'idle');
      u.onerror = () => emit('mic:state', 'idle');
      speechSynthesis.speak(u);
      return;
    } catch (e) {
      log.warn('TTS failed:', e.message);
    }
  }
  if (caption) caption(value);
}
