// Web Speech API wrapper with graceful failure. Quest Browser may expose
// SpeechRecognition but fail at runtime; every failure path reports back so the
// caller can route to the in-VR keyboard instead.

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

export function isSpeechSupported() {
  return !!SR;
}

export class VoiceInput {
  constructor() {
    this.listening = false;
    this.broken = false; // set when the engine exists but denies/fails hard
  }

  // Hold-to-talk: resolve() fires on release with the final transcript.
  // onPartial receives interim text for live feedback.
  start({ onPartial } = {}) {
    if (this.listening) return Promise.resolve('');
    if (!SR || this.broken) return Promise.reject(new Error('speech-unavailable'));

    return new Promise((resolve, reject) => {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';
      this.listening = true;

      let finalText = '';
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.listening = false;
        this._rec = null;
        resolve(value);
      };

      rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (onPartial) onPartial(finalText + interim);
      };

      rec.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        this.broken = true;
        if (!settled) {
          settled = true;
          this.listening = false;
          this._rec = null;
          reject(new Error(event.error === 'not-allowed' || event.error === 'service-not-allowed'
            ? 'Microphone permission denied'
            : `Speech recognition failed: ${event.error}`));
        }
      };

      rec.onend = () => finish(finalText.trim());

      this._rec = rec;
      try {
        rec.start();
      } catch (e) {
        this.broken = true;
        this.listening = false;
        reject(new Error('Speech recognition could not start'));
      }
    });
  }

  stop() {
    if (this._rec) {
      try { this._rec.stop(); } catch { /* already ended */ }
    }
    // onend resolves the pending promise
  }
}
