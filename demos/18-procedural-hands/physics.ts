import * as THREE from 'three';
import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';
import type { Grasp } from './grasp';
import { handMjcf, JOINTS, LIMITS } from './hand';
import type { Shape } from './shapes';

/**
 * The physical check: rebuild the hand (position-servo fingers on a free body welded to a mocap target) and the
 * object (a free body on a table) in MuJoCo, close the fingers past the planned pose so they squeeze, then lift
 * the target 20 cm. A grasp that only looked good to the metrics drops the object here.
 *
 * Planning works in the object's frame with y up; MuJoCo is z up: (x, y, z)ᵗʰʳᵉᵉ → (x, −z, y)ᵐʲ.
 */

const f = (n: number) => n.toFixed(5);

function objectXml(shape: Shape): string {
  const s = shape.size;
  const geoms: string[] = [];
  if (shape.kind === 'sphere') geoms.push(`<geom type="sphere" size="${f(s[0])}" pos="0 0 ${f(s[0])}"/>`);
  else if (shape.kind === 'box') geoms.push(`<geom type="box" size="${f(s[0])} ${f(s[2])} ${f(s[1])}" pos="0 0 ${f(s[1])}"/>`);
  else if (shape.kind === 'cylinder') geoms.push(`<geom type="cylinder" size="${f(s[0])} ${f(s[1])}" pos="0 0 ${f(s[1])}"/>`);
  else if (shape.kind === 'capsule') geoms.push(`<geom type="capsule" size="${f(s[0])}" fromto="${f(-s[1])} 0 ${f(s[0])} ${f(s[1])} 0 ${f(s[0])}"/>`);
  else if (shape.kind === 'mug') {
    geoms.push(`<geom type="cylinder" size="0.04 0.05" pos="0 0 0.05"/>`);
    // The handle: a ring of capsules in the x–z plane (a torus is not a MuJoCo primitive).
    for (let i = 0; i < 10; i++) {
      const a0 = (2 * Math.PI * i) / 10;
      const a1 = (2 * Math.PI * (i + 1)) / 10;
      const p = (a: number) => `${f(0.045 + 0.025 * Math.cos(a))} 0 ${f(0.05 + 0.025 * Math.sin(a))}`;
      geoms.push(`<geom type="capsule" size="0.007" fromto="${p(a0)} ${p(a1)}"/>`);
    }
  }
  return `<body name="object" pos="0 0 0"><freejoint/><inertial pos="0 0 ${f(shape.height / 2)}" mass="${shape.mass}" diaginertia="${f(shape.mass * shape.scale ** 2 * 0.4)} ${f(shape.mass * shape.scale ** 2 * 0.4)} ${f(shape.mass * shape.scale ** 2 * 0.4)}"/>${geoms.join('')}</body>`;
}

export function sceneXml(shape: Shape): string {
  const hand = handMjcf(5);
  return `<mujoco model="grasp">
  <!-- Radians: without this MJCF reads joint ranges in degrees and every finger stops at ~2°. -->
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.002" integrator="implicitfast" cone="elliptic" impratio="10"/>
  <default>
    <!-- Collision bits: hand geoms are contype 2 / conaffinity 1, the object and table 1 / 3, so the hand touches
         both but never itself (the planner ignores finger–finger contact too; here it jammed the fingers). -->
    <geom friction="0.8 0.02 0.002" condim="4" solref="0.004 1" contype="1" conaffinity="3"/>
    <joint damping="0.05" armature="0.001"/>
  </default>
  <worldbody>
    <geom name="table" type="plane" size="0 0 0.05"/>
    ${objectXml(shape)}
    ${hand.body}
  </worldbody>
  <equality>
    ${hand.equality}
  </equality>
  <actuator>
    ${hand.actuators}
  </actuator>
</mujoco>`;
}

const C = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

/**
 * A grasp's wrist (object frame, y up) as MuJoCo mocap position and quaternion (w, x, y, z). The hand's MJCF uses
 * the same hand-frame coordinates, so a hand point p lands at C·(W·p): the mocap transform is C·W (not C·W·Cᵀ,
 * which would also re-rotate the hand's own frame).
 */
export function wristToMj(wrist: THREE.Matrix4): { pos: number[]; quat: number[] } {
  const m = C.clone().multiply(wrist);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  m.decompose(p, q, sc);
  return { pos: [p.x, p.y, p.z], quat: [q.w, q.x, q.y, q.z] };
}

export interface LiftResult {
  /** How far the object rose (m) while the wrist rose 0.2 m. */
  rise: number;
  /** How far the object moved relative to the hand during the lift (m). */
  slip: number;
  held: boolean;
}

/** The planned pose moved `amount` along the grasp's closing direction (negative opens it), within limits. */
export function alongClosing(g: Grasp, amount: number): Float64Array {
  const t = new Float64Array(g.pose);
  for (let j = 0; j < JOINTS; j++) t[j] = Math.min(LIMITS[j][1], Math.max(LIMITS[j][0], t[j] + amount * g.closing[j]));
  return t;
}

