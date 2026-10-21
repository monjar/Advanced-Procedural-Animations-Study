import * as THREE from 'three';
import { Rng } from '../../src/math/random';
import type { Agent } from './crowd';

/**
 * Procedural walkers for crowd agents, drawn with one instanced mesh per body part (torso, head, thighs,
 * shins, arms): a few draw calls for any number of people.
 *
 * The gait is driven by the agent's actual speed, not by time: the phase advances by π per step, with steps
 * that lengthen as the walker speeds up (≈ 0.45 + 0.2·v m), so the feet keep pace with the ground at any speed
 * and the legs stop when the agent stops. Heading follows the velocity through a critically damped spring:
 * ORCA may change an agent's velocity sharply from one step to the next, and a body that snapped to every
 * change would twitch.
 */

const HALF_LIFE = 0.12;
const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const SHIRTS = [0xff8a3d, 0x5fb3ff, 0x4fd18b, 0xffd166, 0xc6a7ff, 0xff5c8a, 0xe6e6e6, 0x3a86ff];
const PANTS = [0x2b2f3a, 0x3d405b, 0x5a4636, 0x1f3a5f, 0x444444];

/** Capsule whose axis runs from the origin down to −length (a limb hanging from its joint). */
function limb(radius: number, length: number): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(radius, length, 4, 10).translate(0, -length / 2, 0);
}

interface WalkerState {
  heading: number;
  headingVel: number;
  phase: number;
  speed: number;
  scale: number;
}

const THIGH = 0.44;
const SHIN = 0.46;
const HIP_Y = 0.93;
const ARM = 0.6;

