import * as THREE from 'three';

/**
 * Second-order dynamics after t3ssel8r ("Giving Personality to Procedural Animations using Math").
 *
 *   y + k1·y' + k2·y'' = x + k3·x'
 *
 * with
 *   f  natural frequency (Hz)  – speed of response, oscillation frequency
 *   ζ  damping ratio           – 0: undamped, <1: overshoot, 1: critical, >1: sluggish
 *   r  initial response        – 0: eases in, 1: immediate, >1: overshoot, <0: anticipation
 */
export interface SecondOrderParams {
  f: number;
  zeta: number;
  r: number;
}

/**
 * - `euler`: semi-implicit Euler with the raw constants; blows up when dt is large relative to 1/f.
 * - `clamped`: raises k2 just enough to keep the integration stable (adds lag at low frame rates).
 * - `pole-matching`: matches the discrete poles to the continuous system when it is too fast for dt.
 */
export type Integrator = 'euler' | 'clamped' | 'pole-matching';

export class SecondOrderDynamics {
  readonly dim: number;
  readonly y: Float64Array;
  readonly yd: Float64Array;
  integrator: Integrator = 'pole-matching';

  private readonly xp: Float64Array;
  private readonly xdEst: Float64Array;
  private k1 = 0;
  private k2 = 0;
  private k3 = 0;
  private w = 0;
  private z = 0;
  private d = 0;

  constructor(params: SecondOrderParams, x0: ArrayLike<number>) {
    this.dim = x0.length;
    this.y = new Float64Array(this.dim);
    this.yd = new Float64Array(this.dim);
    this.xp = new Float64Array(this.dim);
    this.xdEst = new Float64Array(this.dim);
    this.setParams(params);
    this.reset(x0);
  }

  setParams({ f, zeta, r }: SecondOrderParams): void {
    this.w = 2 * Math.PI * f;
    this.z = zeta;
    this.d = this.w * Math.sqrt(Math.abs(zeta * zeta - 1));
    this.k1 = zeta / (Math.PI * f);
    this.k2 = 1 / (this.w * this.w);
    this.k3 = (r * zeta) / this.w;
  }

  reset(x0: ArrayLike<number>): void {
    for (let i = 0; i < this.dim; i++) {
      this.y[i] = x0[i];
      this.xp[i] = x0[i];
      this.yd[i] = 0;
    }
  }

  /** Overwrite the output (e.g. after a constraint projection) while keeping velocity. */
  setOutput(y: ArrayLike<number>): void {
    for (let i = 0; i < this.dim; i++) this.y[i] = y[i];
  }

  /** Advance by `dt` toward input `x`. If the input velocity `xd` is unknown it is estimated by finite difference. */
  update(dt: number, x: ArrayLike<number>, xd?: ArrayLike<number>): Float64Array {
    if (dt <= 0) return this.y;
    let vel: ArrayLike<number>;
    if (xd) {
      vel = xd;
    } else {
      for (let i = 0; i < this.dim; i++) {
        this.xdEst[i] = (x[i] - this.xp[i]) / dt;
      }
      vel = this.xdEst;
    }
    for (let i = 0; i < this.dim; i++) this.xp[i] = x[i];

    const [k1, k2] = this.stableConstants(dt);
    for (let i = 0; i < this.dim; i++) {
      this.y[i] += dt * this.yd[i];
      this.yd[i] += (dt * (x[i] + this.k3 * vel[i] - this.y[i] - k1 * this.yd[i])) / k2;
    }
    return this.y;
  }

  private stableConstants(T: number): [number, number] {
    const { k1, k2 } = this;
    switch (this.integrator) {
      case 'euler':
        return [k1, k2];
      case 'clamped':
        return [k1, Math.max(k2, (T * T) / 2 + (T * k1) / 2, T * k1)];
      case 'pole-matching': {
        if (this.w * T < this.z) {
          return [k1, Math.max(k2, (T * T) / 2 + (T * k1) / 2, T * k1)];
        }
        const t1 = Math.exp(-this.z * this.w * T);
        const alpha = 2 * t1 * (this.z <= 1 ? Math.cos(T * this.d) : Math.cosh(T * this.d));
        const beta = t1 * t1;
        const t2 = T / (1 + beta - alpha);
        return [(1 - beta) * t2, T * t2];
      }
    }
  }
}

/** Convenience wrapper over three.js vectors. */
export class SecondOrderVec3 {
  readonly core: SecondOrderDynamics;
  readonly value = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  private readonly buf = new Float64Array(3);
  private readonly vbuf = new Float64Array(3);

  constructor(params: SecondOrderParams, x0: THREE.Vector3) {
    this.core = new SecondOrderDynamics(params, [x0.x, x0.y, x0.z]);
    this.value.copy(x0);
  }

  update(dt: number, x: THREE.Vector3, xd?: THREE.Vector3): THREE.Vector3 {
    this.buf[0] = x.x;
    this.buf[1] = x.y;
    this.buf[2] = x.z;
    let v: Float64Array | undefined;
    if (xd) {
      this.vbuf[0] = xd.x;
      this.vbuf[1] = xd.y;
      this.vbuf[2] = xd.z;
      v = this.vbuf;
    }
    const y = this.core.update(dt, this.buf, v);
    this.velocity.set(this.core.yd[0], this.core.yd[1], this.core.yd[2]);
    return this.value.set(y[0], y[1], y[2]);
  }

  /** Overwrite the output position (e.g. after a length constraint) while keeping velocity. */
  setOutput(v: THREE.Vector3): void {
    this.core.setOutput([v.x, v.y, v.z]);
    this.value.copy(v);
  }

  reset(x0: THREE.Vector3): void {
    this.core.reset([x0.x, x0.y, x0.z]);
    this.value.copy(x0);
    this.velocity.set(0, 0, 0);
  }
}

/** Response of a 1D system to a unit step applied at t = 0, sampled every `dt`. */
export function stepResponse(
  params: SecondOrderParams,
  dt: number,
  duration: number,
  integrator: Integrator = 'pole-matching',
): Float64Array {
  const sys = new SecondOrderDynamics(params, [0]);
  sys.integrator = integrator;
  const n = Math.max(1, Math.round(duration / dt));
  const out = new Float64Array(n + 1);
  const one = [1];
  for (let i = 1; i <= n; i++) out[i] = sys.update(dt, one)[0];
  return out;
}
