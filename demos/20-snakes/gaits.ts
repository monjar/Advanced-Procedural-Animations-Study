import type { Gait, ShapeFrame } from './slither';

/**
 * Body shapes over time for four limbless gaits. Each writes positions in the body frame (tail at the origin,
 * head toward +x at rest), weights, grips and radii; slither.ts turns them into motion.
 */

export interface Friction {
  /** Forward, backward and sideways friction coefficients. */
  muF: number;
  muB: number;
  muN: number;
}

/** Hu et al.'s measurements for a corn snake on cloth. */
export const SNAKE_SKIN: Friction = { muF: 0.11, muB: 0.14, muN: 0.2 };

/** Integrate tangent angles φ(s) into positions (arc-length parametrised). */
function integrate(out: ShapeFrame, phi: (s: number) => number, length: number): void {
  const n = out.n;
  const ds = length / (n - 1);
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const a = phi(i * ds);
    out.tx[i] = Math.cos(a);
    out.ty[i] = Math.sin(a);
    if (i > 0) {
      // Midpoint rule between this tangent and the previous one.
      const am = phi((i - 0.5) * ds);
      x += Math.cos(am) * ds;
      y += Math.sin(am) * ds;
    }
    out.x[i] = x;
    out.y[i] = y;
  }
}

/** Snake radius along the body: a blunt head, the widest point a third of the way back, a long tapering tail. */
function snakeRadius(u: number, r: number): number {
  const tail = Math.min(1, u / 0.45);
  const head = Math.min(1, (1 - u) / 0.04);
  return r * (0.25 + 0.75 * Math.sqrt(tail)) * (0.55 + 0.45 * Math.sqrt(Math.max(0, head)));
}

export interface UndulationParams {
  /** Peak tangent angle of the serpenoid wave (rad). */
  amplitude: number;
  /** Waves along the body. */
  waves: number;
  /** Wave frequency (Hz). */
  frequency: number;
  /** Lift the body where it bends most (0 = flat, 1 = Hu's "dynamic lifting" at full strength). */
  lift: number;
  /** Curvature bias for steering (rad/m). */
  turn: number;
  friction: Friction;
}

/**
 * Lateral undulation on a serpenoid curve (Hirose 1993): tangent angle φ(s, t) = A cos(2π(k s/L + f t)) — a
 * wave of bending travelling from head to tail. Friction stronger sideways than lengthwise turns that
 * backward wave into forward thrust.
 */
export class Undulation implements Gait {
  readonly n = 48;
  readonly length = 1;
  constructor(public p: UndulationParams) {}

  shape(t: number, out: ShapeFrame): void {
    const { amplitude: A, waves: k, frequency: f, lift, turn } = this.p;
    const L = this.length;
    integrate(out, (s) => A * Math.cos(2 * Math.PI * ((k * s) / L + f * t)) + turn * (s - L / 2), L);
    // Curvature |dφ/ds| ∝ |sin|: lift the most curved parts.
    let total = 0;
    for (let i = 0; i < out.n; i++) {
      const s = (i * L) / (out.n - 1);
      const bend = Math.abs(Math.sin(2 * Math.PI * ((k * s) / L + f * t)));
      const w = Math.max(0, 1 - lift * bend ** 2);
      out.weight[i] = w;
      out.z[i] = (1 - w) * 0.02;
      total += w;
      out.muF[i] = this.p.friction.muF;
      out.muB[i] = this.p.friction.muB;
      out.muN[i] = this.p.friction.muN;
      out.radius[i] = snakeRadius(i / (out.n - 1), 0.022);
    }
    for (let i = 0; i < out.n; i++) out.weight[i] /= total;
  }
}

export interface SidewindParams {
  amplitude: number;
  waves: number;
  frequency: number;
  /** Phase of the lifting wave relative to the bending wave (rad); ±π/2 sidewinds. */
  liftPhase: number;
  /** Lifting on/off (0..1): with no lifting the same bending wave just thrashes. */
  lift: number;
  friction: Friction;
}

