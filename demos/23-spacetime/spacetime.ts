import { DOF, FOOT, inverseDynamics, jointPositions, SOLE, TOTAL_MASS, G } from './luxo';

/**
 * Spacetime constraints (Witkin & Kass, SIGGRAPH 1988): the whole motion is the unknown, chosen to
 *
 *   minimise    ∫ |τ(t)|² dt                      (muscle effort: the three joint torques)
 *   subject to  on the ground: the floor can supply what the base needs — it pushes and never pulls, inside the
 *               friction cone, with the centre of pressure on the sole
 *               in the air: nothing outside acts on the lamp
 *               land on the target, upright; rest pose and stillness at both ends; clear of the floor (and a
 *               hurdle) in flight
 *
 * The unknowns are the three joint angles over time, each a uniform cubic B-spline. The base is not free to be
 * chosen: on the ground it stands still, and in the air its motion is integrated from its own equations of
 * motion with zero external force — M_bb q̈_b = −(M_bj θ̈ + h_b) — so it goes exactly where the arm's motion
 * flings it. Flight is therefore Newtonian by construction (Witkin & Kass imposed it as a constraint instead);
 * the optimiser only has to choose a motion that is effortless, possible on the ground, and lands on target.
 * Solved by Levenberg–Marquardt with a finite-difference Jacobian.
 */

export interface JumpSpec {
  /** Horizontal distance and height difference between take-off and landing (m). */
  distance: number;
  rise: number;
  /** Stance before take-off, flight, stance after landing (s). */
  stance1: number;
  flight: number;
  stance2: number;
  /** Optional hurdle: height (m) at the middle of the flight; 0 = none. */
  hurdle: number;
  friction: number;
}

/** Rest pose: base on the floor, the lamp crouched a little, head forward (+x). */
export const REST: number[] = [0, -SOLE, 0, -0.45, 1.15, -1.0];

const K = 20; // control points per joint
const N = 160; // collocation points
export const FLIGHT_STEP = 1 / 600;

function basis(u: number, d: number, out: number[]): void {
  const u2 = u * u;
  const u3 = u2 * u;
  if (d === 0) {
    out[0] = (1 - 3 * u + 3 * u2 - u3) / 6;
    out[1] = (4 - 6 * u2 + 3 * u3) / 6;
    out[2] = (1 + 3 * u + 3 * u2 - 3 * u3) / 6;
    out[3] = u3 / 6;
  } else if (d === 1) {
    out[0] = (-3 + 6 * u - 3 * u2) / 6;
    out[1] = (-12 * u + 9 * u2) / 6;
    out[2] = (3 + 6 * u - 9 * u2) / 6;
    out[3] = (3 * u2) / 6;
  } else {
    out[0] = 1 - u;
    out[1] = -2 + 3 * u;
    out[2] = 1 - 3 * u;
    out[3] = u;
  }
}

export interface FlightSample {
  t: number;
  base: [number, number, number];
  baseVel: [number, number, number];
  tau: [number, number, number];
}

type Sim = { samples: FlightSample[]; landing: [number, number, number]; landingVel: [number, number, number] };

export class Jump {
  /** Joint control points: K per joint, joint-major. */
  readonly p = new Float64Array(3 * K);
  readonly T: number;
  private readonly dt: number;
  iterations = 0;
  lambda = 1e-2;
  cost = Infinity;
  terms: Record<string, number> = {};
  /** The flight (base path and torques) of the current solution, at FLIGHT_STEP. */
  flight: FlightSample[] = [];
  /** Where the base comes down. */
  landing: [number, number, number] = [0, 0, 0];
  landingVel: [number, number, number] = [0, 0, 0];

