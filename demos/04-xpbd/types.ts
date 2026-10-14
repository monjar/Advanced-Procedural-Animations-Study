import * as THREE from 'three';
import type { DebugDraw } from '../../src/core/debugDraw';
import type { ParticleSystem } from '../../src/physics/xpbd';

export interface Material {
  /** log10 compliance (m/N) per constraint family. */
  stretch: number;
  shear: number;
  bend: number;
}

export interface SolverSettings {
  mode: 'xpbd' | 'pbd';
  substeps: number;
  iterations: number;
  pbdStiffness: number;
  damping: number;
  friction: number;
  wind: number;
}

export interface XpbdScene {
  readonly root: THREE.Group;
  readonly systems: ParticleSystem[];
  /** Kinematic object the user can drag with the gizmo, if any. */
  readonly handle?: THREE.Object3D;
  update(dt: number, time: number): void;
  render(debug: DebugDraw, showParticles: boolean, showConstraints: boolean): void;
  applyMaterial(m: Material): void;
  applySolver(s: SolverSettings): void;
  /** Called when the user starts dragging the handle. */
  onHandleDrag?(): void;
  dispose(): void;
}

/** Common solver settings applied to one system. */
export function configure(ps: ParticleSystem, s: SolverSettings): void {
  ps.mode = s.mode;
  ps.substeps = s.substeps;
  ps.iterations = s.iterations;
  ps.pbdStiffness = s.pbdStiffness;
  ps.damping = s.damping;
  ps.friction = s.friction;
}

/** Draw particles and/or constraints of a system. */
export function drawSystem(ps: ParticleSystem, debug: DebugDraw, particles: boolean, constraints: boolean, color = 0x9aa1ad): void {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  if (constraints) {
    for (let k = 0; k < ps.nConstraints; k++) {
      const [i, j] = ps.constraintEnds(k);
      debug.line(ps.get(i, a), ps.get(j, b), color);
    }
  }
  if (particles) {
    for (let i = 0; i < ps.count; i++) debug.point(ps.get(i, a), ps.isPinned(i) ? 0xff4d4d : 0xe6e8ec);
  }
}
