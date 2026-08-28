// Whitelist-based sanitizer for LLM-generated A-Frame markup.
//
// Two tiers, per the Worldsmith spec:
//  - FORBIDDEN things (script tags, event handlers, network URLs, non-ambient
//    media srcs) abort the whole response via SanitizeError.
//  - Merely unknown-but-harmless tags/attributes are stripped with a warning.

const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'link', 'img', 'video', 'audio', 'iframe', 'object', 'embed', 'base', 'meta'
]);

const ALLOWED_TAGS = new Set([
  'a-entity', 'a-box', 'a-sphere', 'a-cylinder', 'a-cone', 'a-plane', 'a-circle',
  'a-ring', 'a-torus', 'a-tetrahedron', 'a-octahedron', 'a-dodecahedron',
  'a-icosahedron', 'a-sky', 'a-light', 'a-text'
]);

const ALLOWED_ATTRS = new Set([
  // universal
  'id', 'class', 'position', 'rotation', 'scale', 'visible', 'fog', 'src',
  // material-ish (also exposed as primitive attributes)
  'color', 'opacity', 'transparent', 'side', 'metalness', 'roughness', 'emissive',
  'emissive-intensity', 'shader', 'repeat',
  // geometry primitive parameters
  'width', 'height', 'depth', 'radius', 'radius-bottom', 'radius-top',
  'radius-tubular', 'radius-inner', 'radius-outer', 'p-ratio',
  'segments-radial', 'segments-tubular', 'segments-height', 'segments-width',
  'segments-theta', 'segments-phi', 'segments-detail',
  'theta-length', 'theta-start', 'phi-start', 'open-ended', 'arc',
  // built-in components (multi-prop values)
  'geometry', 'material', 'light', 'sound', 'text',
  // a-light parameters
  'type', 'intensity', 'angle', 'penumbra', 'distance', 'decay', 'ground-color',
  // a-text parameters
  'value', 'align', 'anchor', 'baseline', 'wrap-count', 'letter-spacing', 'z-offset', 'font'
]);

const ANIMATION_ATTR_RE = /^animation(__[a-z0-9_-]+)?$/;
const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const VEC3_RE = /^\s*(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)\s*$/;
const SOUND_SRC_RE = /(^|;)\s*src\s*:\s*([^;]+)/i;
const FORBIDDEN_VALUE_RE = /javascript:|https?:\/\/|data:|url\(/i;

// ids owned by the client shell; generated entities may never take these
export const RESERVED_IDS = new Set([
  'generated-world', 'generated-ambient', 'rig', 'camera', 'ctl-left', 'ctl-right',
  'wrist-panel', 'vk-root', 'mic-orb', 'caption', 'caption-text', 'vignette',
  'dreaming', 'default-sky', 'world-lights', 'vr-toast'
]);

export const AMBIENT_SRC = '#generated-ambient';

export class SanitizeError extends Error {}
export class BudgetError extends Error {}

function checkId(raw, usedIds, genId) {
  let id = String(raw || '').trim();
  if (!id) id = genId();
  if (!ID_RE.test(id)) {
    id = 'id-' + id.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[-0-9]+/, '');
    if (!ID_RE.test(id)) id = genId();
  }
  if (RESERVED_IDS.has(id)) id = id + '-w';
  while (usedIds.has(id)) id = id + '-2';
  usedIds.add(id);
  return id;
}

// Clamps "x y z" numeric triplets: position within ±100 m, scale 0.001..50 m.
function clampVec3(value, min, max) {
  const m = VEC3_RE.exec(value);
  if (!m) return value;
  const c = (v) => Math.min(max, Math.max(min, parseFloat(v)));
  return `${c(m[1])} ${c(m[2])} ${c(m[3])}`;
}

function checkAttrValue(name, value) {
  if (FORBIDDEN_VALUE_RE.test(value)) {
    throw new SanitizeError(`Forbidden URL/data reference in attribute "${name}"`);
  }
  if (name === 'src' && value.trim() !== AMBIENT_SRC) {
    throw new SanitizeError(`Only the ambient loop (#generated-ambient) may be used as src`);
  }
  if (name === 'sound') {
    const m = SOUND_SRC_RE.exec(value);
    if (m && m[2].trim() !== AMBIENT_SRC) {
      throw new SanitizeError('sound src may only reference #generated-ambient');
    }
  }
  if (name === 'font' && !(value.trim().startsWith('fonts/') || value.trim().startsWith('#'))) {
    throw new SanitizeError('font must reference a vendored local font');
  }
  if (name === 'class') {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (t !== 'interactive') throw new SanitizeError(`class may only contain "interactive"`);
    }
  }
}

// Parses markup and returns fully-normalized detached elements ready to attach,
// their clean serialized HTML, plus any top-level fog directive.
export function parseAndSanitize(markup, { stripSky = false, genId = () => 'gen-' + Math.random().toString(36).slice(2, 8) } = {}) {
  const warnings = [];
  const elements = [];
  let fog = null;

  if (typeof markup !== 'string' || !markup.trim()) {
    return { elements, fog, warnings };
  }

  let doc;
  try {
    doc = new DOMParser().parseFromString(markup, 'text/html');
  } catch {
    throw new SanitizeError('Markup could not be parsed');
  }

  const usedIds = new Set();
  const rootFragment = document.createDocumentFragment();

  const walk = (sourceEl, parentTarget, isTopLevel) => {
    for (const node of Array.from(sourceEl.childNodes)) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue; // text/comments are dropped

      const tag = node.tagName.toLowerCase();

      if (FORBIDDEN_TAGS.has(tag)) {
        throw new SanitizeError(`Forbidden tag <${tag}>`);
      }
      if (tag === 'a-sky' && stripSky) {
        warnings.push('<a-sky> stripped (MR mode)');
        continue;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        // unknown but inert wrapper: keep its children, drop the shell
        warnings.push(`<${tag}> not whitelisted, children kept`);
        walk(node, parentTarget, isTopLevel);
        continue;
      }

      const el = document.createElement(tag);

      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        let value = attr.value;

        if (/^on/i.test(name)) {
          throw new SanitizeError(`Event handler attribute "${name}" is forbidden`);
        }
        if (name === 'gltf-model' || name === 'obj-model') {
          throw new SanitizeError(`"${name}" is forbidden`);
        }
        if (!ALLOWED_ATTRS.has(name) && !ANIMATION_ATTR_RE.test(name)) {
          warnings.push(`attribute "${name}" on <${tag}> not whitelisted, dropped`);
          continue;
        }
        checkAttrValue(name, value);

        if (name === 'fog') {
          if (isTopLevel) fog = value;
          else warnings.push('fog is scene-level; dropped from nested entity');
          continue;
        }
        if (name === 'position') value = clampVec3(value, -100, 100);
        if (name === 'scale') value = clampVec3(value, 0.001, 50);

        el.setAttribute(name, value);
      }

      el.setAttribute('id', checkId(node.getAttribute('id'), usedIds, genId));

      parentTarget.appendChild(el);
      // Only TOP-LEVEL elements are returned as injectable units — nested
      // entities belong to their parent subtree. Forgetting this guard would
      // make the injector rip nested entities out of their parents.
      if (isTopLevel) {
        const entry = { el, id: el.id, html: null };
        elements.push(entry);
        walk(node, el, false);
        entry.html = el.outerHTML; // after subtree build so children are included
      } else {
        walk(node, el, false);
      }
    }
  };

  walk(doc.body, rootFragment, true);

  return { elements, fog, warnings };
}
