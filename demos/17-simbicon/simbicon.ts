import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';

/**
 * SIMBICON (Yin, Loken & van de Panne, SIGGRAPH 2007) on a 3D torque-driven biped in MuJoCo.
 *
 * Nothing holds the character up. Every 0.5 ms the controller computes joint torques from:
 *   1. a two-state machine — left stance, right stance — switching on time or swing-foot contact;
 *   2. PD control toward per-state target angles (knees, ankles, the swing hip);
 *   3. balance feedback: the swing hip's target, in the world frame, moves with the centre of mass's
 *      distance d from the stance ankle and its velocity v —   θ = θ₀ + c_d·d + c_v·v   — in both the sagittal
 *      and the coronal plane, so a push forward makes the next step longer and a push sideways steps wider;
 *   4. the torso, controlled in the world frame, and the stance hip taking the reaction: τ_stance = τ_torso − τ_swing.
 */

export interface Gait {
  name: string;
  /** Seconds per step (state duration). */
  stepTime: number;
  /** Swing hip (world frame), swing knee, swing ankle; stance knee, stance ankle (rad). */
  swingHip: number;
  swingKnee: number;
  swingAnkle: number;
  stanceKnee: number;
  stanceAnkle: number;
  /** Torso lean forward (rad). */
  lean: number;
  /** Sagittal and coronal balance feedback gains. */
  cd: number;
  cv: number;
  cdLat: number;
  cvLat: number;
  /** Swing hip abduction (world, outward) at d = v = 0. */
  swingAbd: number;
  /** Fastest the steered heading may turn (rad/s): faster gaits need gentler turns. */
  maxTurnRate: number;
}

const BASE: Gait = { name: 'base', stepTime: 0.3, swingHip: 0.5, swingKnee: 1.1, swingAnkle: 0.25, stanceKnee: 0.05, stanceAnkle: 0, lean: 0.05, cd: 0.5, cv: 0.2, cdLat: 0.5, cvLat: 0.2, swingAbd: 0.05, maxTurnRate: 0.6 };

/**
 * Found by parameter sweeps (see the write-up). Torso lean drives speed; weaker sagittal feedback (c_d, c_v)
 * lets steps lengthen. Slow gaits without heading control fell into a stable sideways crab; faster ones get
 * fragile quickly — the walk takes a 0.4 m/s sideways shove, the stroll 0.8.
 */
export const GAITS: Record<string, Gait> = {
  stroll: { ...BASE, name: 'stroll', lean: 0.1 },
  walk: { ...BASE, name: 'walk', cd: 0.35, cv: 0.12, lean: 0.12, maxTurnRate: 0.2 },
};

const KP = { hip: 400, knee: 300, ankle: 60, torso: 500, rot: 100, roll: 60, yaw: 100 };
const KD = { hip: 40, knee: 30, ankle: 6, torso: 50, rot: 10, roll: 6, yaw: 30 };

/** qpos / qvel / ctrl offsets of each leg's joints (abd, flex, rot, knee, ankle pitch, ankle roll). */
const LEG = [
  { side: 1, q: 7, v: 6, u: 0 },
  { side: -1, q: 13, v: 12, u: 6 },
];

export interface ControllerState {
  stance: 0 | 1;
  phase: number;
  steps: number;
  com: number[];
  comVel: number[];
  /** Heading frame: torso yaw. */
  heading: number;
  pitch: number;
  roll: number;
  /** Balance feedback terms of the current step (for the overlay). */
  d: number;
  v: number;
  dLat: number;
  vLat: number;
}

export class Simbicon {
  readonly model: MjModel;
  readonly data: MjData;
  gait: Gait = { ...GAITS.walk };
  /** The gait in use this step: blends toward `gait` step by step, so switching gaits is not a jolt. */
  active: Gait = { ...this.gait };
  /** Desired heading (rad, about +z); the swing hip turns toward it a little every step. */
  targetHeading = 0;
  /** The heading actually steered toward: follows targetHeading at most `maxTurnRate` rad/s. */
  steerHeading = 0;
  readonly state: ControllerState = { stance: 0, phase: 0, steps: 0, com: [0, 0, 0], comVel: [0, 0, 0], heading: 0, pitch: 0, roll: 0, d: 0, v: 0, dLat: 0, vLat: 0 };
  readonly torque = new Float64Array(12);
  private readonly feet: number[];
  private readonly footGeoms: number[];
  private readonly floor: number;
  private readonly prevCom = [0, 0, 0];
  readonly dt: number;

  constructor(
    readonly mj: MainModule,
    xml: string,
  ) {
    this.model = mj.MjModel.from_xml_string(xml);
    this.data = new mj.MjData(this.model);
    this.dt = this.model.opt.timestep;
    const id = (type: number, n: string) => mj.mj_name2id(this.model, type, n);
    this.feet = ['L_foot', 'R_foot'].map((n) => id(mj.mjtObj.mjOBJ_BODY.value, n));
    this.footGeoms = ['L_foot', 'R_foot'].map((n) => id(mj.mjtObj.mjOBJ_GEOM.value, n));
    this.floor = id(mj.mjtObj.mjOBJ_GEOM.value, 'floor');
    this.reset();
  }

