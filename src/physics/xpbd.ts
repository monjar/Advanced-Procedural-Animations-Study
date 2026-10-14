import * as THREE from 'three';

export interface SphereCollider {
  centre: THREE.Vector3;
  radius: number;
}

export interface CapsuleCollider {
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
}

export type ConstraintMode = 'xpbd' | 'pbd';

/**
 * Particle system solved with XPBD (Macklin, Müller & Chentanez 2016) using the "small steps"
 * scheme (Macklin et al. 2019): many substeps, one constraint iteration each, Lagrange
 * multipliers reset every substep.
 *
 * Distance constraint C = |x_a − x_b| − rest, with compliance α (inverse stiffness, m/N):
 *   α̃ = α / h²
 *   Δλ = (−C − α̃λ) / (w_a + w_b + α̃)
 *   x_a += w_a Δλ n,   x_b −= w_b Δλ n
 *
 * In `pbd` mode the same constraints use classic PBD stiffness k ∈ [0, 1] instead
 * (Δx scaled by k, no λ), whose effective stiffness depends on the iteration count.
 */
export class ParticleSystem {
  readonly x: Float64Array;
  readonly prev: Float64Array;
  readonly v: Float64Array;
  readonly w: Float64Array;
  /** Per-particle external acceleration (e.g. aerodynamic drag), added during prediction. */
  readonly acc: Float64Array;
  /** Particle radius for collisions. */
  radius = 0.02;
  count = 0;

  gravity = new THREE.Vector3(0, -9.81, 0);
  /** Linear velocity damping (1/s). */
  damping = 0.1;
  /** 0 = frictionless contacts, 1 = contacts stick. */
  friction = 0.4;
  groundY: number | null = 0;
  substeps = 10;
  iterations = 1;
  mode: ConstraintMode = 'xpbd';
  /** PBD stiffness used in `pbd` mode. */
  pbdStiffness = 1;
  wind = new THREE.Vector3();

  readonly spheres: SphereCollider[] = [];
  readonly capsules: CapsuleCollider[] = [];

  private ca: Int32Array;
  private cb: Int32Array;
  private rest: Float64Array;
  private compliance: Float64Array;
  private lambda: Float64Array;
  nConstraints = 0;

  private readonly pinTarget = new Map<number, { from: THREE.Vector3; to: THREE.Vector3 }>();
  private readonly savedW = new Map<number, number>();

  constructor(capacity: number, constraintCapacity = capacity * 8) {
    this.x = new Float64Array(capacity * 3);
    this.prev = new Float64Array(capacity * 3);
    this.v = new Float64Array(capacity * 3);
    this.w = new Float64Array(capacity);
    this.acc = new Float64Array(capacity * 3);
    this.ca = new Int32Array(constraintCapacity);
    this.cb = new Int32Array(constraintCapacity);
    this.rest = new Float64Array(constraintCapacity);
    this.compliance = new Float64Array(constraintCapacity);
    this.lambda = new Float64Array(constraintCapacity);
  }

  addParticle(p: THREE.Vector3, mass: number): number {
    const i = this.count++;
    this.setPosition(i, p);
    this.w[i] = mass > 0 && Number.isFinite(mass) ? 1 / mass : 0;
    return i;
  }

  /** Distance constraint between a and b; rest length defaults to the current distance. */
  addDistance(a: number, b: number, compliance: number, rest?: number): number {
    const k = this.nConstraints++;
    if (k >= this.ca.length) throw new Error('ParticleSystem: constraint capacity exceeded');
    this.ca[k] = a;
    this.cb[k] = b;
    this.rest[k] = rest ?? this.distance(a, b);
    this.compliance[k] = compliance;
    return k;
  }

  setCompliance(k: number, compliance: number): void {
    this.compliance[k] = compliance;
  }

