import { parseAndSanitize, SanitizeError, BudgetError } from './sanitize.js';
import { emit } from '../core/bus.js';
import { log } from '../core/log.js';

export { SanitizeError, BudgetError };

const MAX_ENTITIES = 200;
const CONTEXT_LIMIT = 12000;
const UNDO_LIMIT = 10;
const WORLD_ID = 'generated-world';

function nodeCount(el) {
  return 1 + el.querySelectorAll('*').length;
}

// Rewrites (or inserts) an attribute inside a serialized tag string.
function withAttribute(html, name, value) {
  const re = new RegExp(`\\s${name}="[^"]*"`);
  if (re.test(html)) return html.replace(re, ` ${name}="${value}"`);
  return html.replace(/^<[a-z-]+/i, (m) => `${m} ${name}="${value}"`);
}

export function createInjector(sceneEl) {
  const map = new Map(); // id -> clean markup string (the world source of truth)
  const undoStack = [];
  let genCounter = 0;

  const container = () => sceneEl.querySelector('#' + WORLD_ID);
  const defaultSky = () => sceneEl.querySelector('#default-sky');

  function getEntityCount() {
    const c = container();
    return c ? c.querySelectorAll('*').length : 0;
  }

  function getFullMarkup() {
    return Array.from(map.values()).join('\n');
  }

  // Compact serialization handed to the LLM as current-world context.
  function getStateMarkup() {
    const full = getFullMarkup();
    if (full.length <= CONTEXT_LIMIT) return full;
    return full.slice(0, CONTEXT_LIMIT) + '\n...[truncated]';
  }

  function syncDefaultSky() {
    const sky = defaultSky();
    if (!sky) return;
    const hasGeneratedSky = !!container().querySelector('a-sky');
    sky.setAttribute('visible', hasGeneratedSky ? 'false' : 'true');
  }

  function changed(detail = {}) {
    emit('world:changed', { count: getEntityCount(), ...detail });
  }

  function pushUndo(label) {
    undoStack.push({ label, world: getFullMarkup() });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function findLive(id) {
    const c = container();
    return c ? c.querySelector('#' + CSS.escape(id)) : null;
  }

  function clearWorld() {
    const c = container();
    while (c.firstChild) c.removeChild(c.firstChild);
    map.clear();
    syncDefaultSky();
  }

  // Adds the client-side spawn transition (spec §5.4). Called after the clean
  // markup snapshot is taken so the sugar never pollutes LLM context.
  function addSpawnAnimation(el) {
    let hasOwnScaleAnim = false;
    for (const attr of Array.from(el.attributes)) {
      if (/^animation/.test(attr.name) && /property\s*:\s*[^;]*scale/i.test(attr.value)) {
        hasOwnScaleAnim = true;
        break;
      }
    }
    if (hasOwnScaleAnim) return;
    const to = el.getAttribute('scale') || '1 1 1';
    el.setAttribute('animation__spawn',
      `property: scale; from: 0.001 0.001 0.001; to: ${to}; dur: 600; easing: easeOutBack; autoplay: true`);
  }

  function attach(el, { animateIn }) {
    const c = container();
    if (animateIn) addSpawnAnimation(el);
    c.appendChild(el);
    map.set(el.id, el.__cleanHtml);
  }

  function applyResponse(envelope, { mrMode = false } = {}) {
    const action = envelope && envelope.action;
    if (action !== 'create_world' && action !== 'update_world') {
      throw new SanitizeError(`Unknown action "${action}"`);
    }

    const { elements, fog, warnings } = parseAndSanitize(
      typeof envelope.markup === 'string' ? envelope.markup : '',
      { stripSky: mrMode, genId: () => `gen-${++genCounter}` }
    );
    for (const w of warnings) log.warn('sanitizer:', w);

    const removedIds = Array.isArray(envelope.removed_ids)
      ? envelope.removed_ids.filter((id) => typeof id === 'string')
      : [];

    // Entity budget: project the post-apply count before mutating anything.
    if (action === 'create_world') {
      let total = 0;
      for (const { el } of elements) total += nodeCount(el);
      if (total > MAX_ENTITIES) {
        throw new BudgetError(`World budget exceeded: response has ${total} entities (max ${MAX_ENTITIES})`);
      }
    } else {
      let projected = getEntityCount();
      for (const { el } of elements) {
        const existing = findLive(el.id);
        projected += nodeCount(el) - (existing ? nodeCount(existing) : map.has(el.id) ? 1 : 0);
      }
      for (const id of removedIds) {
        const existing = findLive(id);
        projected -= existing ? nodeCount(existing) : map.has(id) ? 1 : 0;
      }
      if (projected > MAX_ENTITIES) {
        throw new BudgetError(`World budget exceeded: update would reach ${projected} entities (max ${MAX_ENTITIES})`);
      }
    }

    pushUndo(action);

    if (action === 'create_world') {
      clearWorld();
    } else {
      for (const id of removedIds) {
        const el = findLive(id);
        if (el) el.parentNode.removeChild(el);
        map.delete(id);
      }
    }

    for (const entry of elements) {
      const { el } = entry;
      el.__cleanHtml = entry.html;
      if (action === 'update_world' && map.has(el.id)) {
        const existing = findLive(el.id);
        if (existing) {
          // preserve a user-moved position unless the update supplies its own
          if (!el.hasAttribute('position')) {
            const pos = existing.getAttribute('position');
            if (pos) {
              el.setAttribute('position', pos);
              el.__cleanHtml = withAttribute(entry.html, 'position', pos);
            }
          }
          existing.parentNode.insertBefore(el, existing);
          existing.parentNode.removeChild(existing);
        }
        map.set(el.id, el.__cleanHtml);
      } else {
        attach(el, { animateIn: true });
      }
    }

    if (fog && !mrMode) {
      sceneEl.setAttribute('fog', fog);
    } else if (action === 'create_world' && !fog) {
      if (sceneEl.hasAttribute('fog')) sceneEl.removeAttribute('fog');
    }

    syncDefaultSky();
    changed({ action });
    return { narration: envelope.narration || '', added: elements.length, removed: removedIds.length };
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return false;
    const { elements } = parseAndSanitize(entry.world, { stripSky: false, genId: () => `gen-${++genCounter}` });
    clearWorld();
    for (const { el, html } of elements) {
      el.__cleanHtml = html;
      container().appendChild(el);
      map.set(el.id, html);
    }
    syncDefaultSky();
    changed({ action: 'undo' });
    return true;
  }

  function hasUndo() {
    return undoStack.length > 0;
  }

  // Grab+squeeze delete path: removes one entity with an undo entry.
  function deleteEntity(id) {
    const el = findLive(id);
    if (!el) return false;
    pushUndo('delete');
    el.parentNode.removeChild(el);
    map.delete(id);
    syncDefaultSky();
    changed({ action: 'delete', id });
    return true;
  }

  // After a grab release, write the final world-space position back into both
  // the live DOM and the clean markup so later LLM updates keep it.
  function updateEntityPosition(id, position) {
    const el = findLive(id);
    if (!el) return;
    const clean = map.get(el.id);
    const v = `${position.x.toFixed(3)} ${position.y.toFixed(3)} ${position.z.toFixed(3)}`;
    el.setAttribute('position', v);
    if (clean !== undefined) map.set(el.id, withAttribute(clean, 'position', v));
    changed({ action: 'move', id });
  }

  function reset() {
    pushUndo('reset');
    clearWorld();
    if (sceneEl.hasAttribute('fog')) sceneEl.removeAttribute('fog');
    changed({ action: 'reset' });
  }

  function restoreFromMarkup(markup) {
    pushUndo('restore');
    const { elements } = parseAndSanitize(markup || '', { stripSky: false, genId: () => `gen-${++genCounter}` });
    clearWorld();
    for (const { el, html } of elements) {
      el.__cleanHtml = html;
      container().appendChild(el);
      map.set(el.id, html);
    }
    syncDefaultSky();
    changed({ action: 'restore' });
  }

  return {
    applyResponse,
    undo,
    hasUndo,
    deleteEntity,
    updateEntityPosition,
    reset,
    restoreFromMarkup,
    getStateMarkup,
    getFullMarkup,
    getEntityCount,
    clearWorld,
    syncSky: syncDefaultSky
  };
}