  reset(): void {
    const { mj, model, data } = this;
    mj.mj_resetData(model, data);
    data.qpos[2] = 1.0;
    // Start mid-stride on the left foot: right thigh slightly back, left slightly forward.
    data.qpos[LEG[0].q + 1] = 0.1;
    data.qpos[LEG[1].q + 1] = -0.1;
    mj.mj_forward(model, data);
    Object.assign(this.state, { stance: 0, phase: 0, steps: 0 });
    this.targetHeading = this.steerHeading = 0;
    this.active = { ...this.gait };
    this.measure();
    this.prevCom.splice(0, 3, ...this.state.com);
    this.state.comVel = [0, 0, 0];
  }

  /** Whole-body centre of mass, torso heading/pitch/roll. */
  private measure(): void {
    const d = this.data;
    const c = d.subtree_com as Float64Array;
    this.state.com = [c[3], c[4], c[5]]; // body 1 (torso) subtree = the whole character
    const q = d.qpos as Float64Array;
    const [w, x, y, z] = [q[3], q[4], q[5], q[6]];
    // Torso up and forward axes in the world.
    const up = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
    const fwd = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
    const h = Math.atan2(fwd[1], fwd[0]);
    this.state.heading = h;
    const ch = Math.cos(h);
    const sh = Math.sin(h);
    const upF = ch * up[0] + sh * up[1];
    const upL = -sh * up[0] + ch * up[1];
    this.state.pitch = Math.atan2(upF, up[2]);
    this.state.roll = Math.atan2(upL, up[2]);
  }

  /** Which feet touch the floor. `data.contact` is a copy (a C++ vector), so it is read once per step and freed. */
  private readContacts(out: boolean[]): void {
    out[0] = out[1] = false;
    const n = this.data.ncon;
    if (n === 0) return;
    const cons = this.data.contact;
    for (let i = 0; i < n; i++) {
      const c = cons.get(i);
      if (!c) continue;
      const other = c.geom1 === this.floor ? c.geom2 : c.geom2 === this.floor ? c.geom1 : -1;
      // Each element is a C++ object too: without this, 2 000 steps a second exhaust the WASM heap.
      c.delete();
      if (other === this.footGeoms[0]) out[0] = true;
      if (other === this.footGeoms[1]) out[1] = true;
    }
    cons.delete();
  }

