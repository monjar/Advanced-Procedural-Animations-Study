/**
 * Cosserat rods with XPBD (Kugelstadt & Schömer, "Position and Orientation Based Cosserat Rods", SCA 2016;
 * compliance after Macklin, Müller & Chentanez, "XPBD", 2016, stepped with small substeps).
 *
 * A rod is a chain of particles xᵢ with one orientation qᵢ per segment between xᵢ and xᵢ₊₁. Two constraints:
 *
 *   stretch–shear   (xᵢ₊₁ − xᵢ)/l − d₃(qᵢ) = 0     the segment lies along its frame's third axis, at rest length
 *   bend–twist      Im(q̄ᵢ qᵢ₊₁) − Ω⁰ᵢ = 0          the Darboux vector between neighbouring frames keeps its rest
 *                                                    value: x, y bending, z twisting
 *
 * The rest Darboux vectors Ω⁰ are the rod's shape at rest — zero for a straight strand, a constant for a helix
 * (curly hair), and changed over time for a muscle (a tentacle curls where its rest curvature says so). With
 * XPBD each constraint has a compliance α (inverse stiffness); for the bend–twist constraint, Im(q̄ᵢqᵢ₊₁) ≈ κl/2,
 * so the bending stiffness is EI = l / (4α) — which the cantilever test checks against beam theory.
 *
 * Many rods are stored in flat arrays; rod r owns particles [r·(n+1), (r+1)·(n+1)) and segments [r·n, (r+1)·n).
 */

export interface RodParams {
  /** Bending and twisting compliance (rad⁻¹ … see above), and stretch compliance. */
  bendCompliance: number;
  twistCompliance: number;
  stretchCompliance: number;
  /** Velocity damping per second. */
  damping: number;
  gravity: number;
  /** Mass per particle (kg). */
  mass: number;
}

export class Rods {
  readonly count: number;
  readonly n: number;
  readonly np: number;
  readonly x: Float64Array;
  readonly p: Float64Array;
  readonly v: Float64Array;
  /** Inverse masses (0 = pinned). */
  readonly w: Float64Array;
  /** Segment orientations (x, y, z, w), their predicted values, angular velocities and inverse inertias. */
  readonly q: Float64Array;
  readonly qp: Float64Array;
  readonly omega: Float64Array;
  readonly wq: Float64Array;
  /** Rest Darboux vector per segment joint (between segment i and i+1), 3 per joint. */
  readonly rest: Float64Array;
  readonly length: Float64Array;
  private readonly lamB: Float64Array;
  /** External acceleration per particle (wind, buoyancy), set by the scene. */
  readonly accel: Float64Array;
  /** Collision spheres (x, y, z, r) and a ground height. */
  spheres: number[][] = [];
  /** Constraint passes per substep. */
  iterations = 1;
  /** Particles held on a line through `sleeveAt` along `sleeveDir` but free to slide along it (a sleeve). */
  sleeve: number[] = [];
  sleeveAt = [0, 0, 0];
  sleeveDir = [1, 0, 0];
  /** Extra position constraints applied after the others each pass (walls, clamps…). */
  postSolve: ((p: Float64Array) => void) | null = null;
  /** Self-contact radius (0 = off): particles of the same rod at least this far apart (neighbours excepted). */
  selfRadius = 0;
  ground = -Infinity;
  constructor(
    count: number,
    n: number,
    public params: RodParams,
  ) {
    this.count = count;
    this.n = n;
    this.np = n + 1;
    const P = count * (n + 1);
    const S = count * n;
    this.x = new Float64Array(P * 3);
    this.p = new Float64Array(P * 3);
    this.v = new Float64Array(P * 3);
    this.w = new Float64Array(P).fill(1 / params.mass);
    this.accel = new Float64Array(P * 3);
    this.q = new Float64Array(S * 4);
    this.qp = new Float64Array(S * 4);
    this.omega = new Float64Array(S * 3);
    this.wq = new Float64Array(S).fill(1);
    this.rest = new Float64Array(S * 3);
    this.length = new Float64Array(S);
    this.lamB = new Float64Array(S * 3);
  }

