# Worldsmith — Voice-Prompted Generative A-Frame WebXR Worlds: Implementation Plan

The user's spec (sections 1–10 of the prompt) is the authoritative requirements document. This plan resolves the remaining implementation decisions, pins versions, defines the internal contracts between modules, and orders the work. Nothing in the spec is descoped except where explicitly noted under "Decisions".

## Context

- Workspace: **empty git repo** (no commits, only `.git/` and `.kilo/`). Project is created **at the repo root**.
- Verified environment: Node v22.22.3, npm 10.9.8, network available.
- Verified registry versions: `aframe@1.8.0` (has ESM `exports` → `dist/aframe-master.module.min.js`, imports cleanly under Vite), `vite@8.2.2`, `@vitejs/plugin-basic-ssl@2.3.0`.
- Verified `deepseek/deepseek-v4-flash` exists on OpenRouter's live model catalog (checked `GET /api/v1/models`).

## Key decisions

1. **Stack pins**: `aframe: ^1.8.0`, `vite: ^8.2.2` (devDep), `@vitejs/plugin-basic-ssl: ^2.3.0` (devDep, gives self-signed HTTPS so Quest browsers can load the dev server over LAN). `package.json` `"type": "module"`. Scripts: `dev` (`vite --host`), `build`, `preview` (`vite preview --host`). No other runtime deps.
2. **A-Frame load**: single `import 'aframe'` in `src/main.js` before any module that touches `AFRAME` or scene elements. `index.html` contains the static scene shell; no CDN script tags anywhere.
3. **World state source of truth = injector's in-memory map**, not the DOM. A-Frame mutates entity attributes as components/animations run, so `innerHTML` serialization would bloat/garbage the LLM context. `injector.js` keeps `Map<id, cleanMarkup>`; LLM context = join of clean markups (truncate at 12,000 chars with a `[truncated]` marker appended to the user message).
4. **Sanitizer policy (two-tier)**:
   - *Reject entire response* (throw `SanitizeError` → user-facing error, world unchanged): any `<script>/<style>/<link>/<img>/<video>/<audio>/<iframe>`; any attribute starting with `on`; `gltf-model`, `obj-model`, or `src` attributes whose value is not exactly `#generated-ambient`; any attribute not in the whitelist that looks like a component with non-whitelisted name (custom components); malformed/duplicate ids.
   - *Strip + log* (continue): unknown-but-harmless attributes; tags not in whitelist but visually inert. Numerically clamp `position` components to ±100 and `scale` to ≤50 per axis (cheap regex on `x y z` triplets).
   - Whitelisted tags: `a-entity, a-box, a-sphere, a-cylinder, a-cone, a-plane, a-circle, a-ring, a-torus, a-tetrahedron, a-octahedron, a-dodecahedron, a-icosahedron, a-sky, a-light, a-text`. Whitelisted attributes: `id, class (only value "interactive"), position, rotation, scale, visible, color, opacity, transparent, side, metalness, roughness, emissive, emissive-intensity, shader, width, height, depth, radius, radius-bottom, radius-top, radius-tubular, segments-radial, segments-tubular, segments-height, segments-width, segments-theta, segments-phi, segments-detail, theta-length, theta-start, phi-start, open-ended, arc, p-ratio, radius-inner, radius-outer, value, align, anchor, baseline, wrap-count, letter-spacing, font (only client-vendored font paths), animation, animation__*, light, sound, text, geometry, material, fog`. `class` may only contain `interactive`; anything else → reject.
   - `fog` is scene-level in A-Frame: sanitizer extracts any top-level `fog` attribute, strips it from entities, and the injector applies it to the `<a-scene>` via `setAttribute('fog', …)`.
   - `<a-sky>`: stripped when MR mode is active (sanitizer gets `stripSky` flag); kept otherwise.
   - Missing `id` on an entity → auto-assign `gen-<counter>`; duplicate ids within one response → suffix `-2`, `-3`.