  constructor(public spec: JumpSpec) {
    this.T = spec.stance1 + spec.flight + spec.stance2;
    this.dt = this.T / (K - 3);
    // Starting guess, an animator's: settle into a crouch, extend hard into take-off, tuck in the air, absorb the
    // landing, return to rest. The optimiser keeps the idea and fixes the physics.
    const crouch = [-0.9, 2.0, -1.6];
    const extend = [0.15, 0.25, -0.3];
    const tuck = [-0.6, 1.5, -1.2];
    const keys: [number, number[]][] = [
      [0, REST.slice(3)],
      [spec.stance1 * 0.7, crouch],
      [spec.stance1, extend],
      [spec.stance1 + spec.flight * 0.6, tuck],
      [spec.stance1 + spec.flight + 0.12, crouch],
      [this.T, REST.slice(3)],
    ];
    for (let c = 0; c < K; c++) {
      const t = Math.min(this.T, Math.max(0, (c - 1) * this.dt));
      let k = 0;
      while (k < keys.length - 2 && keys[k + 1][0] < t) k++;
      const [ta, va] = keys[k];
      const [tb, vb] = keys[k + 1];
      const u = Math.min(1, Math.max(0, (t - ta) / (tb - ta)));
      const e = u * u * (3 - 2 * u);
      for (let j = 0; j < 3; j++) this.p[j * K + c] = va[j] + (vb[j] - va[j]) * e;
    }
    this.adopt(this.simulate(this.p));
  }

  get t1(): number {
    return this.spec.stance1;
  }
  get t2(): number {
    return this.spec.stance1 + this.spec.flight;
  }

  /** Joint angles (d = 0), velocities (1) or accelerations (2) at t. */
  joints(t: number, d: number, out: Float64Array | number[], p: ArrayLike<number> = this.p): void {
    const x = Math.min(K - 3 - 1e-9, Math.max(0, t / this.dt));
    const s = Math.floor(x);
    const b = [0, 0, 0, 0];
    basis(x - s, d, b);
    const scale = d === 0 ? 1 : d === 1 ? 1 / this.dt : 1 / (this.dt * this.dt);
    for (let j = 0; j < 3; j++) {
      let v = 0;
      for (let i = 0; i < 4; i++) v += b[i] * p[j * K + s + i];
      out[j] = v * scale;
    }
  }

  /**
   * Integrate the flight: the base under zero external force while the joints follow the splines (RK4). Base
   * accelerations solve the base rows of M q̈ = Q − h with Q_base = 0.
   */
  simulate(p: ArrayLike<number>): Sim {
    const s = this.spec;
    const base = [0, REST[1], 0];
    const vel = [0, 0, 0];
    const samples: FlightSample[] = [];
    const jq = new Float64Array(3);
    const jd = new Float64Array(3);
    const ja = new Float64Array(3);
    const q = new Float64Array(DOF);
    const qd = new Float64Array(DOF);
    const qdd = new Float64Array(DOF);
    const Q = new Float64Array(DOF);
    const Qb = new Float64Array(DOF);
    const accel = (t: number, b: number[], v: number[], out: number[]) => {
      this.joints(t, 0, jq, p);
      this.joints(t, 1, jd, p);
      this.joints(t, 2, ja, p);
      for (let i = 0; i < 3; i++) {
        q[i] = b[i];
        qd[i] = v[i];
        q[3 + i] = jq[i];
        qd[3 + i] = jd[i];
        qdd[3 + i] = ja[i];
        qdd[i] = 0;
      }
      // Base rows: M_bb a + (M_bj θ̈ + h_b) = 0. ID with zero base acceleration gives M_bj θ̈ + h_b; M_bb by unit
      // base accelerations.
      inverseDynamics(q, qd, qdd, Q);
      const cols: number[][] = [];
      for (let c = 0; c < 3; c++) {
        qdd[c] = 1;
        inverseDynamics(q, qd, qdd, Qb);
        cols.push([Qb[0] - Q[0], Qb[1] - Q[1], Qb[2] - Q[2]]);
        qdd[c] = 0;
      }
      const a = solve3(
        [
          [cols[0][0], cols[1][0], cols[2][0]],
          [cols[0][1], cols[1][1], cols[2][1]],
          [cols[0][2], cols[1][2], cols[2][2]],
        ],
        [-Q[0], -Q[1], -Q[2]],
      );
      out[0] = a[0];
      out[1] = a[1];
      out[2] = a[2];
    };
    const h = FLIGHT_STEP;
    const steps = Math.round(s.flight / h);
    const k1 = [0, 0, 0];
    const k2 = [0, 0, 0];
    const k3 = [0, 0, 0];
    const k4 = [0, 0, 0];
    const tb = [0, 0, 0];
    const tv = [0, 0, 0];
    for (let i = 0; i <= steps; i++) {
      const t = this.t1 + i * h;
      accel(t, base, vel, k1);
      // Joint torques at this instant: inverse dynamics with the solved base accelerations.
      for (let c = 0; c < 3; c++) qdd[c] = k1[c];
      inverseDynamics(q, qd, qdd, Q);
      samples.push({ t, base: [base[0], base[1], base[2]], baseVel: [vel[0], vel[1], vel[2]], tau: [Q[3], Q[4], Q[5]] });
      if (i === steps) break;
      for (let c = 0; c < 3; c++) (tb[c] = base[c] + (vel[c] * h) / 2), (tv[c] = vel[c] + (k1[c] * h) / 2);
      const v2 = tv.slice();
      accel(t + h / 2, tb, tv, k2);
      for (let c = 0; c < 3; c++) (tb[c] = base[c] + (v2[c] * h) / 2), (tv[c] = vel[c] + (k2[c] * h) / 2);
      const v3 = tv.slice();
      accel(t + h / 2, tb, tv, k3);
      for (let c = 0; c < 3; c++) (tb[c] = base[c] + v3[c] * h), (tv[c] = vel[c] + k3[c] * h);
      const v4 = tv.slice();
      accel(t + h, tb, tv, k4);
      for (let c = 0; c < 3; c++) {
        base[c] += (h / 6) * (vel[c] + 2 * v2[c] + 2 * v3[c] + v4[c]);
        vel[c] += (h / 6) * (k1[c] + 2 * k2[c] + 2 * k3[c] + k4[c]);
      }
    }
    return { samples, landing: [base[0], base[1], base[2]], landingVel: [vel[0], vel[1], vel[2]] };
  }

