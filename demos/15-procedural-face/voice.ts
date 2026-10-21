/**
 * A tiny formant speech synthesizer: text → phonemes (letter rules) → parameter tracks → samples.
 *
 * It speaks like a 1970s robot, which is the point: it knows exactly which mouth shape every 10 ms belongs to,
 * so the audio-driven lip-sync in lipsync.ts can be scored against ground truth. Voicing is a Rosenberg glottal
 * pulse through three cascaded formant resonators (Klatt 1980); fricatives and bursts are noise through a band
 * resonator. Formants are Peterson & Barney's (1952) averages for men, scaled for a higher voice.
 */

import { Rng } from '../../src/math/random';

export const SAMPLE_RATE = 16000;

/** Mouth-shape classes (a subset of the common 15-viseme set). */
export const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'RR', 'aa', 'E', 'I', 'O', 'U'] as const;
export type Viseme = (typeof VISEMES)[number];

interface Phone {
  viseme: Viseme;
  dur: number; // seconds
  av: number; // voicing amplitude
  af: number; // frication amplitude
  f: [number, number, number]; // formants (Hz)
  fric?: [number, number]; // frication band centre and bandwidth (Hz)
  closure?: boolean; // plosive: silent (or voice bar) closure then a burst
  nasal?: boolean;
}

const V = (viseme: Viseme, f1: number, f2: number, f3: number, dur = 0.12): Phone => ({ viseme, dur, av: 1, af: 0, f: [f1, f2, f3] });

/** Phone inventory. Vowels: Peterson & Barney (1952), adult male averages. */
export const PHONES: Record<string, Phone> = {
  a: V('aa', 730, 1090, 2440),
  ae: V('E', 660, 1720, 2410),
  e: V('E', 530, 1840, 2480),
  i: V('I', 270, 2290, 3010),
  o: V('O', 570, 840, 2410),
  u: V('U', 300, 870, 2240),
  uh: V('aa', 640, 1190, 2390, 0.09),
  m: { viseme: 'PP', dur: 0.08, av: 0.35, af: 0, f: [250, 1100, 2200], nasal: true },
  n: { viseme: 'DD', dur: 0.07, av: 0.35, af: 0, f: [250, 1700, 2600], nasal: true },
  l: { viseme: 'DD', dur: 0.07, av: 0.6, af: 0, f: [360, 1300, 2700] },
  r: { viseme: 'RR', dur: 0.07, av: 0.6, af: 0, f: [420, 1300, 1600] },
  w: { viseme: 'U', dur: 0.06, av: 0.6, af: 0, f: [300, 700, 2200] },
  y: { viseme: 'I', dur: 0.06, av: 0.6, af: 0, f: [280, 2200, 2900] },
  b: { viseme: 'PP', dur: 0.08, av: 0.12, af: 0.3, f: [300, 1000, 2300], fric: [1200, 1500], closure: true },
  p: { viseme: 'PP', dur: 0.09, av: 0, af: 0.4, f: [400, 1000, 2300], fric: [1200, 1500], closure: true },
  d: { viseme: 'DD', dur: 0.07, av: 0.12, af: 0.35, f: [300, 1700, 2600], fric: [4000, 2000], closure: true },
  t: { viseme: 'DD', dur: 0.08, av: 0, af: 0.45, f: [400, 1700, 2600], fric: [4000, 2000], closure: true },
  g: { viseme: 'kk', dur: 0.07, av: 0.12, af: 0.35, f: [300, 1900, 2400], fric: [2200, 1000], closure: true },
  k: { viseme: 'kk', dur: 0.08, av: 0, af: 0.45, f: [400, 1900, 2400], fric: [2200, 1000], closure: true },
  f: { viseme: 'FF', dur: 0.1, av: 0, af: 0.18, f: [400, 1300, 2400], fric: [4500, 6000] },
  v: { viseme: 'FF', dur: 0.08, av: 0.35, af: 0.12, f: [300, 1300, 2400], fric: [4500, 6000] },
  th: { viseme: 'TH', dur: 0.1, av: 0, af: 0.15, f: [400, 1500, 2500], fric: [5000, 5000] },
  s: { viseme: 'SS', dur: 0.11, av: 0, af: 0.7, f: [400, 1700, 2600], fric: [6000, 2500] },
  z: { viseme: 'SS', dur: 0.09, av: 0.3, af: 0.5, f: [300, 1700, 2600], fric: [6000, 2500] },
  sh: { viseme: 'CH', dur: 0.11, av: 0, af: 0.7, f: [400, 1800, 2500], fric: [3000, 1500] },
  h: { viseme: 'sil', dur: 0.06, av: 0, af: 0.12, f: [600, 1400, 2500], fric: [1500, 3000] },
  _: { viseme: 'sil', dur: 0.05, av: 0, af: 0, f: [500, 1500, 2500] },
  pause: { viseme: 'sil', dur: 0.28, av: 0, af: 0, f: [500, 1500, 2500] },
};

