import * as THREE from 'three';
import { World } from '../../demos/05-hexapod/world';
import { FOOT_RADIUS, Spider } from '../../demos/05-hexapod/spider';

/** Body sample points (body frame) on the thorax, abdomen and head ellipsoids, matching the render. */
function ellipsoidPoints(centre: THREE.Vector3Tuple, radii: THREE.Vector3Tuple): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    for (const lat of [-1.2, -0.6, 0, 0.6]) {
      const a = (i / 8) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(lat) * Math.cos(a) * radii[0] + centre[0], Math.sin(lat) * radii[1] + centre[1], Math.cos(lat) * Math.sin(a) * radii[2] + centre[2]));
    }
  }
  pts.push(new THREE.Vector3(centre[0], centre[1] - radii[1], centre[2]));
  return pts;
}
export const BODY_POINTS = [
  ...ellipsoidPoints([0, 0, 0], [0.22, 0.11, 0.3]),
  ...ellipsoidPoints([0, 0.1, -0.52], [0.27, 0.22, 0.36]),
  ...ellipsoidPoints([0, 0.03, 0.3], [0.11, 0.11, 0.11]),
];
const SPHERE_DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [0.577, 0.577, 0.577], [-0.577, -0.577, 0.577], [0.577, -0.577, -0.577], [-0.577, 0.577, -0.577],
].map(([x, y, z]) => new THREE.Vector3(x, y, z));

/** Deepest point of a sphere inside the world geometry. */
function sphereDepth(world: World, centre: THREE.Vector3, r: number, tmp: THREE.Vector3): number {
  let d = world.depth(centre);
  for (const dir of SPHERE_DIRS) d = Math.max(d, world.depth(tmp.copy(centre).addScaledVector(dir, r)));
  return d;
}

/** Auto-wander the playground (same steering as the demo) and record worst penetrations. */
export function auditHexapod(seconds: number) {
  const world = new World('playground');
  const spider = new Spider(world.rays, new THREE.Vector3(0, 0, 3));
  const waypoints = [[3.5, 1.5], [3.5, -3.5], [-1, -4.5], [-1, -10], [-7, -8], [-7, -1], [-4.5, 2.5], [-4.5, 6], [5.5, 4.5], [6, 0]].map(([x, z]) => new THREE.Vector3(x, 0, z));
  let wp = 0;
  const steer = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const worst = { foot: 0, footSwing: 0, footPlanted: 0, body: 0, leg: 0, frames: 0, footFrames: 0, bodyFrames: 0 };
  for (let i = 0; i < seconds * 60; i++) {
    const t = waypoints[wp];
    const dx = t.x - spider.position.x;
    const dz = t.z - spider.position.z;
    if (Math.hypot(dx, dz) < 1.0) wp = (wp + 1) % waypoints.length;
    if (spider.up.y > 0.7) spider.update(1 / 60, 1, 0, steer.set(dx, 0, dz));
    else spider.update(1 / 60, 1, 0);
    worst.frames++;
    for (const leg of spider.legs) {
      // Deepest point of the rendered foot sphere (radius slightly under FOOT_RADIUS for float noise).
      const d = sphereDepth(world, leg.ik.end, FOOT_RADIUS * 0.9, tmp2);
      worst.foot = Math.max(worst.foot, d);
      if (leg.stepping) worst.footSwing = Math.max(worst.footSwing, d);
      else worst.footPlanted = Math.max(worst.footPlanted, d);
      if (d > 0.01) worst.footFrames++;
      worst.leg = Math.max(worst.leg, world.depth(tmp.lerpVectors(leg.ik.mid, leg.ik.end, 0.5)));
    }
    let body = 0;
    for (const p of BODY_POINTS) body = Math.max(body, world.depth(spider.toWorld(p, tmp)));
    worst.body = Math.max(worst.body, body);
    if (body > 0.02) worst.bodyFrames++;
  }
  return worst;
}

/**
 * Auto-wander with jittery, display-synced frame times (25–60 fps) and report the longest time any leg
 * went without a foothold, plus how many waypoints were reached.
 */
export function auditFootholds(seconds: number, seed: number) {
  const world = new World('playground');
  const spider = new Spider(world.rays, new THREE.Vector3(0, 0, 3));
  const waypoints = [[3.5, 1.5], [3.5, -3.5], [-1, -4.5], [-1, -10], [-7, -8], [-7, -1], [-4.5, 2.5], [-4.5, 6], [5.5, 4.5], [6, 0]].map(([x, z]) => new THREE.Vector3(x, 0, z));
  let wp = 0;
  let reached = 0;
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const lost = spider.legs.map(() => 0);
  let worstLost = 0;
  let time = 0;
  const steer = new THREE.Vector3();
  while (time < seconds) {
    const frame = 1 / 60 + rnd() / 25;
    const n = Math.ceil(frame * 60 - 1e-6);
    for (let k = 0; k < n; k++) {
      const dt = frame / n;
      const t = waypoints[wp];
      const dx = t.x - spider.position.x;
      const dz = t.z - spider.position.z;
      if (Math.hypot(dx, dz) < 1) {
        wp = (wp + 1) % waypoints.length;
        reached++;
      }
      if (spider.up.y > 0.7) spider.update(dt, 1, 0, steer.set(dx, 0, dz));
      else spider.update(dt, 1, 0);
      time += dt;
      spider.legs.forEach((l, i) => {
        lost[i] = l.targetFound ? 0 : lost[i] + dt;
        worstLost = Math.max(worstLost, lost[i]);
      });
    }
  }
  return { worstLost, reached };
}