  /** The full state at time t: base (held, flying or landed) and joints. */
  state(t: number, out = new Float64Array(DOF)): Float64Array {
    const j = [0, 0, 0];
    this.joints(t, 0, j);
    out[3] = j[0];
    out[4] = j[1];
    out[5] = j[2];
    if (t <= this.t1 || this.flight.length === 0) {
      out[0] = 0;
      out[1] = REST[1];
      out[2] = 0;
    } else if (t < this.t2) {
      const f = (t - this.t1) / FLIGHT_STEP;
      const i = Math.min(this.flight.length - 2, Math.floor(f));
      const a = f - i;
      for (let c = 0; c < 3; c++) out[c] = this.flight[i].base[c] * (1 - a) + this.flight[i + 1].base[c] * a;
    } else {
      // Landed: the impact stops the base where it came down, on the floor.
      out[0] = this.landing[0];
      out[1] = REST[1] + this.spec.rise;
      out[2] = 0;
    }
    return out;
  }

  /** Joint torques and the ground's force and moment on the base (zero in flight) at time t. */
  forces(t: number): { tau: [number, number, number]; ground: [number, number, number] } {
    if (t > this.t1 && t < this.t2 && this.flight.length) {
      const i = Math.min(this.flight.length - 1, Math.round((t - this.t1) / FLIGHT_STEP));
      return { tau: this.flight[i].tau, ground: [0, 0, 0] };
    }
    const q = this.state(t);
    const qd = new Float64Array(DOF);
    const qdd = new Float64Array(DOF);
    const j = [0, 0, 0];
    this.joints(t, 1, j);
    qd.set(j, 3);
    this.joints(t, 2, j);
    qdd.set(j, 3);
    const Q = inverseDynamics(q, qd, qdd, new Float64Array(DOF));
    return { tau: [Q[3], Q[4], Q[5]], ground: [Q[0], Q[1], Q[2]] };
  }

