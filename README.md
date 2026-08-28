# Worldsmith

Voice-prompted generative **A-Frame WebXR worlds**. Speak or type a prompt —
"create a floating island with waterfalls and glowing crystals" — and an LLM
returns pure A-Frame markup that is sanitized and injected into the scene live,
in VR or on desktop.

- **Rendering**: A-Frame 1.8 (only rendering framework; Three.js is touched only
  through two small client-side escape hatches: the pixel-ratio cap and the
  renderer clear color in MR mode).
- **LLM**: OpenRouter (`deepseek/deepseek-v4-flash` by default, configurable).
  The model outputs a strict JSON envelope containing declarative A-Frame
  markup — never JavaScript, never CSS, no external assets.
- **Voice**: Web Speech API when available; a fully ray-interactive in-VR
  keyboard otherwise. There is always an input path.
- **Storage**: local only (`localStorage`) behind an async `StorageProvider`
  interface, ready to swap for a backend later.

## Setup

```bash
npm install
npm run dev
```

Vite serves the app at `https://<your-lan-ip>:5173` (self-signed HTTPS via
`@vitejs/plugin-basic-ssl` — WebXR requires a secure context, so plain HTTP
will not expose XR). For a production build: `npm run build && npm run preview`.

### Getting an OpenRouter key

1. Create an account at <https://openrouter.ai/>.
2. Open **Keys** and create a key (`sk-or-v1-...`).
3. In Worldsmith open **Settings** (2D side panel, or wrist panel → Settings in
   VR) and paste the key. Use **Validate key** to confirm.
4. Optional: set `HTTP-Referer` / `X-Title` headers and pick another model
   (dropdown or custom id).

The key is stored **only** in `localStorage` and sent **only** to
`openrouter.ai`. It is never included in the export file.

## Using the app

- **Desktop (no headset)**: drag to look, `WASD` to move, type in the prompt
  box or hold **Hold to talk** (if the browser supports SpeechRecognition).
  The full side-panel UI mirrors every VR feature.
- **VR (Quest 2/3/Pro via Meta Quest Browser)**: click **Enter VR**. Smooth
  locomotion on the **left thumbstick**, 45-degree snap turn on the **right**,
  comfort vignette while moving (toggle in Settings).
  - **Hold the trigger while pointing at empty space** (or hold the floating
    mic orb) to talk; release to send. Tapping **Listen** on the wrist panel
    toggles the same thing.
  - Point at a `class="interactive"` object, hold trigger to grab, release to
    drop; **squeeze (grip) while holding to delete** — a 3-second undo toast
    appears.
  - The **wrist panel** (left hand) has Listen, Keyboard, Settings, History,
    Undo, Export, Import, Reset and MR (when supported).
- **Mixed reality passthrough**: if `immersive-ar` is supported, the **MR
  mode** toggle appears in the 2D header and on the wrist panel. In MR the
  client strips any `<a-sky>` and instructs the model not to emit skies or
  ground planes.

### In-VR keyboard

The Quest Browser's SpeechRecognition support is unreliable or absent. When it
is missing (or fails at runtime) the mic orb opens a ray-interactive QWERTY
panel with a large Send button — the app never leaves you without an input
path.

## Devices notes

- **Quest 2/3/Pro**: use the Meta Quest Browser. Navigate to
  `https://<your-lan-ip>:5173`, accept the self-signed certificate warning,
  then Enter VR.
- **HTTPS is required** for WebXR (and for microphone access).
- **Quest 2 passthrough is grayscale** (color on Quest 3/Pro) — do not rely on
  real-world color cues in MR mode.
- **No plane detection or anchors in v1** — the session module marks the
  extension point (`src/xr/session.js`).
- **Performance budget (XR2-class GPU)**: max ~200 generated entities
  (enforced client-side), low-poly geometry defaults, no real-time shadows,
  pixel ratio capped at 1.5. Prompt latencies are masked by the "dreaming"
  particle swirl.

## Data & persistence

- `localStorage` holds settings (including the API key), the current world
  markup, the last 20 prompts, and named saved worlds.
- **Export** downloads one `.worldsmith.json` (settings *minus* API key,
  history, saved worlds, current world). **Import** validates the schema and
  offers replace or merge. In VR, Import hops to the 2D panel because file
  pickers cannot open inside an immersive session.
- Storage sits behind `src/storage/localProvider.js` — the single swap point
  for a future backend (e.g. Convex).

## Architecture

```
index.html                  static <a-scene> shell: rig, controllers, #generated-world, lights, assets
src/main.js                 boot + prompt pipeline wiring
src/core/log.js             toggleable diagnostics logger (?debug=1 or Settings)
src/core/bus.js             app event bus
src/xr/session.js           immersive-vr / immersive-ar sessions, MR visuals
src/xr/controllers.js       smooth-locomotion, snap-turn, comfort-vignette, face-camera, dreaming-swirl
src/xr/grab.js              grab / drop / squeeze-delete
src/world/injector.js       sanitize+inject+merge-by-id+undo stack
src/world/sanitize.js       whitelist sanitizer (rejects forbidden markup)
src/audio/ambient.js        procedural ambient loop -> #generated-ambient asset
src/llm/openrouter.js       OpenRouter client (retries, JSON recovery, key validation)
src/llm/systemPrompt.js     editable system prompt + model list
src/voice/speech.js         Web Speech API wrapper with graceful failure
src/voice/keyboardVR.js     in-VR QWERTY keyboard
src/voice/tts.js            speechSynthesis narration + caption fallback
src/ui/panelVR.js           wrist panel, mic orb states, caption, undo toast
src/ui/dom.js               2D overlay UI
src/storage/localProvider.js async StorageProvider over localStorage
src/storage/exportImport.js export/import (.worldsmith.json)
```

The LLM output contract (JSON envelope, whitelisted tags/components, id rules,
limits) is documented in `src/llm/systemPrompt.js` and enforced twice: by the
prompt and by the whitelist sanitizer in `src/world/sanitize.js`. Raw model
output is never injected unsanitized.

## Debugging

Add `?debug=1` to the URL or tick **Diagnostics logging** in Settings for
sanitizer drop logs, retry logs and LLM timings. A dev-only console hook,
`window.__worldsmith.test(envelope)`, feeds a canned JSON envelope through the
sanitize/inject pipeline without an API key.