/** Letter-to-phone rules: crude, but every word comes out as plausible English-ish sounds. */
export function toPhones(text: string): string[] {
  const out: string[] = [];
  const words = text.toLowerCase().split(/(\s+|[.,!?;:]+)/).filter((w) => w.length > 0);
  for (const word of words) {
    if (/^\s+$/.test(word)) {
      out.push('_');
      continue;
    }
    if (/^[.,!?;:]+$/.test(word)) {
      out.push('pause');
      continue;
    }
    let w = word.replace(/[^a-z]/g, '');
    // A final e is silent when another vowel comes before it (make, time); alone it is /i/ (she, me, we).
    let finalI = false;
    if (w.endsWith('e') && !/[aeiou]e$/.test(w)) {
      if (/[aeiouy]/.test(w.slice(0, -1))) w = w.slice(0, -1);
      else if (w.length > 1) {
        w = w.slice(0, -1);
        finalI = true;
      }
    }
    let i = 0;
    const at = (s: string) => w.startsWith(s, i);
    while (i < w.length) {
      const c = w[i];
      const next = w[i + 1] ?? '';
      const rules: [string, string[]][] = [
        ['igh', ['a', 'i']],
        ['ah', ['a']],
        ['aw', ['o']],
        ['au', ['o']],
        ['ar', ['a', 'r']],
        ['or', ['o', 'r']],
        ['sh', ['sh']],
        ['ch', ['t', 'sh']],
        ['th', ['th']],
        ['ph', ['f']],
        ['ng', ['n', 'g']],
        ['ck', ['k']],
        ['qu', ['k', 'w']],
        ['ee', ['i']],
        ['ea', ['i']],
        ['oo', ['u']],
        ['ou', ['a', 'u']],
        ['ow', ['o', 'u']],
        ['ai', ['e', 'i']],
        ['ay', ['e', 'i']],
        ['oa', ['o']],
        ['oy', ['o', 'i']],
        ['oi', ['o', 'i']],
        ['er', ['uh', 'r']],
        ['ir', ['uh', 'r']],
        ['ur', ['uh', 'r']],
      ];
      const rule = rules.find(([g]) => at(g));
      if (rule) {
        out.push(...rule[1]);
        i += rule[0].length;
        continue;
      }
      if (c === next && !'aeiou'.includes(c)) {
        i++;
        continue; // double consonant
      }
      const map: Record<string, string[]> = {
        a: ['ae'], e: ['e'], i: ['i'], o: ['o'], u: ['uh'],
        b: ['b'], d: ['d'], f: ['f'], g: ['g'], h: ['h'], j: ['d', 'sh'], k: ['k'], l: ['l'], m: ['m'],
        n: ['n'], p: ['p'], r: ['r'], s: ['s'], t: ['t'], v: ['v'], w: ['w'], z: ['z'],
        x: ['k', 's'],
        c: 'eiy'.includes(next) ? ['s'] : ['k'],
        y: i === w.length - 1 && i > 0 ? ['i'] : ['y'],
      };
      out.push(...(map[c] ?? []));
      i++;
    }
    if (finalI) out.push('i');
  }
  return out;
}

export interface Segment {
  phone: string;
  viseme: Viseme;
  start: number;
  end: number;
}

export interface Utterance {
  samples: Float32Array;
  sampleRate: number;
  segments: Segment[];
  duration: number;
  /** Ground-truth viseme at time t (seconds from the start). */
  visemeAt(t: number): Viseme;
}

export interface VoiceOptions {
  /** Fundamental frequency (Hz); formants scale with it from male (120 Hz) to female (210 Hz) values. */
  f0?: number;
  rate?: number;
  seed?: number;
}