  private residualsFor(p: ArrayLike<number>): { r: number[]; sim: Sim } {
    const s = this.spec;
    const sim = this.simulate(p);
    const r: number[] = [];
    const mg = TOTAL_MASS * G;
    const w = Math.sqrt(this.T / N);
    const q = new Float64Array(DOF);
    const qd = new Float64Array(DOF);
    const qdd = new Float64Array(DOF);
    const j = [0, 0, 0];
    const C = 40;
    // Stance: effort, and the ground's ability to supply what the base needs.
    for (let k = 0; k < N; k++) {
      const t = (this.T * (k + 0.5)) / N;
      if (t > this.t1 && t < this.t2) continue;
      const landed = t >= this.t2;
      q[0] = landed ? sim.landing[0] : 0;
      q[1] = REST[1] + (landed ? s.rise : 0);
      q[2] = 0;
      this.joints(t, 0, j, p);
      q.set(j, 3);
      qd.fill(0);
      this.joints(t, 1, j, p);
      qd.set(j, 3);
      qdd.fill(0);
      this.joints(t, 2, j, p);
      qdd.set(j, 3);
      const Q = inverseDynamics(q, qd, qdd, new Float64Array(DOF));
      r.push(w * Q[3], w * Q[4], w * Q[5]);
      const fx = Q[0];
      const fy = Q[1];
      const moment = Q[2] + SOLE * fx; // about the sole's centre; the centre of pressure is moment / fy
      r.push((C * Math.max(0, -fy)) / mg);
      r.push((C * Math.max(0, Math.abs(fx) - s.friction * fy)) / mg);
      r.push((4 * C * Math.max(0, Math.abs(moment) - FOOT * 0.85 * Math.max(0, fy))) / (mg * FOOT));
      r.push(...this.clearance(q));
    }
    // Flight: effort and clearance (sampled).
    const every = Math.max(1, Math.round(sim.samples.length / 30));
    for (let i = 0; i < sim.samples.length; i += every) {
      const f = sim.samples[i];
      const ww = Math.sqrt((s.flight / sim.samples.length) * every);
      r.push(ww * f.tau[0], ww * f.tau[1], ww * f.tau[2]);
      const sole = f.base[1] + SOLE;
      let floor = Math.min(0, s.rise) - 0.005;
      if (s.hurdle > 0 && Math.abs(f.base[0] - s.distance / 2) < 0.08) floor = Math.max(floor, s.hurdle);
      r.push(C * 4 * Math.max(0, floor - sole));
      q[0] = f.base[0];
      q[1] = f.base[1];
      q[2] = f.base[2];
      this.joints(f.t, 0, j, p);
      q.set(j, 3);
      r.push(...this.clearance(q));
    }
    // Land on target, upright, on the floor (the impact absorbs the velocity).
    r.push(C * 2 * (sim.landing[0] - s.distance), C * 2 * (sim.landing[1] - (REST[1] + s.rise)), C * sim.landing[2]);
    // Rest pose and stillness at both ends.
    for (const t of [0, this.T]) {
      this.joints(t, 0, j, p);
      for (let c = 0; c < 3; c++) r.push(C * (j[c] - REST[3 + c]));
      this.joints(t, 1, j, p);
      for (let c = 0; c < 3; c++) r.push(C * 0.2 * j[c]);
    }
    return { r, sim };
  }

  /** The total cost Σ r² of a candidate (for a sampling optimiser). */
  objective(p: ArrayLike<number>): number {
    const { r } = this.residualsFor(p);
    return dot(r, r);
  }

  /** Adopt a candidate as the current solution. */
  set(p: ArrayLike<number>): void {
    this.p.set(p);
    const res = this.residualsFor(this.p);
    this.cost = dot(res.r, res.r);
    this.adopt(res.sim);
  }

  /** Floor height under x: the step's top past its edge. */
  floorAt(x: number): number {
    return this.spec.rise > 0 && x > this.spec.distance - 0.15 ? this.spec.rise : 0;
  }

  /** Elbow, neck and head tip stay above the floor (the base has its own constraints). */
  private clearance(q: ArrayLike<number>): number[] {
    const pts = jointPositions(q);
    return [2, 3, 4].map((i) => 160 * Math.max(0, this.floorAt(pts[i][0]) + 0.025 - pts[i][1]));
  }

