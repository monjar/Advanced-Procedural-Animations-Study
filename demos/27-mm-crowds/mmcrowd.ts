import type { MotionFeatures } from '../../src/anim/mmfeatures';
import { searchAABB } from '../../src/anim/mmfeatures';
import type { ControlInput } from '../09-motion-matching/controller';
import { FootLocker, plantedFeet } from '../09-motion-matching/footlock';
import { MotionMatcher } from '../09-motion-matching/matcher';
import { LearnedMatcher, type LmmModel } from '../16-learned-motion-matching/learned';
import type { Networks } from '../16-learned-motion-matching/networks';
import type { Crowd } from '../19-character-crowds/crowd';

/**
 * Study 19's crowds with study 09's (or 16's) motion matching for bodies, coupled one of two ways:
 *
 *   animation-driven   ORCA plans each agent's velocity from where its *body* is; that velocity is the motion-
 *                      matching input; the mocap's root motion moves the body; the body's root is the agent's
 *                      next position. Feet never skate — but bodies cannot change velocity as fast as ORCA asks.
 *   simulation-driven  ORCA moves its agents itself (collision-free); each body is steered toward its agent and
 *                      pulled the rest of the way, at most `pull` × its own speed (study 09's adjustment). Strong
 *                      pull keeps bodies apart and makes feet slide; weak pull lets bodies lag into each other.
 */

export type Driver = 'database' | 'learned';
export type Coupling = 'animation' | 'simulation';

export interface Bodies {
  mf: MotionFeatures;
  nets?: Networks;
  model?: LmmModel;
  start?: Float32Array;
}

type Character = MotionMatcher | LearnedMatcher;

export class MMCrowd {
  readonly chars: Character[];
  readonly lockers: FootLocker[];
  /** Steps measured, and planted-foot slip (m/s) summed over them. */
  stats = { steps: 0, slipSum: 0, slipSamples: 0, maxSlip: 0, cpu: 0, bodyOverlap: 0, bodyDeepest: 0 };
  coupling: Coupling = 'simulation';
  /** Simulation-driven pull, as a multiple of the body's own speed. */
  pull = 1.5;
  private readonly prevFeet: Float32Array;
  private readonly feet: [number, number];

  constructor(
    readonly crowd: Crowd,
    readonly driver: Driver,
    readonly bodies: Bodies,
    lock = true,
  ) {
    const db = bodies.mf.db;
    this.chars = crowd.agents.map((a) => {
      const first = a.route[0].p;
      const yaw = Math.atan2(first.x - a.position.x, first.y - a.position.y);
      if (driver === 'learned') {
        const c = new LearnedMatcher(bodies.nets!, bodies.model!, bodies.start!);
        c.reset(bodies.start!, a.position.x, a.position.y, yaw);
        return c;
      }
      const c = new MotionMatcher(bodies.mf, { search: searchAABB });
      c.reset(a.position.x, a.position.y, yaw);
      return c;
    });
    this.lockers = this.chars.map(() => {
      const l = new FootLocker(db.joints);
      l.enabled = lock;
      return l;
    });
    this.feet = [db.joints.findIndex((j) => j.name === 'LeftToeBase'), db.joints.findIndex((j) => j.name === 'RightToeBase')];
    this.prevFeet = new Float32Array(this.chars.length * 6);
  }

  private planted(c: Character): boolean[] {
    return c instanceof MotionMatcher ? plantedFeet(c).slice() : c.contacts.map((x) => x > 0.5);
  }

  step(dt: number): void {
    const t0 = performance.now();
    const sim = this.coupling === 'simulation';
    const before = this.chars.map((c) => ({ x: c.root.x, z: c.root.z }));
    let vels: { x: number; y: number }[];
    if (sim) {
      this.crowd.step(dt);
      vels = this.crowd.agents.map((a) => a.velocity);
    } else vels = this.crowd.plan(dt);
    const positions = this.crowd.agents.map((a) => ({ ...a.position }));
    const input: ControlInput = { x: 0, z: 0, run: false };
    this.chars.forEach((c, i) => {
      const a = this.crowd.agents[i];
      if (a.gone) return;
      const v = vels[i];
      const s = Math.hypot(v.x, v.y);
      const run = s > 0.5 * (c.controller.walkSpeed + c.controller.runSpeed);
      const top = run ? c.controller.runSpeed : c.controller.walkSpeed;
      // Plane (x, y) is the scene's (x, z).
      input.x = s > 1e-6 ? (v.x / s) * Math.min(1, s / top) : 0;
      input.z = s > 1e-6 ? (v.y / s) * Math.min(1, s / top) : 0;
      input.run = run;
      c.update(input, dt);
      if (sim) {
        // Pull the body toward its agent, limited by its own speed (feet slide by up to `pull` × that speed).
        const speed = Math.hypot(c.root.x - before[i].x, c.root.z - before[i].z) / dt;
        let dx = a.position.x - c.root.x;
        let dz = a.position.y - c.root.z;
        const d = Math.hypot(dx, dz);
        const max = this.pull * Math.max(speed, 0.3) * dt;
        if (d > max) (dx *= max / d), (dz *= max / d);
        c.root.x += dx;
        c.root.z += dz;
        for (let j = 0; j < c.world.length; j += 3) {
          c.world[j] += dx;
          c.world[j + 2] += dz;
        }
      }
      positions[i] = { x: c.root.x, y: c.root.z };
      const planted = this.planted(c);
      this.lockers[i].apply(c.world, planted, dt);
      // Planted-foot slip after locking.
      this.feet.forEach((f, k) => {
        const x = c.world[f * 3];
        const z = c.world[f * 3 + 2];
        const o = i * 6 + k * 3;
        if (planted[k] && this.stats.steps > 0) {
          const slip = (Math.hypot(x - this.prevFeet[o], z - this.prevFeet[o + 2]) / dt) * (c.world[f * 3 + 1] < 0.08 ? 1 : 0);
          this.stats.slipSum += slip;
          this.stats.slipSamples++;
          this.stats.maxSlip = Math.max(this.stats.maxSlip, slip);
        }
        this.prevFeet[o] = x;
        this.prevFeet[o + 2] = z;
      });
    });
    if (!sim) this.crowd.adopt(positions, dt);
    // Overlap between the bodies themselves (what the viewer sees), radius 0.25 m.
    let overlapping = 0;
    for (let i = 0; i < positions.length; i++) {
      if (this.crowd.agents[i].gone) continue;
      for (let j = i + 1; j < positions.length; j++) {
        if (this.crowd.agents[j].gone) continue;
        const pen = 0.5 - Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y);
        if (pen > 0.01) overlapping++;
        this.stats.bodyDeepest = Math.max(this.stats.bodyDeepest, pen);
      }
    }
    this.stats.bodyOverlap += overlapping * dt;
    this.stats.steps++;
    const ms = performance.now() - t0;
    this.stats.cpu += (ms - this.stats.cpu) * 0.05;
  }
}
