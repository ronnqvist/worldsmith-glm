import { emit } from '../core/bus.js';
import { log } from '../core/log.js';

// Shared motion signal consumed by the comfort vignette.
export const motion = { speed: 0, turningUntil: 0 };

let registered = false;

export function registerXrComponents() {
  const AFRAME = window.AFRAME;
  if (!AFRAME || registered) return;
  registered = true;

  // Left-thumbstick smooth locomotion, camera-relative, Y-flattened.
  AFRAME.registerComponent('smooth-locomotion', {
    schema: {
      rig: { type: 'selector', default: '#rig' },
      camera: { type: 'selector', default: '#camera' },
      speed: { default: 1.8 }
    },
    init() {
      this.axes = { x: 0, y: 0 };
      this._q = null;
      this._fwd = null;
      this._right = null;
      this.el.addEventListener('thumbstickmoved', (e) => {
        this.axes.x = e.detail.x;
        this.axes.y = e.detail.y;
      });
      this.el.addEventListener('thumbstickended', () => {
        this.axes.x = 0;
        this.axes.y = 0;
        motion.speed = 0;
      });
    },
    tick(t, dt) {
      const { x, y } = this.axes;
      if (!x && !y) return;
      const sec = Math.min(dt, 100) / 1000;
      const rig = this.data.rig && this.data.rig.object3D;
      const cam = this.data.camera && this.data.camera.object3D;
      if (!rig || !cam) return;

      this._q = this._q || rig.quaternion.clone();
      this._fwd = this._fwd || rig.position.clone();
      this._right = this._right || rig.position.clone();

      cam.getWorldQuaternion(this._q);
      this._fwd.set(0, 0, -1).applyQuaternion(this._q);
      this._right.set(1, 0, 0).applyQuaternion(this._q);
      this._fwd.y = 0;
      this._right.y = 0;
      if (this._fwd.lengthSq() > 0) this._fwd.normalize();
      if (this._right.lengthSq() > 0) this._right.normalize();

      rig.position.addScaledVector(this._fwd, -y * sec * this.data.speed);
      rig.position.addScaledVector(this._right, x * sec * this.data.speed);
      motion.speed = Math.hypot(x, y) * this.data.speed;
    }
  });

  // 45-degree snap turn on the right stick, pivoting around the user's head.
  AFRAME.registerComponent('snap-turn', {
    schema: {
      rig: { type: 'selector', default: '#rig' },
      camera: { type: 'selector', default: '#camera' },
      degrees: { default: 45 },
      cooldownMs: { default: 350 }
    },
    init() {
      this.lastTurn = 0;
      this.el.addEventListener('thumbstickmoved', (e) => {
        const x = e.detail.x;
        if (Math.abs(x) > 0.7) this.tryTurn(Math.sign(x));
      });
    },
    tryTurn(sign) {
      const now = performance.now();
      if (now - this.lastTurn < this.data.cooldownMs) return;
      this.lastTurn = now;
      motion.turningUntil = now + 450;

      const rig = this.data.rig.object3D;
      const cam = this.data.camera.object3D;
      const before = cam.getWorldPosition(rig.position.clone());
      rig.rotateY(-sign * (this.data.degrees * Math.PI / 180));
      rig.updateMatrixWorld(true);
      const after = cam.getWorldPosition(rig.position.clone());
      rig.position.x += before.x - after.x;
      rig.position.z += before.z - after.z;
    }
  });

  // Tunnel/vignette that fades in while moving or turning (toggleable).
  AFRAME.registerComponent('comfort-vignette', {
    schema: { enabled: { default: true } },
    init() {
      this.opacity = 0;
    },
    setEnabled(v) {
      this.data.enabled = !!v;
      if (!v) this.setOpacity(0);
    },
    setOpacity(v) {
      this.opacity = v;
      const mesh = this.el.getObject3D('mesh');
      if (mesh && mesh.material) {
        mesh.material.opacity = v;
        mesh.material.transparent = v > 0.001;
      }
    },
    tick() {
      const active = this.data.enabled && (motion.speed > 0.05 || performance.now() < motion.turningUntil);
      const target = active ? 0.75 : 0;
      if (Math.abs(target - this.opacity) < 0.004) return;
      this.setOpacity(this.opacity + (target - this.opacity) * 0.25);
    }
  });

  // Billboard any entity toward the user's head (panels, captions, orb).
  AFRAME.registerComponent('face-camera', {
    schema: { camera: { type: 'selector', default: '#camera' } },
    tick() {
      const cam = this.data.camera;
      if (!cam) return;
      const obj = this.el.object3D;
      obj.lookAt(cam.object3D.getWorldPosition(obj.position.clone()));
    }
  });

  // Pre-built "dreaming" particle swirl shown while the LLM thinks.
  AFRAME.registerComponent('dreaming-swirl', {
    init() {
      this.particles = [];
      const COUNT = 42;
      for (let i = 0; i < COUNT; i++) {
        const p = document.createElement('a-entity');
        p.setAttribute('geometry', 'primitive: sphere; radius: 0.03; segments-width: 6; segments-height: 4');
        p.setAttribute('material', `shader: flat; color: ${i % 3 === 0 ? '#b18cff' : i % 3 === 1 ? '#7fb0ff' : '#e0d6ff'}; opacity: 0.85; transparent: true`);
        this.el.appendChild(p);
        this.particles.push({
          el: p,
          radius: 0.25 + Math.random() * 0.55,
          angle: Math.random() * Math.PI * 2,
          speed: 0.4 + Math.random() * 0.9,
          height: (Math.random() - 0.5) * 1.4,
          bob: Math.random() * Math.PI * 2
        });
      }
    },
    tick(t, dt) {
      if (!this.el.object3D.visible) return;
      const sec = Math.min(dt, 100) / 1000;
      for (const p of this.particles) {
        p.angle += p.speed * sec;
        p.bob += sec * 1.7;
        const r = p.radius * (0.85 + 0.15 * Math.sin(p.bob));
        p.el.object3D.position.set(
          Math.cos(p.angle) * r,
          p.height + Math.sin(p.bob) * 0.18,
          Math.sin(p.angle) * r
        );
      }
    }
  });
}