  /** One Levenberg–Marquardt iteration; returns the cost after it. */
  iterate(): number {
    const n = this.p.length;
    const { r } = this.residualsFor(this.p);
    const m = r.length;
    const cost0 = dot(r, r);
    const J = new Float64Array(m * n);
    const pt = new Float64Array(this.p);
    const h = 1e-6;
    for (let col = 0; col < n; col++) {
      pt[col] += h;
      const rp = this.residualsFor(pt).r;
      for (let i = 0; i < m; i++) J[i * n + col] = (rp[i] - r[i]) / h;
      pt[col] -= h;
    }
    const A = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let row = 0; row < m; row++) {
      for (let a = 0; a < n; a++) {
        const ja = J[row * n + a];
        if (ja === 0) continue;
        g[a] += ja * r[row];
        for (let b = 0; b < n; b++) A[a * n + b] += ja * J[row * n + b];
      }
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const M = new Float64Array(A);
      for (let a = 0; a < n; a++) M[a * n + a] += this.lambda * (A[a * n + a] + 1e-9);
      const delta = cholesky(M, Array.from(g, (v) => -v), n);
      const trial = new Float64Array(this.p);
      for (let a = 0; a < n; a++) trial[a] += delta[a];
      const res = this.residualsFor(trial);
      const cost = dot(res.r, res.r);
      if (cost < cost0) {
        this.p.set(trial);
        this.lambda = Math.max(1e-7, this.lambda / 3);
        this.cost = cost;
        this.iterations++;
        this.adopt(res.sim);
        return cost;
      }
      this.lambda *= 4;
    }
    this.cost = cost0;
    return cost0;
  }

  private adopt(sim: Sim): void {
    this.flight = sim.samples;
    this.landing = sim.landing;
    this.landingVel = sim.landingVel;
    let effort = 0;
    for (let k = 0; k < 200; k++) {
      const t = (this.T * (k + 0.5)) / 200;
      const f = this.forces(t);
      effort += (f.tau[0] ** 2 + f.tau[1] ** 2 + f.tau[2] ** 2) * (this.T / 200);
    }
    this.terms = { effort, landingError: Math.hypot(sim.landing[0] - this.spec.distance, sim.landing[1] - REST[1] - this.spec.rise), landingTilt: sim.landing[2] };
  }

  /** The ground force over the stance phases: worst push-only, friction and centre-of-pressure values. */
  contactCheck(): { minFy: number; maxFriction: number; maxCop: number } {
    let minFy = Infinity;
    let maxFriction = 0;
    let maxCop = 0;
    for (let k = 0; k < 400; k++) {
      const t = (this.T * (k + 0.5)) / 400;
      if (t > this.t1 && t < this.t2) continue;
      const [fx, fy, mz] = this.forces(t).ground;
      minFy = Math.min(minFy, fy);
      if (fy > 1e-6) {
        maxFriction = Math.max(maxFriction, Math.abs(fx) / fy);
        maxCop = Math.max(maxCop, Math.abs((mz + SOLE * fx) / fy));
      }
    }
    return { minFy, maxFriction, maxCop };
  }
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function solve3(A: number[][], b: number[]): number[] {
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  return [0, 1, 2].map((c) => det(A.map((row, i) => row.map((v, k) => (k === c ? b[i] : v)))) / D);
}

function cholesky(A: Float64Array, b: number[], n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j];
    }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/**
 * The animator's version, for comparison: the same starting key poses, with the base simply carried along a
 * pleasing arc through the air. It looks plausible; `invisible` is the outside force the base would need in
 * flight to move like that — zero for any real jump.
 */
export function keyframed(spec: JumpSpec): { state(t: number): Float64Array; invisible(t: number): [number, number, number] } {
  const j = new Jump(spec);
  const H = 0.12 + spec.hurdle;
  const base = (t: number): [number, number, number] => {
    const s = Math.min(1, Math.max(0, (t - j.t1) / spec.flight));
    const e = s * s * (3 - 2 * s);
    return [spec.distance * e, REST[1] + spec.rise * e + 4 * H * s * (1 - s), 0];
  };
  const state = (t: number) => {
    const q = new Float64Array(DOF);
    const b = base(t);
    q[0] = b[0];
    q[1] = b[1];
    q[2] = b[2];
    const jj = [0, 0, 0];
    j.joints(t, 0, jj);
    q.set(jj, 3);
    return q;
  };
  const invisible = (t: number): [number, number, number] => {
    if (t <= j.t1 || t >= j.t2) return [0, 0, 0];
    const h = 1e-3;
    const q = state(t);
    const qp = state(t + h);
    const qm = state(t - h);
    const qd = new Float64Array(DOF);
    const qdd = new Float64Array(DOF);
    for (let i = 0; i < DOF; i++) {
      qd[i] = (qp[i] - qm[i]) / (2 * h);
      qdd[i] = (qp[i] - 2 * q[i] + qm[i]) / (h * h);
    }
    const Q = inverseDynamics(q, qd, qdd, new Float64Array(DOF));
    return [Q[0], Q[1], Q[2]];
  };
  return { state, invisible };
}