  /** Lay rod r out straight from `start` along `dir` with segment length l, frames with d₃ = dir. */
  layOut(r: number, start: number[], dir: number[], l: number, up = [0, 1, 0]): void {
    const d = normalize(dir);
    const q = quatFromD3(d, up);
    for (let i = 0; i <= this.n; i++) {
      const k = (r * this.np + i) * 3;
      for (let c = 0; c < 3; c++) this.x[k + c] = this.p[k + c] = start[c] + d[c] * l * i;
    }
    for (let i = 0; i < this.n; i++) {
      const s = r * this.n + i;
      this.q.set(q, s * 4);
      this.qp.set(q, s * 4);
      this.length[s] = l;
    }
  }

  /** One XPBD substep of length h. */
  substep(h: number): void {
    const { x, p, v, w, q, qp, omega, wq } = this;
    const g = this.params.gravity;
    const damp = Math.exp(-this.params.damping * h);
    const P = this.count * this.np;
    // Predict.
    for (let i = 0; i < P; i++) {
      const k = i * 3;
      if (w[i] > 0) {
        v[k] = v[k] * damp + this.accel[k] * h;
        v[k + 1] = v[k + 1] * damp + (this.accel[k + 1] - g) * h;
        v[k + 2] = v[k + 2] * damp + this.accel[k + 2] * h;
      }
      p[k] = x[k] + v[k] * h;
      p[k + 1] = x[k + 1] + v[k + 1] * h;
      p[k + 2] = x[k + 2] + v[k + 2] * h;
    }
    const S = this.count * this.n;
    for (let s = 0; s < S; s++) {
      const k = s * 4;
      if (wq[s] > 0) {
        // q ← q + h/2 · (ω, 0) ⊗ q  (ω in world frame, damped)
        const ox = omega[s * 3] * damp;
        const oy = omega[s * 3 + 1] * damp;
        const oz = omega[s * 3 + 2] * damp;
        const [qx, qy, qz, qw] = [q[k], q[k + 1], q[k + 2], q[k + 3]];
        qp[k] = qx + 0.5 * h * (ox * qw + oy * qz - oz * qy);
        qp[k + 1] = qy + 0.5 * h * (oy * qw + oz * qx - ox * qz);
        qp[k + 2] = qz + 0.5 * h * (oz * qw + ox * qy - oy * qx);
        qp[k + 3] = qw + 0.5 * h * (-ox * qx - oy * qy - oz * qz);
        normalize4(qp, k);
      } else {
        qp[k] = q[k];
        qp[k + 1] = q[k + 1];
        qp[k + 2] = q[k + 2];
        qp[k + 3] = q[k + 3];
      }
    }
    this.lamB.fill(0);
    const h2 = h * h;
    for (let it = 0; it < this.iterations; it++) {
      for (let r = 0; r < this.count; r++) {
        for (let i = 0; i < this.n; i++) this.solveStretch(r, i, this.params.stretchCompliance / h2);
        for (let i = 0; i < this.n - 1; i++) this.solveBend(r, i, this.params.bendCompliance / h2, this.params.twistCompliance / h2);
      }
    }
    this.collide();
    // Velocities from the corrected positions and orientations.
    for (let i = 0; i < P; i++) {
      const k = i * 3;
      v[k] = (p[k] - x[k]) / h;
      v[k + 1] = (p[k + 1] - x[k + 1]) / h;
      v[k + 2] = (p[k + 2] - x[k + 2]) / h;
      x[k] = p[k];
      x[k + 1] = p[k + 1];
      x[k + 2] = p[k + 2];
    }
    for (let s = 0; s < S; s++) {
      const k = s * 4;
      // ω = 2 Im(qp ⊗ q̄) / h
      const [ax, ay, az, aw] = [qp[k], qp[k + 1], qp[k + 2], qp[k + 3]];
      const [bx, by, bz, bw] = [-q[k], -q[k + 1], -q[k + 2], q[k + 3]];
      let rx = aw * bx + ax * bw + ay * bz - az * by;
      let ry = aw * by - ax * bz + ay * bw + az * bx;
      let rz = aw * bz + ax * by - ay * bx + az * bw;
      const rw = aw * bw - ax * bx - ay * by - az * bz;
      if (rw < 0) (rx = -rx), (ry = -ry), (rz = -rz);
      omega[s * 3] = (2 * rx) / h;
      omega[s * 3 + 1] = (2 * ry) / h;
      omega[s * 3 + 2] = (2 * rz) / h;
      q[k] = ax;
      q[k + 1] = ay;
      q[k + 2] = az;
      q[k + 3] = aw;
    }
  }