5. **Entity budget**: injector counts nodes (self + descendants) about to be added plus current count; if > 200, reject the whole response with error "World budget exceeded (max 200 entities)".
6. **Merge semantics** (per spec §5): `create_world` → clear `#generated-world` + map, insert sanitized top-level nodes. `update_world` → per top-level element: existing id ⇒ replace DOM node + map entry; new id ⇒ append; `removed_ids` ⇒ delete from DOM + map (unknown ids ignored, logged).
7. **Transitions**: client adds `animation__spawn` (scale 0.001 → entity's own scale or 1 1 1, dur 600, `easeOutBack`) to each *new* top-level entity only when it has no own `animation` targeting `scale`. No fade (avoids material-attr conflicts).
8. **Undo**: stack (max 10) of full-world snapshots = serialized clean map string, pushed before every mutation (apply-response, grab-delete, reset). Undo pops → `create_world`-style restore. The grab+squeeze "3-second undo toast" surfaces the same pop.
9. **Locomotion = custom components** (not `movement-controls`), registered in `src/xr/controllers.js`: `smooth-locomotion` (left `thumbstickmoved` → move rig along camera-forward/right, Y-flattened), `snap-turn` (right `thumbstickmoved`, |x|>0.7, 45°, 350 ms cooldown), `comfort-vignette` (black open-ended cylinder around camera; opacity follows speed/turn; toggleable). Desktop gets stock `wasd-controls` on the rig + `look-controls` on camera.
10. **Grab**: `grab` component in `src/xr/grab.js` on the right controller. Trigger down over `.interactive` (shared raycaster) → reparent to controller preserving world transform; trigger up → release, and write the entity's final `position` back into its clean-markup map entry so subsequent LLM updates preserve user placement. Trigger held + squeeze (`gripdown`) → delete with 3-second undo toast. Suppress click handling when a grab started this press.
11. **OpenRouter client** (`src/llm/openrouter.js`): `POST /api/v1/chat/completions`, `response_format: {type:'json_object'}`, `temperature: 0.7`, `max_tokens: 16384` (a 100–200-entity `create_world` easily exceeds 4k output tokens; 16384 stays within the caps of all dropdown models). Headers: `Authorization: Bearer <key>`, optional `HTTP-Referer`, `X-Title` from settings. **Retry/parse matrix** (each request runs through it in order; at most one retry of each kind):
    - `finish_reason === "length"` → no retry, fail with "World too large for one response — try a smaller change or add fewer things at once." World unchanged.
    - 429/5xx → retry once with exponential backoff (800 ms → 1600 ms), same body.
    - 400 whose error body mentions `max_tokens` (model-specific output cap) → retry once with `max_tokens: 8192` before falling into the `response_format` fallback below.
    - 400 whose error body mentions `response_format`/`json_object`, OR a 200 whose content fails JSON.parse after fence-stripping → retry once **without** `response_format`, then extract JSON more aggressively (first balanced `{…}` block scan) before giving up.
    - Envelope shape validation (`action`/`markup`/`removed_ids`/`narration`) after parse; failure ⇒ "The model returned an invalid world" + log raw content when diagnostics on.
    - Status→message mapping: 401/403 ⇒ "OpenRouter rejected your key"; 429/5xx after retry ⇒ "OpenRouter is busy, try again"; network ⇒ "Cannot reach OpenRouter". Key validation: `GET /api/v1/auth/key` (minimal, cheap).
12. **Model setting**: dropdown defaults `deepseek/deepseek-v4-flash` (default), `deepseek/deepseek-chat`, `openai/gpt-4o-mini`, `anthropic/claude-3.5-haiku`, `google/gemini-2.5-flash`, `meta-llama/llama-3.3-70b-instruct` + free-text override field.
13. **Ambient audio** (`src/audio/ambient.js`): 8-second loop rendered with `OfflineAudioContext` (filtered noise bed + two detuned sine pads + slow LFO swell, edge-crossfaded for seamless loop), encoded to 16-bit PCM WAV via a small in-file encoder, appended as `<audio id="generated-ambient" src=<blobURL> loop preload="auto">` into `<a-assets>` **before** `sceneEl` finishes load (await `hasLoaded` / use `loaded` event ordering; if late, re-trigger asset load). Autoplay needs a user gesture — first trigger press / UI click calls `.play()` on the element.
14. **Fonts**: A-Frame's `text` default font is a CDN fetch (violates "no external assets"). Vendor `Roboto-msdf.json` + `Roboto-msdf.png` into `public/fonts/` at implementation time (download once, commit), then set `AFRAME.components.text.schema.font.default = 'fonts/Roboto-msdf.json'` after the aframe import. If the download fails in this environment, keep the CDN default with a TODO comment (only acceptable exception).
15. **MR mode**: `src/xr/session.js` checks `navigator.xr.isSessionSupported('immersive-ar')` → only then show MR toggle (DOM + wrist panel). Entering MR: `sceneEl.enterAR()`, hide `#default-sky`, add `body.mr` class (transparent canvas CSS), sanitizer `stripSky = true`, system prompt gets the no-sky/no-ground variant. Scene attrs: `renderer="antialias: true; colorManagement: true; alpha: true"`; escape hatch after load: `sceneEl.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))`. Quest 2 grayscale-passthrough note + "v2: plane detection/anchors" as commented extension point in `session.js`.
16. **Storage**: `src/storage/localProvider.js` exports an async `StorageProvider` interface object (get/set/remove + domain methods: settings, world, history, savedWorlds) implemented over `localStorage` with JSON; a leading comment marks it as the single swap point for a future backend (e.g. Convex). Settings schema: `{apiKey, model, httpReferer, xTitle, muteTTS, vignette, diagnostics}`. History: last 20 `{prompt, ts, narration}`. Saved worlds: `[{name, ts, markup}]`. Export file `.worldsmith.json`: `{version: 1, settings (minus apiKey), history, savedWorlds}`. Import: file picker (2D), schema validation (`version` field + shape checks), user chooses merge or replace.
17. **Voice plumbing**: `src/voice/speech.js` — feature-detect `SpeechRecognition|webkitSpeechRecognition` at startup; press-and-hold (mic orb or controller trigger via orb) starts/stops; runtime errors (`no-speech` ignored, `not-allowed`/service errors) fall back to opening the VR keyboard. `src/voice/tts.js` — `speechSynthesis` when available and not muted; else floating caption entity `#caption` (billboarded, 5 s). `src/voice/keyboardVR.js` — ray-interactive QWERTY panel (`#vk-root`, 3 rows + space/backspace/send/close), buffer display, "Send" dispatches the prompt.
18. **Dreaming swirl**: `dreaming-swirl` component (registered in `src/main.js` or `src/ui/`): a single `THREE.Points` escape hatch (~300 points, swirl in tick) on `#dreaming`, toggled visible while awaiting the LLM. This and the pixel-ratio cap are the sanctioned Three.js escape hatches.
19. **Wrist panel** (`src/ui/panelVR.js`): child of left controller, billboarded to camera, buttons as raycastable `.clickable` planes + a-text: Listen, Keyboard, Settings, History (last 20, tap to re-run), Undo, Export (blob download), Import (exits VR → DOM file picker → optionally re-enter), Reset World, MR toggle (if supported). Sub-panels: Settings (API key via VR keyboard, model cycle, Validate key, Mute, Vignette), History list.
20. **Diagnostics**: `src/core/log.js` — leveled logger enabled by settings flag or `?debug=1`; logs sanitizer drops, retries, timings. Global error boundary in `main.js` (`error` + `unhandledrejection` → toast + log). Loading overlay removed on scene `loaded` + ambient registered.
21. **Small additions to the spec's file list** (justified, minimal): `src/core/log.js`, `src/core/bus.js` (shared `EventTarget` for `llm:start/llm:success/llm:error/world:changed/settings:changed/mode:changed/mic:state`), `src/style.css`. Everything else exactly per spec §9.

## Scene shell & wiring contract (index.html)

- `<a-scene vr-mode-ui="enabled: false" device-permission-ui="enabled: false" loading-screen="enabled: false" renderer="antialias: true; colorManagement: true; alpha: true">`
- `<a-assets>` ← `<audio id="generated-ambient">` injected at runtime.
- Lights: `<a-entity id="world-lights">` (ambient 0.6 + directional 0.5, no shadows) — these live *outside* `#generated-world` so `create_world` can't remove them.
- `#default-sky` (client-owned, muted color; hidden in MR).
- `#rig` (position 0 0 0, `wasd-controls`) → `#camera` (position 0 1.6 0, `look-controls`, child `#vignette`).
- `#ctl-left` (`oculus-touch-controls hand: left` + `smooth-locomotion`) with `#wrist-panel` child; `#ctl-right` (`oculus-touch-controls hand: right`, `laser-controls`, `raycaster="objects: .clickable, .interactive"`, `snap-turn`, `grab`).
- `#mic-orb` + `#caption` positioned in front of rig, `face-camera` component; `#dreaming`; `#vk-root` (hidden); `#generated-world` (empty).
- **Mic-orb state machine** (client-owned, implemented in `src/ui/panelVR.js`; spec §6): driven by `mic:state` bus events (`idle | listening | thinking | speaking`). Visual = material `color` + pulsing scale via a client-added `animation__pulse="property: scale; from: 1 1 1; to: 1.15 1.15 1.15; dur: 900; dir: alternate; loop: true; easing: easeInOutSine"` attribute toggled on/off per state: idle = dim blue, no pulse; listening = green + pulse; thinking = purple + pulse (also while `llm:start`…`llm:done`); speaking = cyan, no pulse. Press-and-hold the orb (DOM or laser `mousedown`/`mouseup`) toggles listening.
- DOM overlay: header with Enter VR / MR buttons, prompt textarea + Send + Mic (hidden if no SpeechRecognition), collapsible panels: Settings (API key, model dropdown+custom, validate, HTTP-Referer, X-Title, mute, vignette, diagnostics), History, Saved Worlds (save/load/delete), Export/Import file input, Undo, Reset. Toast area. Loading overlay.

## System prompt contract (src/llm/systemPrompt.js)

`buildSystemPrompt({mrMode})` returns the editable constant implementing spec §5 verbatim: JSON-only envelope, tag/component whitelist, `#generated-ambient` as the only `src` token, unique-id requirement, `class="interactive"` for grabbables, animation-via-`animation`-component only, limits (≤200 entities, ±100 m positions, ≤50 m scale, low-poly segments), MR variant adds "no sky, no ground planes" and `create_world`/`update_world` semantics + one small example envelope.

## Task order

1. Scaffold: `package.json`, `vite.config.js` (base `'./'`, basic-ssl plugin, `server.host`), `index.html` shell + `src/style.css`, `src/main.js` minimal boot (loading overlay off on `loaded`).
2. `src/core/log.js`, `src/core/bus.js`, `src/storage/localProvider.js`, `src/storage/exportImport.js`.
3. `src/world/sanitize.js` → `src/world/injector.js` (map, merge, undo stack, transitions, fog/sky handling, budget).
4. `src/audio/ambient.js` (OfflineAudioContext + WAV encoder + asset registration).
5. `src/llm/systemPrompt.js` → `src/llm/openrouter.js` (call, retry, envelope validation, key validation).
6. `src/voice/speech.js`, `src/voice/tts.js`, `src/voice/keyboardVR.js`.
7. `src/xr/session.js` (VR/AR support detection, mode switching), `src/xr/controllers.js` (locomotion/snap-turn/vignette components), `src/xr/grab.js`.
8. `src/ui/dom.js` (2D UI logic) and `src/ui/panelVR.js` (wrist panel, mic orb states, VR settings/history).
9. Wire the shared prompt pipeline in `main.js`: input → guard(apiKey) → dreaming on → compact world context → openrouter → sanitize → inject → TTS/caption → history/undo → dreaming off; error paths surface in VR caption + DOM toast.
10. Vendor fonts into `public/fonts/`; README.md (setup `npm install && npm run dev`, OpenRouter key steps, device notes: Quest 2/3/Pro via Meta Quest Browser, HTTPS requirement, Quest 2 grayscale passthrough, SpeechRecognition keyboard fallback, performance budget notes).
11. Validation (below); fix and re-run.

## Validation plan

- `npm install && npm run build` must succeed (catches bundling/ESM issues with aframe 1.8).
- `npm run dev` (HTTPS via basic-ssl) → fetch page, confirm 200 and no import errors in build log.
- Desktop Chrome smoke checklist: loading overlay clears; default sky + lights render; prompt "create a small floating island" with a real key → world appears with scale-in transition; update prompt merges by id; narration spoken; history/undo/saved-world/export/import work; `?debug=1` shows sanitizer logs.
- Non-LLM sanity: temporarily feed a canned JSON envelope through the pipeline to test sanitizer/injector without a key (small dev-only console hook).
- Quest checklist (manual, documented in README): open via `https://<lan-ip>:5173`, accept self-signed cert, Enter VR; thumbstick locomotion + snap turn; trigger-hold mic → keyboard fallback when SpeechRecognition unavailable; grab/delete + undo toast; wrist panel actions; MR toggle appears only if `immersive-ar` supported, sky stripped, passthrough visible (grayscale on Quest 2).
- Performance spot-check: entity count guard rejects >200; pixel ratio capped; no shadows.

## Risks / notes

- aframe 1.8 ESM under Vite is expected to be clean (verified `exports` map); if dev-time `optimizeDeps` hiccups occur, add `optimizeDeps: { include: ['aframe'] }`.
- `speechSynthesis`/WebAudio autoplay require a user gesture — first interaction primes them.
- Quest Browser SpeechRecognition may exist but fail at runtime; all failure paths must route to the VR keyboard (never dead-end input).
- In-VR Import cannot open a file picker inside an immersive session — the button exits VR, opens the picker, then offers re-entry (documented in README).
- If the sandbox cannot fetch the Roboto MSDF font files, fall back to A-Frame's CDN default font with a comment (only runtime network dependency, framework default).
- Out of scope (commented extension points): plane detection/anchors for MR, backend `StorageProvider` (e.g. Convex), streaming responses (off by default per spec).