  /** One physics step: controller, then mj_step. */
  step(): void {
    const { mj, model, data } = this;
    const s = this.state;
    let g = this.active;
    this.measure();
    for (let k = 0; k < 3; k++) {
      s.comVel[k] += ((s.com[k] - this.prevCom[k]) / this.dt - s.comVel[k]) * 0.05; // light filter
      this.prevCom[k] = s.com[k];
    }

    // State machine.
    s.phase += this.dt;
    const swing = 1 - s.stance;
    if (s.phase > g.stepTime || (s.phase > 0.1 && this.footContactCached(swing))) {
      s.stance = swing as 0 | 1;
      s.phase = 0;
      s.steps++;
      // Gait changes take effect at step boundaries.
      const goal = this.gait;
      // Parameters glide a third of the way per step: an abrupt change is itself a push.
      const next = { ...goal };
      for (const k of Object.keys(goal) as (keyof Gait)[]) {
        const a = this.active[k];
        const b = goal[k];
        if (typeof a === 'number' && typeof b === 'number') (next as Record<string, unknown>)[k] = a + (b - a) * 0.35;
      }
      this.active = next;
      g = this.active;
    }
    const st = LEG[s.stance];
    const sw = LEG[1 - s.stance];

    // Balance feedback in the heading frame.
    const ankle = data.xpos as Float64Array;
    const a = this.feet[s.stance] * 3;
    const ch = Math.cos(s.heading);
    const sh = Math.sin(s.heading);
    const dx = s.com[0] - ankle[a];
    const dy = s.com[1] - ankle[a + 1];
    s.d = ch * dx + sh * dy;
    s.v = ch * s.comVel[0] + sh * s.comVel[1];
    // Coronal: measured toward the swing leg's side.
    s.dLat = sw.side * (-sh * dx + ch * dy);
    s.vLat = sw.side * (-sh * s.comVel[0] + ch * s.comVel[1]);
    const q = data.qpos as Float64Array;
    const qd = data.qvel as Float64Array;
    const pd = (target: number, qi: number, vi: number, kp: number, kd: number) => kp * (target - q[qi]) - kd * qd[vi];

    // Torso PD in the world frame (forward-lean and roll-left torques).
    // Pitch rate: rotation about the heading frame's left axis; roll-left rate: about its backward axis.
    const om = this.worldOmega();
    const wF = -sh * om[0] + ch * om[1];
    const wL = -(ch * om[0] + sh * om[1]);
    const tPitch = KP.torso * (g.lean - s.pitch) - KD.torso * wF;
    const tRoll = KP.torso * (0 - s.roll) - KD.torso * wL;

    const tau = this.torque;
    tau.fill(0);
    // Swing hip: world-frame targets, so the torso's tilt is added back.
    const swingFlex = g.swingHip + g.cd * s.d + g.cv * s.v + s.pitch;
    const swingAbd = g.swingAbd + g.cdLat * s.dLat + g.cvLat * s.vLat + sw.side * s.roll;
    tau[sw.u + 1] = pd(swingFlex, sw.q + 1, sw.v + 1, KP.hip, KD.hip);
    tau[sw.u + 0] = pd(swingAbd, sw.q + 0, sw.v + 0, KP.hip, KD.hip);
    // Turning: the swing leg lands rotated toward the desired heading.
    // A sudden 180° request is a stumble in the making: the steered heading turns at a bounded rate.
    let want = this.targetHeading - this.steerHeading;
    want = Math.atan2(Math.sin(want), Math.cos(want));
    const maxTurn = g.maxTurnRate * this.dt;
    this.steerHeading += Math.max(-maxTurn, Math.min(maxTurn, want));
    let turn = this.steerHeading - s.heading;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    tau[sw.u + 2] = pd(Math.max(-0.2, Math.min(0.2, turn * 0.4)) * sw.side, sw.q + 2, sw.v + 2, KP.rot, KD.rot);
    tau[sw.u + 3] = pd(g.swingKnee, sw.q + 3, sw.v + 3, KP.knee, KD.knee);
    tau[sw.u + 4] = pd(g.swingAnkle, sw.q + 4, sw.v + 4, KP.ankle, KD.ankle);
    tau[sw.u + 5] = pd(0, sw.q + 5, sw.v + 5, KP.roll, KD.roll);

    // Stance hip: whatever makes the torso's net torque equal the torso PD's.
    tau[st.u + 1] = tPitch - tau[sw.u + 1];
    tau[st.u + 0] = st.side * (tRoll - sw.side * tau[sw.u + 0]);
    // Heading, like pitch and roll, is a world-frame torso target carried by the stance hip (rotation joints
    // turn about ±z by side): torso yaw torque = −side_st·τ_st − side_sw·τ_sw.
    const tYaw = KP.yaw * turn - KD.yaw * om[2];
    tau[st.u + 2] = -st.side * (tYaw + sw.side * tau[sw.u + 2]);
    tau[st.u + 3] = pd(g.stanceKnee, st.q + 3, st.v + 3, KP.knee, KD.knee);
    tau[st.u + 4] = pd(g.stanceAnkle, st.q + 4, st.v + 4, KP.ankle, KD.ankle);
    tau[st.u + 5] = pd(0, st.q + 5, st.v + 5, KP.roll, KD.roll);

    const ctrl = data.ctrl as Float64Array;
    for (let i = 0; i < 12; i++) ctrl[i] = tau[i];
    mj.mj_step(model, data);
    this.contactDirty = true;
  }

  private contactDirty = true;
  private readonly contactCache = [false, false];
  private footContactCached(leg: number): boolean {
    if (this.contactDirty) {
      this.readContacts(this.contactCache);
      this.contactDirty = false;
    }
    return this.contactCache[leg];
  }

  /** Torso angular velocity in the world frame (qvel of a free joint is in the body frame). */
  private readonly omega = [0, 0, 0];
  worldOmega(): number[] {
    const q = this.data.qpos as Float64Array;
    const v = this.data.qvel as Float64Array;
    const [w, x, y, z] = [q[3], q[4], q[5], q[6]];
    const [bx, by, bz] = [v[3], v[4], v[5]];
    // R · ω_body
    this.omega[0] = (1 - 2 * (y * y + z * z)) * bx + 2 * (x * y - w * z) * by + 2 * (x * z + w * y) * bz;
    this.omega[1] = 2 * (x * y + w * z) * bx + (1 - 2 * (x * x + z * z)) * by + 2 * (y * z - w * x) * bz;
    this.omega[2] = 2 * (x * z - w * y) * bx + 2 * (y * z + w * x) * by + (1 - 2 * (x * x + y * y)) * bz;
    return this.omega;
  }

  /** Has the character fallen (torso low or tipped)? */
  get fallen(): boolean {
    return this.data.qpos[2] < 0.6 || Math.abs(this.state.pitch) > 1.0 || Math.abs(this.state.roll) > 1.0;
  }

  /** Push the torso: add a velocity change (m/s) in the world frame. */
  push(vx: number, vy: number): void {
    this.data.qvel[0] += vx;
    this.data.qvel[1] += vy;
  }

  dispose(): void {
    this.data.delete();
    this.model.delete();
  }
}
