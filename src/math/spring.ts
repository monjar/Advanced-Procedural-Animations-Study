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

/** Position driven by a critically damped spring on its velocity (Holden's trajectory "simulation"). */
export interface VelocitySpring {
  x: number;
  v: number;
  a: number;
}

/**
 * Exact update of x' = v, with v a critically damped spring towards `vGoal` (a = v'). Used for character
 * trajectories: the desired velocity snaps with the input, the simulated one eases into it, and the position
 * — and any future position, by calling this with a larger `dt` — follows in closed form.
 */
export function velocitySpring(s: VelocitySpring, vGoal: number, halflife: number, dt: number, out: VelocitySpring = s): VelocitySpring {
  const y = halflifeToDamping(halflife) / 2;
  const j0 = s.v - vGoal;
  const j1 = s.a + j0 * y;
  const eydt = Math.exp(-y * dt);
  const x = eydt * (-j1 / (y * y) + (-j0 - j1 * dt) / y) + j1 / (y * y) + j0 / y + vGoal * dt + s.x;
  const v = eydt * (j0 + j1 * dt) + vGoal;
  const a = eydt * (s.a - j1 * y * dt);
  out.x = x;
  out.v = v;
  out.a = a;
  return out;
}

/** {@link criticalSpring} for an angle (rad): the goal is taken the short way round. */
export function criticalSpringAngle(s: SpringState, goal: number, halflife: number, dt: number): SpringState {
  const d = goal - s.x;
  return criticalSpring(s, s.x + d - 2 * Math.PI * Math.round(d / (2 * Math.PI)), halflife, dt);
}

/** Critically damped decay of an offset (x, v) towards zero — the core of inertialization. */
export function decaySpring(s: SpringState, halflife: number, dt: number): SpringState {
  return criticalSpring(s, 0, halflife, dt);
}
