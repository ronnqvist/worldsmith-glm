import { emit } from '../core/bus.js';
import { log } from '../core/log.js';

// Simple grab component (spec §7): raycast-target .interactive entities, hold
// trigger to carry them, release to drop, squeeze while holding to delete.
// Grabbed position animations are paused so they never fight the hand.

let injectorRef = null;
let registered = false;

export function setGrabInjector(injector) {
  injectorRef = injector;
}

function setAnimationsPaused(el, paused) {
  for (const attr of Array.from(el.attributes)) {
    if (/^animation/.test(attr.name) && el.components && el.components[attr.name]) {
      try { el.setAttribute(attr.name, 'paused', paused); } catch { /* not yet initialized */ }
    }
  }
}

export function registerGrab() {
  const AFRAME = window.AFRAME;
  if (!AFRAME || registered) return;
  registered = true;

  AFRAME.registerComponent('grab', {
    init() {
      this.grabbed = null;
      this.el.addEventListener('triggerdown', () => this.tryGrab());
      this.el.addEventListener('triggerup', () => this.release());
      this.el.addEventListener('gripdown', () => this.deleteGrabbed());
    },

    tryGrab() {
      if (this.grabbed) return;
      const ray = this.el.components.raycaster;
      const hit = ray && ray.intersectedEls &&
        ray.intersectedEls.find((el) => el.classList.contains('interactive'));
      if (!hit) return;
      this.grabbed = hit;
      setAnimationsPaused(hit, true);
      // reparent to the controller, preserving world transform
      this.el.object3D.attach(hit.object3D);
      emit('grab:started', { id: hit.id });
    },

    release() {
      const hit = this.grabbed;
      if (!hit) return;
      this.grabbed = null;
      const container = document.getElementById('generated-world');
      if (container && hit.parentNode) {
        container.object3D.attach(hit.object3D);
        const p = hit.object3D.position;
        if (injectorRef) injectorRef.updateEntityPosition(hit.id, { x: p.x, y: p.y, z: p.z });
      }
      setAnimationsPaused(hit, false);
      emit('grab:ended', { id: hit.id });
    },

    deleteGrabbed() {
      const hit = this.grabbed;
      if (!hit) return;
      this.grabbed = null;
      setAnimationsPaused(hit, false);
      if (injectorRef && injectorRef.deleteEntity(hit.id)) {
        log.info('grab-deleted', hit.id);
        emit('grab:deleted', { id: hit.id });
      }
    },

    remove() {
      this.release();
    }
  });
}