/**
 * Sidewinding (Marvi et al., Science 2014): the bending wave plus a lifting wave a quarter-period out of phase.
 * Only the parts of the body that are momentarily still touch the ground, laid down in a row of separate
 * J-shaped tracks; the rest is carried through the air. It works on isotropic friction, even on sand.
 */
export class Sidewinder implements Gait {
  readonly n = 48;
  readonly length = 1;
  constructor(public p: SidewindParams) {}

  shape(t: number, out: ShapeFrame): void {
    const { amplitude: A, waves: k, frequency: f, liftPhase, lift } = this.p;
    const L = this.length;
    const phase = (s: number) => 2 * Math.PI * ((k * s) / L + f * t);
    integrate(out, (s) => A * Math.cos(phase(s)), L);
    let total = 0;
    for (let i = 0; i < out.n; i++) {
      const s = (i * L) / (out.n - 1);
      const up = Math.sin(phase(s) + liftPhase);
      // Contact where the lifting wave is down; lifted (no weight) elsewhere.
      const w = 1 - lift * Math.min(1, Math.max(0, up * 2.5 + 0.5));
      out.weight[i] = Math.max(0, w);
      out.z[i] = lift * Math.max(0, up) * 0.06;
      total += out.weight[i];
      out.muF[i] = this.p.friction.muF;
      out.muB[i] = this.p.friction.muB;
      out.muN[i] = this.p.friction.muN;
      out.radius[i] = snakeRadius(i / (out.n - 1), 0.024);
    }
    for (let i = 0; i < out.n; i++) out.weight[i] = total > 0 ? out.weight[i] / total : 0;
  }
}

export interface WormParams {
  /** Fractional segment stretch (0.3 = segments vary ±30 %). */
  stretch: number;
  waves: number;
  frequency: number;
  /** +1: the wave runs head → tail (retrograde, as in earthworms); −1: tail → head. */
  direction: number;
  /** Bristles (setae): friction backward / forward. */
  friction: Friction;
  turn: number;
}

/**
 * Earthworm peristalsis: a wave of segment lengthening runs along the body. Volume is conserved, so short
 * segments are fat; their bristles grip backward far harder than forward, so each segment, anchored while
 * short, can only slide forward when it lengthens.
 */
export class Worm implements Gait {
  readonly n = 40;
  readonly length = 0.18;
  constructor(public p: WormParams) {}

  shape(t: number, out: ShapeFrame): void {
    const { stretch, waves: k, frequency: f, direction, turn } = this.p;
    const n = out.n;
    const l0 = this.length / (n - 1);
    let x = 0;
    let y = 0;
    let a = 0;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const ext = 1 + stretch * Math.sin(2 * Math.PI * (k * u + direction * f * t));
      a = turn * (u - 0.5) * this.length;
      if (i > 0) {
        x += Math.cos(a) * l0 * ext;
        y += Math.sin(a) * l0 * ext;
      }
      out.x[i] = x;
      out.y[i] = y;
      out.tx[i] = Math.cos(a);
      out.ty[i] = Math.sin(a);
      out.z[i] = 0;
      out.weight[i] = 1 / n;
      out.muF[i] = this.p.friction.muF;
      out.muB[i] = this.p.friction.muB;
      out.muN[i] = this.p.friction.muN;
      // Constant volume: radius ∝ 1/√stretch; slightly pointed ends.
      const ends = Math.min(1, u / 0.08, (1 - u) / 0.05);
      out.radius[i] = (0.0035 / Math.sqrt(ext)) * (0.45 + 0.55 * Math.sqrt(Math.max(0, ends)));
    }
  }
}

export interface InchwormParams {
  frequency: number;
  /** How far the body bunches up: the chord shrinks to (1 − reach) of the body length. */
  reach: number;
  /** Grip of a planted end, and of a sliding one. */
  grip: number;
  slip: number;
}