export class WalkerView {
  readonly group = new THREE.Group();
  private readonly torso: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly thigh: THREE.InstancedMesh;
  private readonly shin: THREE.InstancedMesh;
  private readonly arm: THREE.InstancedMesh;
  private states: WalkerState[] = [];
  private readonly B = new THREE.Matrix4();
  private readonly M = new THREE.Matrix4();
  private readonly T = new THREE.Matrix4();
  private readonly R = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(readonly capacity: number) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    const make = (geo: THREE.BufferGeometry, n: number) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.castShadow = true;
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    this.torso = make(new THREE.CapsuleGeometry(0.16, 0.34, 4, 12).scale(1, 1, 0.62), capacity);
    this.head = make(new THREE.SphereGeometry(0.105, 14, 10), capacity);
    this.thigh = make(limb(0.075, THIGH), 2 * capacity);
    this.shin = make(limb(0.06, SHIN), 2 * capacity);
    this.arm = make(limb(0.045, ARM), 2 * capacity);
  }

  /** New agents: per-person size and colours (seeded, so a restart looks the same). */
  reset(agents: Agent[], seed = 3): void {
    const rng = new Rng(seed);
    const c = new THREE.Color();
    this.states = agents.map((a) => ({
      heading: Math.atan2(a.route[0].p.x - a.position.x, a.route[0].p.y - a.position.y),
      headingVel: 0,
      phase: rng.range(0, Math.PI * 2),
      speed: 0,
      scale: (a.radius / 0.25) * rng.range(0.92, 1.08),
    }));
    agents.forEach((_, i) => {
      const shirt = c.set(rng.pick(SHIRTS));
      this.torso.setColorAt(i, shirt);
      this.arm.setColorAt(2 * i, shirt);
      this.arm.setColorAt(2 * i + 1, shirt);
      this.head.setColorAt(i, c.set(rng.pick(SKIN)));
      const pants = c.set(rng.pick(PANTS));
      for (const k of [0, 1]) {
        this.thigh.setColorAt(2 * i + k, pants);
        this.shin.setColorAt(2 * i + k, pants);
      }
    });
    for (const m of [this.torso, this.head, this.thigh, this.shin, this.arm]) {
      m.count = m === this.torso || m === this.head ? agents.length : 2 * agents.length;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  /** Advance the gaits by dt and write every instance matrix. */
  update(agents: Agent[], dt: number): void {
    const a2 = Math.LN2 / HALF_LIFE;
    agents.forEach((a, i) => {
      const st = this.states[i];
      if (a.gone) {
        this.hide(i);
        return;
      }
      const v = Math.hypot(a.velocity.x, a.velocity.y);
      // Speed smoothed a little (the stride follows it); heading by a critically damped spring.
      st.speed += (v - st.speed) * Math.min(1, dt / 0.15);
      if (v > 0.15) {
        const target = Math.atan2(a.velocity.x, a.velocity.y);
        const err = Math.atan2(Math.sin(st.heading - target), Math.cos(st.heading - target));
        const j1 = st.headingVel + err * a2;
        const e = Math.exp(-a2 * dt);
        st.heading = target + (err + j1 * dt) * e;
        st.headingVel = (st.headingVel - j1 * a2 * dt) * e;
      } else st.headingVel *= Math.exp(-a2 * dt);
      const stepLength = (0.45 + 0.2 * st.speed) * st.scale;
      st.phase += (Math.PI * st.speed * dt) / stepLength;
      this.pose(i, a, st);
    });
    for (const m of [this.torso, this.head, this.thigh, this.shin, this.arm]) m.instanceMatrix.needsUpdate = true;
  }

  private hide(i: number): void {
    this.M.makeScale(0, 0, 0);
    this.torso.setMatrixAt(i, this.M);
    this.head.setMatrixAt(i, this.M);
    for (const k of [0, 1]) for (const m of [this.thigh, this.shin, this.arm]) m.setMatrixAt(2 * i + k, this.M);
  }

  private pose(i: number, a: Agent, st: WalkerState): void {
    const amp = Math.min(0.5, 0.32 * st.speed) * Math.min(1, st.speed / 0.25);
    const bob = 0.025 * amp * Math.cos(2 * st.phase);
    // Lean forward with speed and into turns (centripetal: speed × turn rate).
    const lean = 0.06 * st.speed;
    const bank = THREE.MathUtils.clamp(-0.05 * st.speed * st.headingVel, -0.15, 0.15);
    this.q.setFromAxisAngle(this.up, st.heading);
    this.B.compose(this.p.set(a.position.x, bob * st.scale, a.position.y), this.q, this.s.setScalar(st.scale));

    // Torso and head, leaning together.
    this.euler.set(lean, 0, bank);
    this.R.makeRotationFromEuler(this.euler);
    this.M.copy(this.B).multiply(this.T.makeTranslation(0, HIP_Y, 0)).multiply(this.R);
    this.torso.setMatrixAt(i, this.T.copy(this.M).multiply(this.R.makeTranslation(0, 0.3, 0)));
    this.head.setMatrixAt(i, this.T.copy(this.M).multiply(this.R.makeTranslation(0, 0.71, 0.02)));

    for (const side of [0, 1]) {
      const ph = st.phase + side * Math.PI;
      const swing = amp * Math.sin(ph);
      // The knee bends while the leg swings forward (cos > 0), and a little throughout.
      const knee = amp * (0.25 + 1.5 * Math.max(0, Math.cos(ph)));
      const x = side === 0 ? 0.095 : -0.095;
      this.M.copy(this.B).multiply(this.T.makeTranslation(x, HIP_Y, 0)).multiply(this.R.makeRotationX(-swing));
      this.thigh.setMatrixAt(2 * i + side, this.M);
      this.M.multiply(this.T.makeTranslation(0, -THIGH, 0)).multiply(this.R.makeRotationX(knee));
      this.shin.setMatrixAt(2 * i + side, this.M);
      // Arms swing against the leg on their side, from shoulders that lean with the torso.
      this.M.copy(this.B)
        .multiply(this.T.makeTranslation(0, HIP_Y, 0))
        .multiply(this.R.makeRotationFromEuler(this.euler))
        .multiply(this.T.makeTranslation(x * 2.15, 0.5, 0))
        .multiply(this.R.makeRotationX(0.8 * swing))
        .multiply(this.T.makeRotationZ(side === 0 ? 0.08 : -0.08));
      this.arm.setMatrixAt(2 * i + side, this.M);
    }
  }
}
