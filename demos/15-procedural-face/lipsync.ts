/**
 * Audio-driven lip-sync without speech recognition.
 *
 * Each ~32 ms frame is reduced to a handful of acoustic features, and those map to mouth shapes because of how
 * vowels are made: the first formant F1 rises as the jaw opens, the second F2 rises as the lips spread and falls
 * as they round. Fricatives are noise, told apart by where their energy sits (s high, sh lower); silence closes
 * the mouth, which is also what a plosive's closure looks like.
 *
 *   formants  LPC (autocorrelation + Levinson–Durbin) → roots of A(z) (Durand–Kerner) → resonances
 *   pitch     normalised autocorrelation peak in 60–400 Hz, which also decides voiced vs unvoiced
 *   noise     FFT band energies
 */

import { formantScale, VISEMES, type Viseme } from './voice';

export const ANALYSIS_RATE = 16000;
export const FRAME = 512;
const LPC_ORDER = 14;

export interface Features {
  /** RMS level in dBFS over the frame. */
  db: number;
  /** RMS level of the newest 10 ms: drops the moment the lips close for a p or b. */
  recentDb: number;
  voiced: boolean;
  /** Pitch strength: normalised autocorrelation at the pitch lag. */
  periodicity: number;
  f0: number;
  f1: number;
  f2: number;
  /** Energy fractions in 0–1 k, 1–2.5 k, 2.5–4.5 k, 4.5–8 kHz. */
  bands: [number, number, number, number];
}

/** Resample the last `FRAME` analysis-rate samples' worth of `input` to 16 kHz (box filter + decimation). */
export function toAnalysisRate(input: Float32Array, sampleRate: number, out = new Float32Array(FRAME)): Float32Array {
  const ratio = sampleRate / ANALYSIS_RATE;
  const need = Math.floor(FRAME * ratio);
  const start = Math.max(0, input.length - need);
  for (let i = 0; i < FRAME; i++) {
    const a = start + Math.floor(i * ratio);
    const b = Math.max(a + 1, start + Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b && j < input.length; j++) s += input[j];
    out[i] = s / (b - a);
  }
  return out;
}

const hamming = Float64Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const hann = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const re = new Float64Array(FRAME);
const im = new Float64Array(FRAME);
const xw = new Float64Array(FRAME);

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/** Levinson–Durbin: LPC coefficients a[0..p] (a[0] = 1) from autocorrelation r[0..p]. */
export function levinson(r: Float64Array, p: number): Float64Array {
  const a = new Float64Array(p + 1);
  const tmp = new Float64Array(p + 1);
  a[0] = 1;
  let err = r[0];
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) break;
  }
  return a;
}

/** Roots of the monic polynomial z^p + a1 z^(p-1) + … + ap (Durand–Kerner). Returns [re, im] pairs. */
export function polyRoots(a: Float64Array, iterations = 80): [number, number][] {
  const p = a.length - 1;
  const zr = new Float64Array(p);
  const zi = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    // Initial guesses on a circle, off the real axis.
    const ang = (2 * Math.PI * i) / p + 0.4;
    zr[i] = 0.9 * Math.cos(ang);
    zi[i] = 0.9 * Math.sin(ang);
  }
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (let i = 0; i < p; i++) {
      // Evaluate the polynomial at z_i (Horner).
      let pr = 1;
      let pi = 0;
      for (let k = 1; k <= p; k++) {
        const nr = pr * zr[i] - pi * zi[i] + a[k];
        pi = pr * zi[i] + pi * zr[i];
        pr = nr;
      }
      // Divide by Π (z_i − z_j).
      let dr = 1;
      let di = 0;
      for (let j = 0; j < p; j++) {
        if (j === i) continue;
        const er = zr[i] - zr[j];
        const ei = zi[i] - zi[j];
        const nr = dr * er - di * ei;
        di = dr * ei + di * er;
        dr = nr;
      }
      const den = dr * dr + di * di || 1e-30;
      const qr = (pr * dr + pi * di) / den;
      const qi = (pi * dr - pr * di) / den;
      zr[i] -= qr;
      zi[i] -= qi;
      moved = Math.max(moved, Math.abs(qr) + Math.abs(qi));
    }
    if (moved < 1e-10) break;
  }
  return Array.from({ length: p }, (_, i) => [zr[i], zi[i]] as [number, number]);
}

