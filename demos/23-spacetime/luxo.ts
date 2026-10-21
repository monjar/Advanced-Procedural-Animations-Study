/**
 * A planar Luxo lamp (Witkin & Kass's character): a base on the ground, two arm links and a heavy head, joined
 * by three hinges. Generalised coordinates q = (x, y, φ, θ₁, θ₂, θ₃): the base's position and tilt, then the
 * joint angles. Link i's absolute angle is φ + θ₁ + … + θᵢ; at zero every link points straight up.
 *
 * Dynamics by virtual work: the generalised force needed for a motion is
 *
 *   Qⱼ = Σᵢ mᵢ (aᵢ + g ŷ) · ∂pᵢ/∂qⱼ + Iᵢ αᵢ ∂ψᵢ/∂qⱼ
 *
 * with pᵢ, ψᵢ each link's centre of mass and angle, and aᵢ = Jᵢ q̈ + J̇ᵢ q̇. The first three components act on
 * the unactuated base — they must come from the ground, or be zero in the air — and the last three are the joint
 * torques. Forward dynamics solves the same equations for q̈ (M q̈ = Q − h).
 */

export const DOF = 6;

export interface Link {
  name: string;
  mass: number;
  /** Rotational inertia about the centre of mass (kg·m²). */
  inertia: number;
  /** Length from this link's joint to the next joint (m). */
  length: number;
  /** Centre of mass along the link from its joint (m). */
  com: number;
}

/** The base's joint sits this far above the base's centre. Its sole is a segment of half-width FOOT below it. */
export const BASE_JOINT = 0.03;
export const FOOT = 0.13;
export const SOLE = -0.025;

export const LINKS: Link[] = [
  { name: 'base', mass: 1.5, inertia: (1.5 * (0.26 * 0.26 + 0.05 * 0.05)) / 12, length: BASE_JOINT, com: 0 },
  { name: 'lower arm', mass: 0.2, inertia: (0.2 * 0.28 * 0.28) / 12, length: 0.28, com: 0.14 },
  { name: 'upper arm', mass: 0.2, inertia: (0.2 * 0.28 * 0.28) / 12, length: 0.28, com: 0.14 },
  { name: 'head', mass: 0.35, inertia: 0.35 * 0.06 * 0.06, length: 0.16, com: 0.09 },
];
export const G = 9.81;
export const TOTAL_MASS = LINKS.reduce((s, l) => s + l.mass, 0);

/** Centres of mass (x, y) and absolute angles of the four links. */
export function linkPoses(q: ArrayLike<number>, outP: Float64Array, outA: Float64Array): void {
  let x = q[0];
  let y = q[1];
  let a = q[2];
  outP[0] = x;
  outP[1] = y;
  outA[0] = a;
  // Base joint.
  x += -Math.sin(a) * BASE_JOINT;
  y += Math.cos(a) * BASE_JOINT;
  for (let i = 1; i < 4; i++) {
    a += q[2 + i];
    const L = LINKS[i];
    outP[i * 2] = x - Math.sin(a) * L.com;
    outP[i * 2 + 1] = y + Math.cos(a) * L.com;
    outA[i] = a;
    x -= Math.sin(a) * L.length;
    y += Math.cos(a) * L.length;
  }
}

/** Joint positions for drawing: base centre, base joint, elbow, neck, head tip. */
export function jointPositions(q: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = [[q[0], q[1]]];
  let x = q[0] - Math.sin(q[2]) * BASE_JOINT;
  let y = q[1] + Math.cos(q[2]) * BASE_JOINT;
  let a = q[2];
  out.push([x, y]);
  for (let i = 1; i < 4; i++) {
    a += q[2 + i];
    x -= Math.sin(a) * LINKS[i].length;
    y += Math.cos(a) * LINKS[i].length;
    out.push([x, y]);
  }
  return out;
}

const P = new Float64Array(8);
const A = new Float64Array(4);

const cx = new Float64Array(4);
const cy = new Float64Array(4);
const ax = new Float64Array(4);
const ay = new Float64Array(4);
const jx = new Float64Array(4);
const jy = new Float64Array(4);
const psidd = new Float64Array(4);

/**
 * Generalised forces Q needed for (q, q̇, q̈) under gravity, by planar recursive kinematics: each link's angle
 * ψ, rate ψ̇ and acceleration ψ̈ are sums of the coordinates', and a point at r from the previous joint gets
 * a = a_prev + ψ̈ × r − ψ̇² r. Then Qⱼ = Σᵢ mᵢ (aᵢ + g ŷ) · ∂pᵢ/∂qⱼ + Iᵢ ψ̈ᵢ ∂ψᵢ/∂qⱼ, where a rotation about
 * joint k (or the base centre) moves point p by (−(p_y − k_y), p_x − k_x).
 */