/** A MuJoCo world for one grasp, stepped by the page (or a test) through its phases. */
export class GraspSim {
  readonly model: MjModel;
  readonly data: MjData;
  readonly dt: number;
  time = 0;
  private readonly start: { pos: number[]; quat: number[] };
  private readonly targets: Float64Array;
  private readonly preshape: Float64Array;
  private objectStart = [0, 0, 0];
  private relStart = [0, 0, 0];
  readonly durations = { close: 0.3, hold: 0.3, lift: 1.0, settle: 0.5 };
  qpos0 = 0;
  handBody = 0;

  constructor(
    readonly mj: MainModule,
    readonly shape: Shape,
    readonly grasp: Grasp,
    xml = sceneXml(shape),
  ) {
    this.model = mj.MjModel.from_xml_string(xml);
    this.data = new mj.MjData(this.model);
    this.dt = this.model.opt.timestep;
    this.start = wristToMj(grasp.wrist);
    // Start just short of the planned contact pose: the planner computed a static grasp, and closing from wide
    // open lets the first finger to arrive knock the object away before the others get there. (The page animates
    // the reach from the open pre-shape to here before handing over to physics.)
    // The servos then aim past the contact pose along the closing direction, which is what squeezes.
    this.preshape = alongClosing(grasp, -0.08);
    this.targets = alongClosing(grasp, 0.25);
    // qpos: the object's free joint, the hand's free joint, then the finger joints.
    const joint = (name: string) => mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_JOINT.value, name);
    const adr = this.model.jnt_qposadr as Int32Array;
    this.qpos0 = adr[joint('j0')];
    const q = this.data.qpos as Float64Array;
    for (let j = 0; j < JOINTS; j++) q[this.qpos0 + j] = this.preshape[j];
    if (joint('hand') >= 0) {
      q.set(this.start.pos, adr[joint('hand')]);
      q.set(this.start.quat, adr[joint('hand')] + 3);
    }
    // The hand body (or, in a scene where the hand is the mocap body itself, the target).
    const body = (name: string) => mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_BODY.value, name);
    this.handBody = body('hand') >= 0 ? body('hand') : body('target');
    this.setWrist(0);
    mj.mj_forward(this.model, this.data);
    this.objectStart = [q[0], q[1], q[2]];
  }

  get phaseEnd(): number {
    const d = this.durations;
    return d.close + d.hold + d.lift + d.settle;
  }

  private setWrist(lift: number): void {
    const mp = this.data.mocap_pos as Float64Array;
    const mq = this.data.mocap_quat as Float64Array;
    mp[0] = this.start.pos[0];
    mp[1] = this.start.pos[1];
    mp[2] = this.start.pos[2] + lift;
    mq.set(this.start.quat);
  }

  /** Advance one physics step through close → hold → lift → settle. */
  step(): void {
    const d = this.durations;
    const t = this.time;
    const ctrl = this.data.ctrl as Float64Array;
    const c = Math.min(1, t / d.close);
    const s = c * c * (3 - 2 * c);
    for (let j = 0; j < JOINTS; j++) ctrl[j] = this.preshape[j] + (this.targets[j] - this.preshape[j]) * s;
    const lt = Math.min(1, Math.max(0, (t - d.close - d.hold) / d.lift));
    const lift = 0.2 * lt * lt * (3 - 2 * lt);
    this.setWrist(lift);
    if (Math.abs(t - d.close - d.hold) < this.dt / 2) {
      const q = this.data.qpos as Float64Array;
      const h = this.handPos();
      this.relStart = [q[0] - h[0], q[1] - h[1], q[2] - h[2]];
    }
    this.mj.mj_step(this.model, this.data);
    this.time += this.dt;
  }

  /** The hand body's position (it follows the target through the weld). */
  handPos(): number[] {
    const x = this.data.xpos as Float64Array;
    const b = this.handBody * 3;
    return [x[b], x[b + 1], x[b + 2]];
  }

  result(): LiftResult {
    const q = this.data.qpos as Float64Array;
    const h = this.handPos();
    const rise = q[2] - this.objectStart[2];
    const slip = Math.hypot(q[0] - h[0] - this.relStart[0], q[1] - h[1] - this.relStart[1], q[2] - h[2] - this.relStart[2]);
    return { rise, slip, held: rise > 0.15 && slip < 0.03 };
  }

  dispose(): void {
    this.data.delete();
    this.model.delete();
  }
}

/**
 * The planner proposes, physics disposes: lift-test candidates in ranked order until one holds. Returns the
 * index of the first that held (−1 if none of the first `max` did) and every result tried.
 */
export function firstThatHolds(mj: MainModule, shape: Shape, grasps: Grasp[], max = 8): { index: number; results: LiftResult[] } {
  const results: LiftResult[] = [];
  for (let i = 0; i < Math.min(max, grasps.length); i++) {
    const r = liftTest(mj, shape, grasps[i]);
    results.push(r);
    if (r.held) return { index: i, results };
  }
  return { index: -1, results };
}

/** Run the whole lift test headlessly. */
export function liftTest(mj: MainModule, shape: Shape, grasp: Grasp, xml?: string): LiftResult {
  const sim = new GraspSim(mj, shape, grasp, xml);
  while (sim.time < sim.phaseEnd) sim.step();
  const r = sim.result();
  sim.dispose();
  return r;
}