/**
 * Inchworm (a looper caterpillar): the prolegs at the back and the true legs at the front take turns gripping.
 * The middle arches up as the back end is pulled forward under the planted front, then flattens as the front
 * reaches out from the planted back. Distance per cycle is the change in chord — nothing slides that grips.
 */
export class Inchworm implements Gait {
  readonly n = 36;
  readonly length = 0.05 * 1.6;
  private readonly sx = new Float64Array(200);
  private readonly sz = new Float64Array(200);
  private readonly sl = new Float64Array(200);
  constructor(public p: InchwormParams) {}

  /** Chord as a fraction of body length at time t: 1 (flat) → 1 − reach (arched) → 1. */
  chord(t: number): number {
    return 1 - this.p.reach * 0.5 * (1 - Math.cos(2 * Math.PI * this.p.frequency * t));
  }

  shape(t: number, out: ShapeFrame): void {
    const n = out.n;
    const L = this.length;
    const pad = 0.2; // the flat, gripping fraction at each end
    const flat = pad * L;
    const archLen = L - 2 * flat;
    const chord = this.chord(t) * L - 2 * flat;
    // Arch z = H sin²(π x / chord), level where it meets the planted ends: find H whose arc length is archLen.
    const M = this.sx.length;
    const arcLen = (H: number) => {
      let s = 0;
      let px = 0;
      let pz = 0;
      for (let j = 1; j < M; j++) {
        const x = (chord * j) / (M - 1);
        const z = H * Math.sin((Math.PI * x) / Math.max(chord, 1e-6)) ** 2;
        s += Math.hypot(x - px, z - pz);
        px = x;
        pz = z;
      }
      return s;
    };
    let lo = 0;
    let hi = archLen;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (arcLen(mid) < archLen) lo = mid;
      else hi = mid;
    }
    const H = (lo + hi) / 2;
    // Tabulate the arch by arc length.
    let s = 0;
    for (let j = 0; j < M; j++) {
      const x = (chord * j) / (M - 1);
      const z = H * Math.sin((Math.PI * x) / Math.max(chord, 1e-6)) ** 2;
      if (j > 0) s += Math.hypot(x - this.sx[j - 1], z - this.sz[j - 1]);
      this.sx[j] = x;
      this.sz[j] = z;
      this.sl[j] = s;
    }
    // Contracting (chord shrinking): the front grips and the back slides up; extending: the reverse.
    const contracting = Math.sin(2 * Math.PI * this.p.frequency * t) > 0;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * L;
      let x: number;
      let z = 0;
      let contact = 0;
      let gripping = false;
      if (u <= flat) {
        x = u;
        contact = 1;
        gripping = !contracting;
      } else if (u >= L - flat) {
        x = flat + chord + (u - (L - flat));
        contact = 1;
        gripping = contracting;
      } else {
        const target = u - flat;
        let j = 1;
        while (j < M - 1 && this.sl[j] < target) j++;
        const a = (target - this.sl[j - 1]) / Math.max(1e-9, this.sl[j] - this.sl[j - 1]);
        x = flat + this.sx[j - 1] + a * (this.sx[j] - this.sx[j - 1]);
        z = this.sz[j - 1] + a * (this.sz[j] - this.sz[j - 1]);
      }
      out.x[i] = x;
      out.y[i] = 0;
      out.z[i] = z;
      out.tx[i] = 1;
      out.ty[i] = 0;
      out.weight[i] = contact;
      const mu = gripping ? this.p.grip : this.p.slip;
      out.muF[i] = mu;
      out.muB[i] = mu;
      out.muN[i] = Math.max(mu, 0.5);
      const v = i / (n - 1);
      out.radius[i] = 0.0035 * Math.min(1, v / 0.06 + 0.4, (1 - v) / 0.05 + 0.5);
    }
    let total = 0;
    for (let i = 0; i < n; i++) total += out.weight[i];
    for (let i = 0; i < n; i++) out.weight[i] /= total;
  }
}