/** Acoustic features of one 512-sample frame at 16 kHz. */
export function analyze(frame: Float32Array): Features {
  const n = FRAME;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += (frame[i] - mean) ** 2;
  const rms = Math.sqrt(energy / n);
  const db = 20 * Math.log10(rms + 1e-9);
  const tail = Math.round(ANALYSIS_RATE * 0.01);
  let recent = 0;
  for (let i = n - tail; i < n; i++) recent += (frame[i] - mean) ** 2;
  const recentDb = 20 * Math.log10(Math.sqrt(recent / tail) + 1e-9);

  // Pitch: normalised autocorrelation of the windowed frame in 60–400 Hz.
  for (let i = 0; i < n; i++) xw[i] = (frame[i] - mean) * hann[i];
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += xw[i] * xw[i];
  let best = 0;
  let bestLag = 0;
  const minLag = Math.floor(ANALYSIS_RATE / 400);
  const maxLag = Math.floor(ANALYSIS_RATE / 60);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += xw[i] * xw[i + lag];
    // Normalise by the overlap so long lags are not penalised by the window.
    const v = s / (r0 * (1 - lag / n) + 1e-12);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }

  // Band energies from the spectrum.
  for (let i = 0; i < n; i++) {
    re[i] = xw[i];
    im[i] = 0;
  }
  fft(re, im);
  const edges = [0, 1000, 2500, 4500, 8000];
  const bands: [number, number, number, number] = [0, 0, 0, 0];
  let total = 1e-12;
  for (let k = 1; k < n / 2; k++) {
    const f = (k * ANALYSIS_RATE) / n;
    const e = re[k] * re[k] + im[k] * im[k];
    total += e;
    for (let b = 0; b < 4; b++) if (f >= edges[b] && f < edges[b + 1]) bands[b] += e;
  }
  for (let b = 0; b < 4; b++) bands[b] /= total;

  const voiced = best > 0.45 && bands[0] + bands[1] > 0.5;

  // Formants: LPC of the pre-emphasised, Hamming-windowed frame.
  let f1 = 0;
  let f2 = 0;
  if (voiced) {
    let prev = frame[0] - mean;
    for (let i = 0; i < n; i++) {
      const x = frame[i] - mean;
      xw[i] = (x - 0.97 * prev) * hamming[i];
      prev = x;
    }
    const r = new Float64Array(LPC_ORDER + 1);
    for (let lag = 0; lag <= LPC_ORDER; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += xw[i] * xw[i + lag];
      r[lag] = s;
    }
    r[0] *= 1 + 1e-9; // white-noise correction keeps the recursion stable
    const a = levinson(r, LPC_ORDER);
    const candidates: number[] = [];
    for (const [zr, zi] of polyRoots(a)) {
      if (zi <= 0) continue;
      const freq = (Math.atan2(zi, zr) * ANALYSIS_RATE) / (2 * Math.PI);
      const bw = (-Math.log(Math.hypot(zr, zi)) * ANALYSIS_RATE) / Math.PI;
      if (freq > 180 && freq < 5000 && bw < 500) candidates.push(freq);
    }
    candidates.sort((x, y) => x - y);
    f1 = candidates.find((f) => f < 1100) ?? 0;
    f2 = candidates.find((f) => f > f1 + 150 && f > 600 && f < 3200) ?? 0;
  }
  return { db, recentDb, voiced, periodicity: best, f0: bestLag ? ANALYSIS_RATE / bestLag : 0, f1, f2, bands };
}

/** Where each vowel sits in normalised (open, spread) space; open ∝ F1, spread ∝ F2. */
const VOWEL_SPACE: Partial<Record<Viseme, [number, number]>> = {
  aa: [1.0, 0.18],
  E: [0.6, 0.75],
  I: [0.0, 1.0],
  O: [0.67, 0.0],
  U: [0.07, 0.02],
};

/** Normalised jaw opening and lip spread from F1/F2, for a speaker whose formants are `scale` × male averages. */
export function vowelCoordinates(f1: number, f2: number, scale = 1): [number, number] {
  const open = (f1 / scale - 280) / (730 - 280);
  const spread = (f2 / scale - 850) / (2290 - 850);
  return [Math.min(1.1, Math.max(-0.1, open)), Math.min(1.1, Math.max(-0.1, spread))];
}