  get(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.x[3 * i], this.x[3 * i + 1], this.x[3 * i + 2]);
  }

  setPosition(i: number, p: THREE.Vector3): void {
    this.x[3 * i] = this.prev[3 * i] = p.x;
    this.x[3 * i + 1] = this.prev[3 * i + 1] = p.y;
    this.x[3 * i + 2] = this.prev[3 * i + 2] = p.z;
    this.v[3 * i] = this.v[3 * i + 1] = this.v[3 * i + 2] = 0;
  }

  distance(a: number, b: number): number {
    const dx = this.x[3 * a] - this.x[3 * b];
    const dy = this.x[3 * a + 1] - this.x[3 * b + 1];
    const dz = this.x[3 * a + 2] - this.x[3 * b + 2];
    return Math.hypot(dx, dy, dz);
  }

  restLength(k: number): number {
    return this.rest[k];
  }

  constraintEnds(k: number): [number, number] {
    return [this.ca[k], this.cb[k]];
  }

  /**
   * Make particle i kinematic and move it to `p` over the next step (interpolated across substeps,
   * so fast-moving anchors do not inject energy in one jump).
   */
  pin(i: number, p: THREE.Vector3): void {
    let t = this.pinTarget.get(i);
    if (!t) {
      t = { from: this.get(i), to: p.clone() };
      this.pinTarget.set(i, t);
      if (!this.savedW.has(i)) this.savedW.set(i, this.w[i]);
      this.w[i] = 0;
    } else {
      t.to.copy(p);
    }
  }

  unpin(i: number): void {
    this.pinTarget.delete(i);
    const w = this.savedW.get(i);
    if (w !== undefined) this.w[i] = w;
    this.savedW.delete(i);
  }

  isPinned(i: number): boolean {
    return this.pinTarget.has(i);
  }

  step(dt: number): void {
    const n = this.count;
    const h = dt / this.substeps;
    const { x, prev, v, w, acc } = this;
    const gx = (this.gravity.x + this.wind.x) * h;
    const gy = (this.gravity.y + this.wind.y) * h;
    const gz = (this.gravity.z + this.wind.z) * h;
    const damp = Math.exp(-this.damping * h);

    for (let s = 0; s < this.substeps; s++) {
      // Predict.
      for (let i = 0; i < n; i++) {
        const j = 3 * i;
        prev[j] = x[j];
        prev[j + 1] = x[j + 1];
        prev[j + 2] = x[j + 2];
        if (w[i] === 0) continue;
        v[j] += gx + acc[j] * h;
        v[j + 1] += gy + acc[j + 1] * h;
        v[j + 2] += gz + acc[j + 2] * h;
        x[j] += v[j] * h;
        x[j + 1] += v[j + 1] * h;
        x[j + 2] += v[j + 2] * h;
      }
      // Kinematic pins, interpolated across the substeps.
      const t = (s + 1) / this.substeps;
      for (const [i, pin] of this.pinTarget) {
        const j = 3 * i;
        x[j] = pin.from.x + (pin.to.x - pin.from.x) * t;
        x[j + 1] = pin.from.y + (pin.to.y - pin.from.y) * t;
        x[j + 2] = pin.from.z + (pin.to.z - pin.from.z) * t;
      }

      this.lambda.fill(0, 0, this.nConstraints);
      for (let it = 0; it < this.iterations; it++) this.solveDistances(h);
      this.collide();

      // Velocity update.
      for (let i = 0; i < n; i++) {
        const j = 3 * i;
        if (w[i] === 0) {
          v[j] = v[j + 1] = v[j + 2] = 0;
          continue;
        }
        v[j] = ((x[j] - prev[j]) / h) * damp;
        v[j + 1] = ((x[j + 1] - prev[j + 1]) / h) * damp;
        v[j + 2] = ((x[j + 2] - prev[j + 2]) / h) * damp;
      }
    }
    for (const pin of this.pinTarget.values()) pin.from.copy(pin.to);
  }

  private solveDistances(h: number): void {
    const { x, w, ca, cb, rest, compliance, lambda } = this;
    const xpbd = this.mode === 'xpbd';
    const k = this.pbdStiffness;
    for (let c = 0; c < this.nConstraints; c++) {
      const a = ca[c];
      const b = cb[c];
      const wa = w[a];
      const wb = w[b];
      const wsum = wa + wb;
      if (wsum === 0) continue;
      const ia = 3 * a;
      const ib = 3 * b;
      let nx = x[ia] - x[ib];
      let ny = x[ia + 1] - x[ib + 1];
      let nz = x[ia + 2] - x[ib + 2];
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) continue;
      nx /= len;
      ny /= len;
      nz /= len;
      const C = len - rest[c];
      let dl: number;
      if (xpbd) {
        const alpha = compliance[c] / (h * h);
        dl = (-C - alpha * lambda[c]) / (wsum + alpha);
        lambda[c] += dl;
      } else {
        dl = (-C / wsum) * k;
      }
      x[ia] += wa * dl * nx;
      x[ia + 1] += wa * dl * ny;
      x[ia + 2] += wa * dl * nz;
      x[ib] -= wb * dl * nx;
      x[ib + 1] -= wb * dl * ny;
      x[ib + 2] -= wb * dl * nz;
    }
  }

  private collide(): void {
    const { x, w } = this;
    const r = this.radius;
    for (let i = 0; i < this.count; i++) {
      if (w[i] === 0) continue;
      const j = 3 * i;
      if (this.groundY !== null && x[j + 1] < this.groundY + r) {
        x[j + 1] = this.groundY + r;
        this.applyFriction(j, 0, 1, 0);
      }
      for (const s of this.spheres) {
        this.pushOut(j, s.centre.x, s.centre.y, s.centre.z, s.radius + r);
      }
      for (const c of this.capsules) {
        // Closest point on segment ab.
        const abx = c.b.x - c.a.x;
        const aby = c.b.y - c.a.y;
        const abz = c.b.z - c.a.z;
        const ab2 = abx * abx + aby * aby + abz * abz;
        let t = ab2 > 0 ? ((x[j] - c.a.x) * abx + (x[j + 1] - c.a.y) * aby + (x[j + 2] - c.a.z) * abz) / ab2 : 0;
        t = Math.min(1, Math.max(0, t));
        this.pushOut(j, c.a.x + abx * t, c.a.y + aby * t, c.a.z + abz * t, c.radius + r);
      }
    }
  }

  private pushOut(j: number, cx: number, cy: number, cz: number, minDist: number): void {
    const x = this.x;
    let dx = x[j] - cx;
    let dy = x[j + 1] - cy;
    let dz = x[j + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= minDist * minDist) return;
    const d = Math.sqrt(d2);
    if (d < 1e-9) {
      dx = 0;
      dy = 1;
      dz = 0;
    } else {
      dx /= d;
      dy /= d;
      dz /= d;
    }
    x[j] = cx + dx * minDist;
    x[j + 1] = cy + dy * minDist;
    x[j + 2] = cz + dz * minDist;
    this.applyFriction(j, dx, dy, dz);
  }

  /** Remove a fraction of this substep's tangential displacement at a contact with normal n. */
  private applyFriction(j: number, nx: number, ny: number, nz: number): void {
    const { x, prev } = this;
    const dx = x[j] - prev[j];
    const dy = x[j + 1] - prev[j + 1];
    const dz = x[j + 2] - prev[j + 2];
    const dn = dx * nx + dy * ny + dz * nz;
    const tx = dx - dn * nx;
    const ty = dy - dn * ny;
    const tz = dz - dn * nz;
    x[j] -= tx * this.friction;
    x[j + 1] -= ty * this.friction;
    x[j + 2] -= tz * this.friction;
  }

  /** Index of the particle closest to a ray within `maxDist`, or -1. */
  pick(ray: THREE.Ray, maxDist: number): number {
    let best = -1;
    let bestT = Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i < this.count; i++) {
      this.get(i, p);
      if (ray.distanceSqToPoint(p) > maxDist * maxDist) continue;
      const t = p.sub(ray.origin).dot(ray.direction);
      if (t > 0 && t < bestT) {
        bestT = t;
        best = i;
      }
    }
    return best;
  }
}
