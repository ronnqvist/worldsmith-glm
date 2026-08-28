import { DOMParser as LDOMParser, Node } from 'linkedom';

const parser = new LDOMParser();
globalThis.document = parser.parseFromString('<html><body></body></html>', 'text/html');
globalThis.Node = Node;
globalThis.DOMParser = class {
  // linkedom mangles bare fragments; wrap them (the real browser DOMParser
  // handles fragments natively, this is test-harness-only)
  parseFromString(str) {
    return parser.parseFromString(`<!DOCTYPE html><html><body>${str}</body></html>`, 'text/html');
  }
};

import { parseAndSanitize, SanitizeError } from '../src/world/sanitize.js';

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
function rejects(fn) {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof SanitizeError;
  }
}

check('benign markup passes with serialized children', () => {
  const { elements, fog, warnings } = parseAndSanitize(
    '<a-entity id="island-1" position="0 0 0"><a-box color="#8a5" position="0 1 0"></a-box><a-icosahedron radius="0.5" color="#3af"></a-icosahedron></a-entity>',
    {}
  );
  if (elements.length !== 1) throw new Error('expected 1 top-level');
  if (!elements[0].html.includes('a-box')) throw new Error('children missing from serialization');
  if (!elements[0].html.includes('a-icosahedron')) throw new Error('second child missing');
  if (fog !== null) throw new Error('unexpected fog');
  void warnings;
});

check('script tag rejects whole response', () => {
  if (!rejects(() => parseAndSanitize('<a-box></a-box><script>alert(1)</script>', {}))) {
    throw new Error('did not reject');
  }
});

check('on* handler rejects', () => {
  if (!rejects(() => parseAndSanitize('<a-box onclick="x()"></a-box>', {}))) throw new Error('no reject');
});

check('external src rejects', () => {
  if (!rejects(() => parseAndSanitize('<a-box material="src: url(https://evil.com/t.png)"></a-box>', {}))) throw new Error('url() not rejected');
  if (!rejects(() => parseAndSanitize('<a-entity sound="src: https://x.com/a.mp3"></a-entity>', {}))) throw new Error('sound src url not rejected');
});

check('ambient src token allowed in sound and src attr', () => {
  const { elements } = parseAndSanitize(
    '<a-entity sound="src: #generated-ambient; autoplay: true" src="#generated-ambient"></a-entity>',
    {}
  );
  if (elements.length !== 1) throw new Error('should pass');
});

check('wrong ambient src on src attr rejects', () => {
  if (!rejects(() => parseAndSanitize('<a-entity src="#other"></a-entity>', {}))) throw new Error('no reject');
});

check('class whitelist enforced', () => {
  if (!rejects(() => parseAndSanitize('<a-box class="interactive evil"></a-box>', {}))) throw new Error('bad class not rejected');
  const { elements } = parseAndSanitize('<a-box class="interactive"></a-box>', {});
  if (!elements[0].el.classList.contains('interactive')) throw new Error('interactive lost');
});

check('gltf-model rejects', () => {
  if (!rejects(() => parseAndSanitize('<a-entity gltf-model="url(x.glb)"></a-entity>', {}))) throw new Error('no reject');
});

check('unknown attrs stripped, unknown tags unwrapped', () => {
  const { elements, warnings } = parseAndSanitize(
    '<a-wrapper><a-box data-foo="1" custom-comp="a: b" color="#fff"></a-box></a-wrapper>',
    {}
  );
  if (elements.length !== 1) throw new Error('box not preserved');
  if (elements[0].el.hasAttribute('custom-comp')) throw new Error('custom comp kept');
  if (!warnings.length) throw new Error('no warnings');
});

check('position/scale clamped', () => {
  const { elements } = parseAndSanitize(
    '<a-box position="500 -400 0" scale="200 200 200"></a-box>',
    {}
  );
  if (elements[0].el.getAttribute('position') !== '100 -100 0') throw new Error('position: ' + elements[0].el.getAttribute('position'));
  if (elements[0].el.getAttribute('scale') !== '50 50 50') throw new Error('scale: ' + elements[0].el.getAttribute('scale'));
});

check('ids: missing assigned, duplicates suffixed, reserved renamed', () => {
  const { elements } = parseAndSanitize(
    '<a-box></a-box><a-box id="dup"></a-box><a-box id="dup"></a-box><a-box id="rig"></a-box>',
    { genId: () => 'gen-77' }
  );
  const ids = elements.map((e) => e.id);
  if (ids[0] !== 'gen-77') throw new Error('gen id: ' + ids[0]);
  if (ids[1] !== 'dup' || ids[2] !== 'dup-2') throw new Error('dedupe: ' + ids.join(','));
  if (ids[3] !== 'rig-w') throw new Error('reserved: ' + ids[3]);
});

check('a-sky stripped in MR, kept in VR', () => {
  const mr = parseAndSanitize('<a-sky color="#123"></a-sky><a-box id="b"></a-box>', { stripSky: true });
  if (mr.elements.length !== 1) throw new Error('sky not stripped in MR');
  const vr = parseAndSanitize('<a-sky color="#123"></a-sky>', {});
  if (vr.elements.length !== 1) throw new Error('sky removed in VR');
});

check('fog extracted from top level only', () => {
  const { fog } = parseAndSanitize('<a-entity fog="type: exponential; density: 0.02" id="a"><a-box fog="x: y"></a-box></a-entity>', {});
  if (!fog || !fog.includes('exponential')) throw new Error('top fog missing: ' + fog);
  const nested = parseAndSanitize('<a-entity id="a"><a-box fog="x: y"></a-box></a-entity>', {});
  if (nested.fog !== null) throw new Error('nested fog leaked');
});

check('data: and javascript: rejected', () => {
  if (!rejects(() => parseAndSanitize('<a-box color="javascript:alert(1)"></a-box>', {}))) throw new Error('js: not rejected');
  if (!rejects(() => parseAndSanitize('<a-box material="src: data:image/png;base64,xx"></a-box>', {}))) throw new Error('data: not rejected');
});

check('empty markup yields no elements', () => {
  const { elements } = parseAndSanitize('   ', {});
  if (elements.length !== 0) throw new Error('should be empty');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