  private solveStretch(r: number, i: number, alpha: number): void {
    const { p, w, qp, wq } = this;
    const a = (r * this.np + i) * 3;
    const b = a + 3;
    const s = r * this.n + i;
    const k = s * 4;
    const l = this.length[s];
    const wa = w[r * this.np + i];
    const wb = w[r * this.np + i + 1];
    const wqs = wq[s];
    const [qx, qy, qz, qw] = [qp[k], qp[k + 1], qp[k + 2], qp[k + 3]];
    // d₃ = q e₃ q̄
    const d3x = 2 * (qx * qz + qw * qy);
    const d3y = 2 * (qy * qz - qw * qx);
    const d3z = qw * qw - qx * qx - qy * qy + qz * qz;
    const cx = (p[b] - p[a]) / l - d3x;
    const cy = (p[b + 1] - p[a + 1]) / l - d3y;
    const cz = (p[b + 2] - p[a + 2]) / l - d3z;
    // Compliance enters the denominator (a stiff, nearly inextensible strand needs no multiplier history).
    const denom = (wa + wb) / l + 4 * wqs * l + alpha;
    if (denom <= 0) return;
    const gx = cx / denom;
    const gy = cy / denom;
    const gz = cz / denom;
    p[a] += wa * gx;
    p[a + 1] += wa * gy;
    p[a + 2] += wa * gz;
    p[b] -= wb * gx;
    p[b + 1] -= wb * gy;
    p[b + 2] -= wb * gz;
    if (wqs > 0) {
      // q ← q + 2·wq·l · (γ, 0) ⊗ q ⊗ ē₃, with ē₃ = (0, 0, −1, 0): t = (γ, 0) ⊗ q, then t ⊗ ē₃ = (−t_y, t_x, −t_w, t_z).
      // That turns d₃ by 4·wq·l·γ⊥, as the denominator assumes, and gives the frame the same rotational inverse
      // mass (4·wq per radian) as the bend–twist update. With the paper's factor of 1 the two disagree, and the
      // static shape comes out exactly twice as stiff as the compliance says.
      const sc = 2 * wqs * l;
      const tx = gx * qw + gy * qz - gz * qy;
      const ty = gy * qw + gz * qx - gx * qz;
      const tz = gz * qw + gx * qy - gy * qx;
      const tw = -gx * qx - gy * qy - gz * qz;
      qp[k] += sc * -ty;
      qp[k + 1] += sc * tx;
      qp[k + 2] += sc * -tw;
      qp[k + 3] += sc * tz;
      normalize4(qp, k);
    }
  }

  private solveBend(r: number, i: number, alphaB: number, alphaT: number): void {
    const { qp, wq } = this;
    const s = r * this.n + i;
    const t = s + 1;
    const wa = wq[s];
    const wb = wq[t];
    if (wa + wb <= 0) return;
    const ka = s * 4;
    const kb = t * 4;
    const [ax, ay, az, aw] = [qp[ka], qp[ka + 1], qp[ka + 2], qp[ka + 3]];
    const [bx, by, bz, bw] = [qp[kb], qp[kb + 1], qp[kb + 2], qp[kb + 3]];
    // Ω = q̄ₐ ⊗ q_b
    const ox = aw * bx - ax * bw - ay * bz + az * by;
    const oy = aw * by + ax * bz - ay * bw - az * bx;
    const oz = aw * bz - ax * by + ay * bx - az * bw;
    const ow = aw * bw + ax * bx + ay * by + az * bz;
    const r0x = this.rest[s * 3];
    const r0y = this.rest[s * 3 + 1];
    const r0z = this.rest[s * 3 + 2];
    // Rest Darboux as a unit quaternion (w ≥ 0); compare with the closer of Ω and −Ω.
    const r0w = Math.sqrt(Math.max(0, 1 - r0x * r0x - r0y * r0y - r0z * r0z));
    const plus = (ox - r0x) ** 2 + (oy - r0y) ** 2 + (oz - r0z) ** 2 + (ow - r0w) ** 2;
    const minus = (ox + r0x) ** 2 + (oy + r0y) ** 2 + (oz + r0z) ** 2 + (ow + r0w) ** 2;
    const sg = plus <= minus ? 1 : -1;
    const cx = ox - sg * r0x;
    const cy = oy - sg * r0y;
    const cz = oz - sg * r0z;
    const L = this.lamB;
    const w = wa + wb;
    const dlx = (-cx - alphaB * L[s * 3]) / (w + alphaB);
    const dly = (-cy - alphaB * L[s * 3 + 1]) / (w + alphaB);
    const dlz = (-cz - alphaT * L[s * 3 + 2]) / (w + alphaT);
    L[s * 3] += dlx;
    L[s * 3 + 1] += dly;
    L[s * 3 + 2] += dlz;
    // Correction δ = (dl, 0) in the Darboux frame: q_b ← q_b + w_b · q_a ⊗ δ·…, q_a ← q_a − w_a · q_b ⊗ δ.
    const dx = dlx;
    const dy = dly;
    const dz = dlz;
    if (wa > 0) {
      // qa −= wa · (q_b ⊗ (δ, 0))
      qp[ka] -= wa * (bw * dx + by * dz - bz * dy);
      qp[ka + 1] -= wa * (bw * dy + bz * dx - bx * dz);
      qp[ka + 2] -= wa * (bw * dz + bx * dy - by * dx);
      qp[ka + 3] -= wa * (-bx * dx - by * dy - bz * dz);
      normalize4(qp, ka);
    }
    if (wb > 0) {
      // qb += wb · (q_a ⊗ (δ, 0))
      qp[kb] += wb * (aw * dx + ay * dz - az * dy);
      qp[kb + 1] += wb * (aw * dy + az * dx - ax * dz);
      qp[kb + 2] += wb * (aw * dz + ax * dy - ay * dx);
      qp[kb + 3] += wb * (-ax * dx - ay * dy - az * dz);
      normalize4(qp, kb);
    }
  }

