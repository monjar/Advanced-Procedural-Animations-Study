/**
 * Shape-driven locomotion on a plane with anisotropic friction (Hu, Nirody, Scott & Shelley, "The mechanics of
 * slithering locomotion", PNAS 2009).
 *
 * The animal controls only its *shape*: point positions in its own frame, how much of its weight each point
 * carries, and (for a worm's bristles or an inchworm's prolegs) how hard each point grips. Where it goes is not
 * animated — it is whatever Newton's laws give when the ground's friction pushes back on the moving points:
 *
 *   M dV/dt = Σ Fᵢ                      (centre of mass)
 *   dL/dt   = Σ rᵢ × Fᵢ                  (angular momentum about it; L = I·Ω + Σ mᵢ qᵢ × q̇ᵢ)
 *
 * qᵢ are the points relative to the shape's centre of mass in the body frame; the second part of L is the spin a
 * shape change carries by itself, so a body that changes shape in mid-air rotates (like a falling cat) but its
 * centre of mass never moves. On the ground each point feels Coulomb friction against its velocity, with its own
 * coefficients forward, backward and sideways along the body:
 *
 *   Fᵢ = −wᵢ M g [ μₙ (û·n̂) n̂ + (û·t̂ > 0 ? μ_f : μ_b) (û·t̂) t̂ ]
 *
 * û is the unit velocity, regularised near zero (|v|² + ε²) so that a resting point's friction fades smoothly
 * instead of chattering.
 */

export interface ShapeFrame {
  readonly n: number;
  /** Body-frame positions (m); x forward along the body at rest. */
  x: Float64Array;
  y: Float64Array;
  /** Height above the ground (for drawing; lifted points carry no weight). */
  z: Float64Array;
  /** Unit body tangent (pointing toward the head). */
  tx: Float64Array;
  ty: Float64Array;
  /** Fraction of the body's weight each point carries (sums to 1, or 0 in the air). */
  weight: Float64Array;
  /** Friction coefficients per point: forward, backward, sideways. */
  muF: Float64Array;
  muB: Float64Array;
  muN: Float64Array;
  /** Body radius at each point (for drawing). */
  radius: Float64Array;
}

export function makeFrame(n: number): ShapeFrame {
  const a = () => new Float64Array(n);
  return { n, x: a(), y: a(), z: a(), tx: a(), ty: a(), weight: a(), muF: a(), muB: a(), muN: a(), radius: a() };
}

export interface Gait {
  readonly n: number;
  /** Write the shape at time t. */
  shape(t: number, out: ShapeFrame): void;
}

const G = 9.81;

export class Slither {
  /** Centre of mass (world, m), its velocity, body-frame orientation and angular momentum about the COM. */
  X = 0;
  Y = 0;
  theta = 0;
  vx = 0;
  vy = 0;
  L = 0;
  omega = 0;
  t = 0;
  mass = 1;
  /** Friction regularisation speed (m/s). */
  eps = 0.01;
  /** Total friction force and torque of the last step (diagnostics). */
  fx = 0;
  fy = 0;
  readonly frame: ShapeFrame;
  private readonly prev: ShapeFrame;
  /** World positions and velocities of the points after the last step. */
  readonly wx: Float64Array;
  readonly wy: Float64Array;
  readonly wvx: Float64Array;
  readonly wvy: Float64Array;
  private readonly qx: Float64Array;
  private readonly qy: Float64Array;
  private readonly qdx: Float64Array;
  private readonly qdy: Float64Array;

  constructor(
    public gait: Gait,
    t0 = 0,
  ) {
    const n = gait.n;
    this.frame = makeFrame(n);
    this.prev = makeFrame(n);
    this.wx = new Float64Array(n);
    this.wy = new Float64Array(n);
    this.wvx = new Float64Array(n);
    this.wvy = new Float64Array(n);
    this.qx = new Float64Array(n);
    this.qy = new Float64Array(n);
    this.qdx = new Float64Array(n);
    this.qdy = new Float64Array(n);
    this.t = t0;
    gait.shape(t0, this.frame);
    // Start at rest: no linear momentum, and no rotation despite the shape changing.
    this.prepare(1e-3, true);
    this.L = this.spin;
    this.omega = 0;
    this.toWorld();
  }

