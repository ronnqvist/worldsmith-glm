import { DOMParser as LDOMParser, Node } from 'linkedom';

const parser = new LDOMParser();
const baseDoc = parser.parseFromString('<html><body></body></html>', 'text/html');
globalThis.document = baseDoc;
globalThis.Node = Node;
globalThis.CSS = { escape: (s) => s };
globalThis.DOMParser = class {
  parseFromString(str) {
    return parser.parseFromString(`<!DOCTYPE html><html><body>${str}</body></html>`, 'text/html');
  }
};

const { createInjector, BudgetError, SanitizeError } = await import('../src/world/injector.js');

const containerEl = baseDoc.createElement('a-entity');
containerEl.id = 'generated-world';
const skyEl = baseDoc.createElement('a-sky');
skyEl.id = 'default-sky';

const sceneMock = {
  querySelector: (sel) => {
    if (sel === '#generated-world') return containerEl;
    if (sel === '#default-sky') return skyEl;
    return null;
  },
  setAttribute: () => {},
  hasAttribute: () => false,
  removeAttribute: () => {}
};

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS', name);
  } catch (e) {
    fail++;
    console.log('FAIL', name, '->', e.message);
  }
}

const injector = createInjector(sceneMock);

check('create_world injects entities and counts them', () => {
  injector.applyResponse({
    action: 'create_world',
    markup: '<a-entity id="a1"><a-box></a-box></a-entity><a-box id="a2"></a-box>',
    removed_ids: [],
    narration: 'made two'
  }, {});
  const count = containerEl.querySelectorAll('*').length;
  if (count !== 3) throw new Error('expected 3 nodes, got ' + count);
  if (!containerEl.innerHTML.includes('a1')) throw new Error('a1 missing');
  if (injector.getEntityCount() !== 3) throw new Error('getEntityCount mismatch');
});

check('no generated sky keeps default sky visible', () => {
  if (skyEl.getAttribute('visible') !== 'true') throw new Error('default sky wrongly hidden');
});

check('update_world merges by id (replace, append, remove)', () => {
  injector.applyResponse({
    action: 'update_world',
    markup: '<a-box id="a2" color="#f00"></a-box><a-sphere id="a3" radius="1"></a-sphere>',
    removed_ids: ['a1']
  }, {});
  if (containerEl.querySelector('#a1')) throw new Error('a1 not removed');
  const a2 = containerEl.querySelector('#a2');
  if (!a2 || a2.getAttribute('color') !== '#f00') throw new Error('a2 not replaced');
  if (!containerEl.querySelector('#a3')) throw new Error('a3 not appended');
});

check('update preserves user-moved position when markup lacks one', () => {
  const a3 = containerEl.querySelector('#a3');
  a3.setAttribute('position', '1.5 2 3');
  injector.applyResponse({
    action: 'update_world',
    markup: '<a-sphere id="a3" radius="2"></a-sphere>',
    removed_ids: []
  }, {});
  const el = containerEl.querySelector('#a3');
  if (!el) throw new Error('a3 gone');
  if (el.getAttribute('radius') !== '2') throw new Error('radius not updated');
  if (el.getAttribute('position') !== '1.5 2 3') throw new Error('position lost: ' + el.getAttribute('position'));
});

check('undo restores previous world', () => {
  injector.applyResponse({
    action: 'create_world',
    markup: '<a-cylinder id="z1"></a-cylinder>',
    removed_ids: []
  }, {});
  if (!containerEl.querySelector('#z1') || containerEl.querySelector('#a2')) throw new Error('create_world did not clear+set');
  if (!injector.undo()) throw new Error('undo returned false');
  if (containerEl.querySelector('#z1')) throw new Error('z1 still there after undo');
  if (!containerEl.querySelector('#a2') || !containerEl.querySelector('#a3')) throw new Error('previous world not restored');
});

check('budget: create over 200 rejects', () => {
  let big = '';
  for (let i = 0; i < 201; i++) big += `<a-box id="x${i}"></a-box>`;
  let err = null;
  try {
    injector.applyResponse({ action: 'create_world', markup: big, removed_ids: [] }, {});
  } catch (e) {
    err = e;
  }
  if (!(err instanceof BudgetError)) throw new Error('no BudgetError: ' + err);
  if (containerEl.querySelector('#z1') || containerEl.querySelectorAll('*').length !== 2) {
    throw new Error('world mutated by rejected response');
  }
});

check('budget: update projected over 200 rejects', () => {
  let add = '';
  for (let i = 0; i < 200; i++) add += `<a-box id="y${i}"></a-box>`;
  let err = null;
  try {
    injector.applyResponse({ action: 'update_world', markup: add, removed_ids: [] }, {});
  } catch (e) {
    err = e;
  }
  if (!(err instanceof BudgetError)) throw new Error('no BudgetError');
});

check('bad action rejects with SanitizeError', () => {
  let err = null;
  try {
    injector.applyResponse({ action: 'nuke', markup: '', removed_ids: [] }, {});
  } catch (e) {
    err = e;
  }
  if (!(err instanceof SanitizeError)) throw new Error('wrong error');
});

check('deleteEntity removes with undo', () => {
  if (!injector.deleteEntity('a2')) throw new Error('delete failed');
  if (containerEl.querySelector('#a2')) throw new Error('a2 still present');
  if (!injector.undo()) throw new Error('no undo after delete');
  if (!containerEl.querySelector('#a2')) throw new Error('a2 not restored');
});

check('updateEntityPosition writes into clean markup', () => {
  injector.updateEntityPosition('a2', { x: 4, y: 5, z: 6 });
  const el = containerEl.querySelector('#a2');
  if (el.getAttribute('position') !== '4.000 5.000 6.000') throw new Error('live pos: ' + el.getAttribute('position'));
  const full = injector.getFullMarkup();
  const m = /<a-box[^>]*id="a2"[^>]*>/.exec(full);
  if (!m || !m[0].includes('position="4.000 5.000 6.000"')) throw new Error('clean markup pos missing: ' + (m && m[0]));
});

check('getStateMarkup truncates with marker', () => {
  const full = injector.getFullMarkup();
  const state = injector.getStateMarkup();
  if (full.length <= 12000) {
    if (state !== full) throw new Error('should be identical under limit');
  } else if (!state.endsWith('...[truncated]')) {
    throw new Error('truncation marker missing');
  }
});

check('restoreFromMarkup loads exported snapshot', () => {
  const snapshot = injector.getFullMarkup();
  injector.applyResponse({ action: 'create_world', markup: '<a-cone id="fresh"></a-cone>', removed_ids: [] }, {});
  injector.restoreFromMarkup(snapshot);
  if (!containerEl.querySelector('#a2') || containerEl.querySelector('#fresh')) throw new Error('snapshot not restored');
});

check('generated a-sky hides the default sky until gone', () => {
  injector.applyResponse({
    action: 'update_world',
    markup: '<a-sky id="gen-sky" color="#112233"></a-sky>',
    removed_ids: []
  }, {});
  if (skyEl.getAttribute('visible') !== 'false') throw new Error('default sky not hidden by generated sky');
  injector.deleteEntity('gen-sky');
  if (skyEl.getAttribute('visible') !== 'true') throw new Error('default sky not restored');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