/** Klatt digital resonator: y[n] = A x[n] + B y[n-1] + C y[n-2]. */
class Resonator {
  private y1 = 0;
  private y2 = 0;
  private a = 0;
  private b = 0;
  private c = 0;
  set(freq: number, bw: number, fs: number): void {
    const T = 1 / fs;
    this.c = -Math.exp(-2 * Math.PI * bw * T);
    this.b = 2 * Math.exp(-Math.PI * bw * T) * Math.cos(2 * Math.PI * freq * T);
    this.a = 1 - this.b - this.c;
  }
  step(x: number): number {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Formant scale for a voice of fundamental f0: 1 for a typical male voice, ~1.17 for a typical female one. */
export function formantScale(f0: number): number {
  return 1 + 0.17 * Math.min(1.3, Math.max(0, (f0 - 120) / 90));
}

export function synthesize(text: string, options: VoiceOptions = {}): Utterance {
  return synthesizePhones(toPhones(text), options, text.trim().endsWith('?'));
}

/** Speak a phone sequence (keys of PHONES), padded with pauses. */
export function synthesizePhones(sequence: string[], options: VoiceOptions = {}, question = false): Utterance {
  const fs = SAMPLE_RATE;
  const f0Base = options.f0 ?? 120;
  const rate = options.rate ?? 1;
  const k = formantScale(f0Base);
  const rng = new Rng(options.seed ?? 7);
  const phones = ['pause', ...sequence, 'pause'].filter((p) => PHONES[p]);

  const segments: Segment[] = [];
  let t = 0;
  for (const p of phones) {
    const ph = PHONES[p];
    const dur = ph.dur / rate;
    segments.push({ phone: p, viseme: ph.viseme, start: t, end: t + dur });
    t += dur;
  }
  const duration = t;
  const n = Math.ceil(duration * fs);
  const out = new Float32Array(n);

  const r1 = new Resonator();
  const r2 = new Resonator();
  const r3 = new Resonator();
  const rf = new Resonator();
  let phase = 0;
  let prevFlow = 0;
  let seg = 0;
  let prevAv = 0;
  let prevAf = 0;
  const cur = { f1: 500, f2: 1500, f3: 2500 };
  for (let i = 0; i < n; i++) {
    const time = i / fs;
    while (seg < segments.length - 1 && time >= segments[seg].end) seg++;
    const s = segments[seg];
    const ph = PHONES[s.phone];
    const u = (time - s.start) / (s.end - s.start);

    // Formants glide toward the current phone (≈ 25 ms time constant): coarticulation for free.
    const glide = 1 - Math.exp(-1 / (0.025 * fs));
    cur.f1 += (ph.f[0] * k - cur.f1) * glide;
    cur.f2 += (ph.f[1] * k - cur.f2) * glide;
    cur.f3 += (ph.f[2] * k - cur.f3) * glide;

    // Amplitudes: plosives are silent (or a voice bar) for 70 % of the phone, then burst.
    let av = ph.av;
    let af = ph.af;
    if (ph.closure) {
      if (u < 0.7) af = 0;
      else {
        av = 0;
        af *= Math.exp(-(u - 0.7) * 12);
      }
    }
    // 8 ms ramps on amplitude so segment edges do not click.
    const ramp = 1 - Math.exp(-1 / (0.008 * fs));
    prevAv += (av - prevAv) * ramp;
    prevAf += (af - prevAf) * ramp;

    // Intonation: declination over the utterance, a lift on the first vowel of each word, a rise for questions.
    const progress = time / duration;
    let f0 = f0Base * (1.08 - 0.18 * progress);
    if (question && progress > 0.8) f0 *= 1 + (progress - 0.8) * 1.5;
    f0 *= 1 + 0.01 * rng.normal();
    phase += f0 / fs;
    if (phase >= 1) phase -= 1;
    // Rosenberg glottal flow, differentiated (lip radiation).
    const open = 0.6;
    const flow = phase < open ? 0.5 * (1 - Math.cos((Math.PI * phase) / open)) : Math.max(0, Math.cos((Math.PI * (phase - open)) / (2 * (1 - open) * 0.5)));
    const src = (flow - prevFlow) * 8;
    prevFlow = flow;

    r1.set(cur.f1, ph.nasal ? 100 : 70, fs);
    r2.set(cur.f2, ph.nasal ? 300 : 100, fs);
    r3.set(cur.f3, 160, fs);
    let voiced = r3.step(r2.step(r1.step(src * prevAv)));
    if (ph.nasal) voiced *= 0.6;

    let noise = 0;
    if (prevAf > 1e-4) {
      const band = ph.fric ?? [2000, 3000];
      rf.set(Math.min(band[0] * k, fs * 0.45), band[1], fs);
      const w = rng.range(-1, 1);
      noise = rf.step(w) * prevAf * 1.5;
    } else {
      rf.step(0);
    }
    out[i] = voiced + noise;
  }
  // Remove DC from the glottal flow, then normalise.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  let hp = 0;
  let prev = 0;
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    const x = out[i] - mean;
    hp = 0.995 * (hp + x - prev);
    prev = x;
    out[i] = hp;
    peak = Math.max(peak, Math.abs(hp));
  }
  for (let i = 0; i < n; i++) out[i] *= 0.8 / peak;

  return {
    samples: out,
    sampleRate: fs,
    segments,
    duration,
    visemeAt(time: number): Viseme {
      for (const s of segments) if (time >= s.start && time < s.end) return s.viseme;
      return 'sil';
    },
  };
}