export function inverseDynamics(q: ArrayLike<number>, qd: ArrayLike<number>, qdd: ArrayLike<number>, out: Float64Array): Float64Array {
  // Base.
  let psi = q[2];
  let w = qd[2];
  let al = qdd[2];
  let px = q[0];
  let py = q[1];
  let vx = qd[0];
  let vy = qd[1];
  let accx = qdd[0];
  let accy = qdd[1];
  cx[0] = px;
  cy[0] = py;
  ax[0] = accx;
  ay[0] = accy;
  psidd[0] = al;
  // Rotation pivots: the base centre (for φ) and the three joints.
  jx[0] = px;
  jy[0] = py;
  // Move to the base joint: r = R(ψ)·(0, BASE_JOINT) = (−sin ψ, cos ψ)·d.
  const step = (d: number) => {
    const rx = -Math.sin(psi) * d;
    const ry = Math.cos(psi) * d;
    // a += α × r − ω² r ; v += ω × r
    const nax = accx - al * ry - w * w * rx;
    const nay = accy + al * rx - w * w * ry;
    const nvx = vx - w * ry;
    const nvy = vy + w * rx;
    return [px + rx, py + ry, nvx, nvy, nax, nay];
  };
  [px, py, vx, vy, accx, accy] = step(BASE_JOINT);
  for (let i = 1; i < 4; i++) {
    jx[i] = px;
    jy[i] = py;
    psi += q[2 + i];
    w += qd[2 + i];
    al += qdd[2 + i];
    psidd[i] = al;
    const L = LINKS[i];
    const c = step(L.com);
    cx[i] = c[0];
    cy[i] = c[1];
    ax[i] = c[4];
    ay[i] = c[5];
    [px, py, vx, vy, accx, accy] = step(L.length);
  }
  // Q_x, Q_y: total force; Q_φ and joint torques: moments about the pivots of everything beyond them.
  for (let j = 0; j < DOF; j++) out[j] = 0;
  for (let i = 0; i < 4; i++) {
    const m = LINKS[i].mass;
    const fx = m * ax[i];
    const fy = m * (ay[i] + G);
    const Iα = LINKS[i].inertia * psidd[i];
    out[0] += fx;
    out[1] += fy;
    // Coordinate 2 (φ) pivots about the base centre; coordinate 2 + k (k ≥ 1) about joint k, moving links i ≥ k.
    for (let k = 0; k <= Math.min(i, 3); k++) {
      if (k > 0 && i < k) continue;
      const pxk = k === 0 ? jx[0] : jx[k];
      const pyk = k === 0 ? jy[0] : jy[k];
      out[2 + k] += fx * -(cy[i] - pyk) + fy * (cx[i] - pxk) + Iα;
    }
  }
  return out;
}

const Mtmp = new Float64Array(DOF);
const zero = new Float64Array(DOF);
const unit = new Float64Array(DOF);
const hvec = new Float64Array(DOF);

/**
 * Forward dynamics: q̈ for applied generalised forces Q, with the first `fixed` coordinates held (a base standing
 * on the ground). Builds M column by column from inverse dynamics and solves by Gaussian elimination.
 */
export function forwardDynamics(q: ArrayLike<number>, qd: ArrayLike<number>, Q: ArrayLike<number>, fixed: number, out: Float64Array): Float64Array {
  inverseDynamics(q, qd, zero, hvec);
  const n = DOF - fixed;
  const M: number[][] = [];
  for (let c = 0; c < n; c++) {
    unit.fill(0);
    unit[fixed + c] = 1;
    inverseDynamics(q, zero, unit, Mtmp);
    // M e_c = ID(q, 0, e_c) − ID(q, 0, 0) (the gravity part cancels).
    inverseDynamics(q, zero, zero, out);
    M.push(Array.from({ length: n }, (_, r) => Mtmp[fixed + r] - out[fixed + r]));
  }
  // Rows of M are M[c][r] → transpose into A[r][c]; right-hand side Q − h.
  const Aug = Array.from({ length: n }, (_, r) => [...Array.from({ length: n }, (_, c) => M[c][r]), Q[fixed + r] - hvec[fixed + r]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(Aug[r][i]) > Math.abs(Aug[p][i])) p = r;
    [Aug[i], Aug[p]] = [Aug[p], Aug[i]];
    for (let r = i + 1; r < n; r++) {
      const f = Aug[r][i] / Aug[i][i];
      for (let c = i; c <= n; c++) Aug[r][c] -= f * Aug[i][c];
    }
  }
  out.fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = Aug[i][n];
    for (let c = i + 1; c < n; c++) s -= Aug[i][c] * out[fixed + c];
    out[fixed + i] = s / Aug[i][i];
  }
  return out;
}

/** Centre of mass of the whole lamp. */
export function centreOfMass(q: ArrayLike<number>): [number, number] {
  linkPoses(q, P, A);
  let x = 0;
  let y = 0;
  for (let i = 0; i < 4; i++) {
    x += LINKS[i].mass * P[i * 2];
    y += LINKS[i].mass * P[i * 2 + 1];
  }
  return [x / TOTAL_MASS, y / TOTAL_MASS];
}