  private collide(): void {
    const p = this.p;
    const P = this.count * this.np;
    for (let i = 0; i < P; i++) {
      if (this.w[i] === 0) continue;
      const k = i * 3;
      for (const [sx, sy, sz, sr] of this.spheres) {
        const dx = p[k] - sx;
        const dy = p[k + 1] - sy;
        const dz = p[k + 2] - sz;
        const d = Math.hypot(dx, dy, dz);
        if (d < sr && d > 1e-9) {
          const f = sr / d;
          p[k] = sx + dx * f;
          p[k + 1] = sy + dy * f;
          p[k + 2] = sz + dz * f;
        }
      }
      if (p[k + 1] < this.ground) p[k + 1] = this.ground;
    }
    if (this.selfRadius > 0) this.selfCollide();
    this.postSolve?.(p);
    const [ax, ay, az] = this.sleeveAt;
    const [dx, dy, dz] = this.sleeveDir;
    for (const i of this.sleeve) {
      const k = i * 3;
      const t = (p[k] - ax) * dx + (p[k + 1] - ay) * dy + (p[k + 2] - az) * dz;
      p[k] = ax + t * dx;
      p[k + 1] = ay + t * dy;
      p[k + 2] = az + t * dz;
    }
  }

  /** Push apart particles of the same rod closer than 2·selfRadius (skipping near neighbours along the rod). */
  private selfCollide(): void {
    const p = this.p;
    const d2 = (2 * this.selfRadius) ** 2;
    const skip = Math.ceil((2 * this.selfRadius) / Math.min(...Array.from(this.length.subarray(0, this.n)))) + 1;
    for (let r = 0; r < this.count; r++) {
      const o = r * this.np;
      for (let i = 0; i < this.np; i++)
        for (let j = i + skip; j < this.np; j++) {
          const a = (o + i) * 3;
          const b = (o + j) * 3;
          const dx = p[b] - p[a];
          const dy = p[b + 1] - p[a + 1];
          const dz = p[b + 2] - p[a + 2];
          const dd = dx * dx + dy * dy + dz * dz;
          if (dd >= d2 || dd < 1e-12) continue;
          const wa = this.w[o + i];
          const wb = this.w[o + j];
          if (wa + wb === 0) continue;
          const d = Math.sqrt(dd);
          const c = (d - 2 * this.selfRadius) / d / (wa + wb);
          p[a] += wa * c * dx;
          p[a + 1] += wa * c * dy;
          p[a + 2] += wa * c * dz;
          p[b] -= wb * c * dx;
          p[b + 1] -= wb * c * dy;
          p[b + 2] -= wb * c * dz;
        }
    }
  }