  private spin = 0;
  private inertia = 1;

  /** Body-frame points relative to the shape's COM, their velocities, the inertia and the shape's own spin. */
  private prepare(dt: number, fresh: boolean): void {
    const f = this.frame;
    const p = this.prev;
    const n = f.n;
    if (fresh) {
      this.gait.shape(this.t - dt, p);
    }
    let cx = 0;
    let cy = 0;
    let pcx = 0;
    let pcy = 0;
    for (let i = 0; i < n; i++) {
      cx += f.x[i];
      cy += f.y[i];
      pcx += p.x[i];
      pcy += p.y[i];
    }
    cx /= n;
    cy /= n;
    pcx /= n;
    pcy /= n;
    const m = this.mass / n;
    let I = 0;
    let S = 0;
    for (let i = 0; i < n; i++) {
      const qx = f.x[i] - cx;
      const qy = f.y[i] - cy;
      const qdx = (qx - (p.x[i] - pcx)) / dt;
      const qdy = (qy - (p.y[i] - pcy)) / dt;
      this.qx[i] = qx;
      this.qy[i] = qy;
      this.qdx[i] = qdx;
      this.qdy[i] = qdy;
      I += m * (qx * qx + qy * qy);
      S += m * (qx * qdy - qy * qdx);
    }
    this.inertia = Math.max(1e-9, I);
    this.spin = S;
  }

  private toWorld(): void {
    const c = Math.cos(this.theta);
    const s = Math.sin(this.theta);
    const f = this.frame;
    for (let i = 0; i < f.n; i++) {
      const rx = c * this.qx[i] - s * this.qy[i];
      const ry = s * this.qx[i] + c * this.qy[i];
      this.wx[i] = this.X + rx;
      this.wy[i] = this.Y + ry;
      this.wvx[i] = this.vx - this.omega * ry + (c * this.qdx[i] - s * this.qdy[i]);
      this.wvy[i] = this.vy + this.omega * rx + (s * this.qdx[i] + c * this.qdy[i]);
    }
  }

  step(dt: number): void {
    // Shape at the new time; its rate of change from the previous one.
    const f = this.frame;
    const p = this.prev;
    for (const k of ['x', 'y', 'z', 'tx', 'ty', 'weight', 'muF', 'muB', 'muN', 'radius'] as const) p[k].set(f[k]);
    this.t += dt;
    this.gait.shape(this.t, f);
    this.prepare(dt, false);
    this.omega = (this.L - this.spin) / this.inertia;
    this.toWorld();

    // Friction on every point.
    const c = Math.cos(this.theta);
    const s = Math.sin(this.theta);
    const W = this.mass * G;
    const e2 = this.eps * this.eps;
    let Fx = 0;
    let Fy = 0;
    let tau = 0;
    for (let i = 0; i < f.n; i++) {
      const w = f.weight[i];
      if (w <= 0) continue;
      const vx = this.wvx[i];
      const vy = this.wvy[i];
      const inv = 1 / Math.sqrt(vx * vx + vy * vy + e2);
      const ux = vx * inv;
      const uy = vy * inv;
      const tx = c * f.tx[i] - s * f.ty[i];
      const ty = s * f.tx[i] + c * f.ty[i];
      const ut = ux * tx + uy * ty;
      const un = -ux * ty + uy * tx; // along n̂ = (−ty, tx)
      const muT = ut > 0 ? f.muF[i] : f.muB[i];
      const fx = -w * W * (f.muN[i] * un * -ty + muT * ut * tx);
      const fy = -w * W * (f.muN[i] * un * tx + muT * ut * ty);
      Fx += fx;
      Fy += fy;
      tau += (this.wx[i] - this.X) * fy - (this.wy[i] - this.Y) * fx;
    }
    this.fx = Fx;
    this.fy = Fy;
    this.vx += (Fx / this.mass) * dt;
    this.vy += (Fy / this.mass) * dt;
    this.L += tau * dt;
    this.omega = (this.L - this.spin) / this.inertia;
    this.X += this.vx * dt;
    this.Y += this.vy * dt;
    this.theta += this.omega * dt;
    this.toWorld();
  }

  /** World position of point i at its height. */
  point(i: number): [number, number, number] {
    return [this.wx[i], this.wy[i], this.frame.z[i]];
  }
}