export type Weights = Record<Viseme, number>;

export function emptyWeights(): Weights {
  return Object.fromEntries(VISEMES.map((v) => [v, 0])) as Weights;
}

export interface MapperState {
  /** Running noise floor (dBFS) for live input. */
  floor: number;
  /** Pitch-tracked formant scale. */
  scale: number;
}

export function createMapper(): MapperState {
  return { floor: -70, scale: 1 };
}

/**
 * Viseme weights for one frame of features. Loudness above the noise floor scales everything; voiced frames
 * soft-assign to the vowels by distance in (open, spread); noise frames go to SS / CH / FF by spectral balance.
 */
export function mapToVisemes(f: Features, state: MapperState, dt: number, out = emptyWeights()): Weights {
  for (const v of VISEMES) out[v] = 0;
  // The floor follows quiet passages quickly and loud ones slowly.
  state.floor += (f.db - state.floor) * (f.db < state.floor ? 0.5 : 1 - Math.exp(-dt / 8));
  state.floor = Math.max(-90, Math.min(-25, state.floor));
  // Loudness from the newest 10 ms, so a closure shows at once; the whole frame still decides what the sound is.
  const level = Math.min(1, Math.max(0, (Math.min(f.db + 3, f.recentDb) - state.floor - 8) / 22));
  if (level <= 0) {
    out.sil = 1;
    return out;
  }
  if (f.voiced && f.f1 > 0 && f.f2 > 0) {
    if (f.f0 > 60) state.scale += (formantScale(f.f0) - state.scale) * (1 - Math.exp(-dt / 0.5));
    const [open, spread] = vowelCoordinates(f.f1, f.f2, state.scale);
    let sum = 0;
    for (const [v, [o, s]] of Object.entries(VOWEL_SPACE) as [Viseme, [number, number]][]) {
      const d2 = (open - o) ** 2 + (spread - s) ** 2;
      const w = Math.exp(-d2 / (2 * 0.22 * 0.22));
      out[v] = w;
      sum += w;
    }
    for (const v of Object.keys(VOWEL_SPACE) as Viseme[]) out[v] = (out[v] / sum) * level;
    out.sil = 1 - level;
    return out;
  }
  if (!f.voiced && f.bands[2] + f.bands[3] > 0.35) {
    const fric: Viseme = f.bands[3] > f.bands[2] * 1.3 ? 'SS' : f.bands[2] > f.bands[3] * 1.3 ? 'CH' : 'FF';
    out[fric] = level;
    out.sil = 1 - level;
    return out;
  }
  // Voiced but no clean formants. Energy almost all below 1 kHz is a nasal murmur or a voice bar — sound
  // through the nose or behind closed lips (m, b) — so the lips close; otherwise a half-closed mouth (n, l, d).
  if (f.voiced && f.bands[0] > 0.85) {
    out.PP = level;
    out.sil = 1 - level;
    return out;
  }
  out.DD = level * 0.6;
  out.sil = 1 - level * 0.6;
  return out;
}

/** The viseme with the largest weight. */
export function dominant(w: Weights): Viseme {
  let best: Viseme = 'sil';
  for (const v of VISEMES) if (w[v] > w[best]) best = v;
  return best;
}

/**
 * Smooth weights toward targets with a critically damped spring per viseme: 35 ms half-life rising, enough to
 * hide frame-to-frame flicker in the analysis, and 18 ms falling, because lips shut fast — fast enough to close
 * within a 60 ms plosive closure.
 */
export class VisemeSmoother {
  readonly value = emptyWeights();
  private readonly vel = emptyWeights();
  attack = 0.035;
  release = 0.018;

  update(target: Weights, dt: number): Weights {
    for (const v of VISEMES) {
      const halflife = target[v] > this.value[v] ? this.attack : this.release;
      const y = (4 * Math.LN2) / (halflife + 1e-5) / 2;
      const j0 = this.value[v] - target[v];
      const j1 = this.vel[v] + j0 * y;
      const e = Math.exp(-y * dt);
      this.value[v] = e * (j0 + j1 * dt) + target[v];
      this.vel[v] = e * (this.vel[v] - j1 * y * dt);
    }
    return this.value;
  }

  reset(): void {
    for (const v of VISEMES) {
      this.value[v] = v === 'sil' ? 1 : 0;
      this.vel[v] = 0;
    }
  }
}
