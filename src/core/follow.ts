import * as THREE from 'three';
import type { App } from './app';

/**
 * Camera follow that keeps the user's orbit offset: the orbit target chases the subject and the
 * camera is translated by the same amount, so orbiting and zooming still work while following.
 */
export function createFollow(app: App, halflife = 0.25) {
  const delta = new THREE.Vector3();
  let enabled = true;
  return {
    get enabled() {
      return enabled;
    },
    set enabled(v: boolean) {
      enabled = v;
    },
    update(subject: THREE.Vector3, dt: number): void {
      if (!enabled) return;
      const t = 1 - Math.exp((-Math.LN2 * dt) / halflife);
      delta.subVectors(subject, app.controls.target).multiplyScalar(t);
      app.controls.target.add(delta);
      app.camera.position.add(delta);
    },
  };
}
