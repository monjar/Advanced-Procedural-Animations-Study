import type * as THREE from 'three';

/**
 * Exact critically damped spring (D. Holden, "Spring-It-On", 2021).
 * Integrated in closed form, so it is unconditionally stable and frame-rate independent.
 */

export function halflifeToDamping(halflife: number): number {
  return (4 * Math.LN2) / (halflife + 1e-5);
}

export interface SpringState {
  x: number;
  v: number;
}

export function criticalSpring(s: SpringState, goal: number, halflife: number, dt: number): SpringState {
  const y = halflifeToDamping(halflife) / 2;
  const j0 = s.x - goal;
  const j1 = s.v + j0 * y;
  const eydt = Math.exp(-y * dt);
  s.x = eydt * (j0 + j1 * dt) + goal;
  s.v = eydt * (s.v - j1 * y * dt);
  return s;
}

/** Vector form of {@link criticalSpring}; mutates `pos` and `vel`. */
export function criticalSpringVec3(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  goal: THREE.Vector3,
  halflife: number,
  dt: number,
): void {
  const y = halflifeToDamping(halflife) / 2;
  const eydt = Math.exp(-y * dt);
  for (const k of ['x', 'y', 'z'] as const) {
    const j0 = pos[k] - goal[k];
    const j1 = vel[k] + j0 * y;
    pos[k] = eydt * (j0 + j1 * dt) + goal[k];
    vel[k] = eydt * (vel[k] - j1 * y * dt);
  }
}