  /**
   * Rotational inverse masses scaled to the segments: wq = scale / (m l²). 0.25 converged fastest in the
   * cantilever test; the static shape does not depend on it once converged.
   */
  setInertia(scale = 0.25): void {
    for (let s = 0; s < this.count * this.n; s++) if (this.wq[s] > 0) this.wq[s] = scale / (this.params.mass * this.length[s] ** 2);
  }

  /** Rotate segment s about its own d₃ axis by angle a (radians). */
  twistSegment(s: number, a: number, base: ArrayLike<number>): void {
    const k = s * 4;
    // q = base ⊗ (0, 0, sin(a/2), cos(a/2))
    const [bx, by, bz, bw] = [base[0], base[1], base[2], base[3]];
    const cz = Math.sin(a / 2);
    const cw = Math.cos(a / 2);
    this.q[k] = bx * cw + by * cz;
    this.q[k + 1] = by * cw - bx * cz;
    this.q[k + 2] = bz * cw + bw * cz;
    this.q[k + 3] = bw * cw - bz * cz;
    // Stay in the same hemisphere as the neighbouring segment's quaternion (q and −q are the same rotation;
    // jumping between them makes the bend–twist constraint see a 360° twist and unwind two turns at once).
    const nb = s > 0 && s % this.n !== 0 ? (s - 1) * 4 : s + 1 < this.count * this.n && (s + 1) % this.n !== 0 ? (s + 1) * 4 : -1;
    if (nb >= 0 && this.q[k] * this.q[nb] + this.q[k + 1] * this.q[nb + 1] + this.q[k + 2] * this.q[nb + 2] + this.q[k + 3] * this.q[nb + 3] < 0) {
      for (let c = 0; c < 4; c++) this.q[k + c] = -this.q[k + c];
    }
  }

  /** Segment frame axis c (0, 1, 2 → d₁, d₂, d₃) of segment s. */
  axis(s: number, c: number, out: number[] = [0, 0, 0]): number[] {
    const k = s * 4;
    const [x, y, z, w] = [this.q[k], this.q[k + 1], this.q[k + 2], this.q[k + 3]];
    if (c === 0) {
      out[0] = 1 - 2 * (y * y + z * z);
      out[1] = 2 * (x * y + w * z);
      out[2] = 2 * (x * z - w * y);
    } else if (c === 1) {
      out[0] = 2 * (x * y - w * z);
      out[1] = 1 - 2 * (x * x + z * z);
      out[2] = 2 * (y * z + w * x);
    } else {
      out[0] = 2 * (x * z + w * y);
      out[1] = 2 * (y * z - w * x);
      out[2] = 1 - 2 * (x * x + y * y);
    }
    return out;
  }
}

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function normalize4(q: Float64Array, k: number): void {
  const l = Math.hypot(q[k], q[k + 1], q[k + 2], q[k + 3]) || 1;
  q[k] /= l;
  q[k + 1] /= l;
  q[k + 2] /= l;
  q[k + 3] /= l;
}

/** A frame whose third axis is d (and whose second axis leans toward `up`), as a quaternion (x, y, z, w). */
export function quatFromD3(d: number[], up = [0, 1, 0]): number[] {
  let ux = up[0];
  let uy = up[1];
  let uz = up[2];
  // d₁ = up × d (normalised), d₂ = d × d₁
  let ax = uy * d[2] - uz * d[1];
  let ay = uz * d[0] - ux * d[2];
  let az = ux * d[1] - uy * d[0];
  let al = Math.hypot(ax, ay, az);
  if (al < 1e-6) {
    ux = 1;
    uy = 0;
    uz = 0;
    ax = uy * d[2] - uz * d[1];
    ay = uz * d[0] - ux * d[2];
    az = ux * d[1] - uy * d[0];
    al = Math.hypot(ax, ay, az);
  }
  ax /= al;
  ay /= al;
  az /= al;
  const bx = d[1] * az - d[2] * ay;
  const by = d[2] * ax - d[0] * az;
  const bz = d[0] * ay - d[1] * ax;
  // Rotation matrix columns (d₁, d₂, d₃) → quaternion.
  const m00 = ax, m01 = bx, m02 = d[0];
  const m10 = ay, m11 = by, m12 = d[1];
  const m20 = az, m21 = bz, m22 = d[2];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return [x, y, z, w];
}
