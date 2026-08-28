// Procedurally generates one short ambient loop with the Web Audio API at
// startup, encodes it to a WAV blob, and registers it as an <audio> asset with
// id "generated-ambient" so LLM markup may reference `sound="src: #generated-ambient"`.

const SAMPLE_RATE = 44100;
const DURATION = 8;
const ASSET_ID = 'generated-ambient';

function encodeWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length * numChannels * 2 + 44;
  const out = new ArrayBuffer(length);
  const view = new DataView(out);
  let pos = 0;

  const writeStr = (s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(pos++, s.charCodeAt(i));
  };

  writeStr('RIFF');
  view.setUint32(pos, length - 8, true); pos += 4;
  writeStr('WAVE');
  writeStr('fmt ');
  view.setUint32(pos, 16, true); pos += 4;
  view.setUint16(pos, 1, true); pos += 2;          // PCM
  view.setUint16(pos, numChannels, true); pos += 2;
  view.setUint32(pos, buffer.sampleRate, true); pos += 4;
  view.setUint32(pos, buffer.sampleRate * numChannels * 2, true); pos += 4;
  view.setUint16(pos, numChannels * 2, true); pos += 2;
  view.setUint16(pos, 16, true); pos += 2;
  writeStr('data');
  view.setUint32(pos, length - pos - 4, true); pos += 4;

  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true); pos += 2;
    }
  }
  return out;
}

async function renderAmbientLoop() {
  const ctx = new OfflineAudioContext(1, SAMPLE_RATE * DURATION, SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = 0.16;
  master.connect(ctx.destination);

  // filtered noise bed
  const noiseLen = SAMPLE_RATE * DURATION;
  const noiseBuf = ctx.createBuffer(1, noiseLen, SAMPLE_RATE);
  const data = noiseBuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < noiseLen; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02; // brown-ish
    data[i] = last * 3.5;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 320;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.5;
  noise.connect(noiseFilter).connect(noiseGain).connect(master);

  // slow swell on the noise bed
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.1;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.25;
  lfo.connect(lfoGain).connect(noiseGain.gain);

  // two detuned sine pads for a soft drone
  const padFreqs = [110, 165.2, 220.5];
  for (const f of padFreqs) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    osc.connect(g).connect(master);
    osc.start(0);
    osc.stop(DURATION);
  }

  noise.start(0);
  lfo.start(0);

  const rendered = await ctx.startRendering();
  const ch = rendered.getChannelData(0);
  const edge = SAMPLE_RATE;
  for (let i = 0; i < edge; i++) {
    const t = i / edge;
    ch[i] *= t;                    // fade-in head
    ch[ch.length - 1 - i] *= t;    // fade-out tail
  }
  return rendered;
}

export async function setupAmbient(sceneEl) {
  let url;
  try {
    const buffer = await renderAmbientLoop();
    const blob = new Blob([encodeWav(buffer)], { type: 'audio/wav' });
    url = URL.createObjectURL(blob);
  } catch (err) {
    console.warn('[worldsmith] ambient generation failed, continuing without it', err);
    return null;
  }

  const audio = document.createElement('audio');
  audio.id = ASSET_ID;
  audio.src = url;
  audio.preload = 'auto';
  audio.loop = true;
  audio.crossOrigin = 'anonymous';

  let assets = sceneEl.querySelector('a-assets');
  if (!assets) {
    assets = document.createElement('a-assets');
    sceneEl.appendChild(assets);
  }
  assets.appendChild(audio);

  // If the scene already finished loading, nudge A-Frame so late asset
  // registrations are picked up by sound components resolving #id later.
  if (sceneEl.hasLoaded && typeof assets.load === 'function') {
    try { assets.load(); } catch { /* non-fatal */ }
  }
  return audio;
}

// Autoplay policies gate audio behind a user gesture; prime the ambient
// element and any A-Frame AudioListener on the first interaction so LLM-added
// sound components can play afterwards.
export function primeAudio(sceneEl) {
  const audio = document.getElementById(ASSET_ID);
  if (audio) {
    const p = audio.play();
    if (p && p.catch) p.catch(() => { /* still locked; a later gesture retries */ });
  }
  const listener = sceneEl.audioListener;
  if (listener && listener.context && listener.context.state === 'suspended') {
    listener.context.resume();
  }
}
