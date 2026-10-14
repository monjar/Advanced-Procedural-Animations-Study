/**
 * Quadruped gait table. Each gait is described the way biologists do (Hildebrand): per-leg footfall
 * phase offset (fraction of the stride cycle at which the foot touches down) and duty factor (fraction
 * of the cycle a foot spends on the ground). Legs are ordered LF, RF, LH, RH.
 */
export type GaitName = 'walk' | 'trot' | 'canter' | 'gallop';

export interface GaitDef {
  offsets: [number, number, number, number];
  duty: number;
  /** Vertical body bob amplitude (m) and bobs per stride. */
  bob: number;
  bobsPerStride: number;
  /** Body pitch oscillation amplitude (rad) — rocking in canter/gallop. */
  pitch: number;
  /** Spine flexion amplitude (0..1) — gathering/extension in the gallop. */
  flex: number;
}

export const LEG_NAMES = ['LF', 'RF', 'LH', 'RH'] as const;

export const GAITS: Record<GaitName, GaitDef> = {
  // Lateral-sequence walk: LH → LF → RH → RF, ≥ 2 feet always down.
  walk: { offsets: [0.25, 0.75, 0.0, 0.5], duty: 0.65, bob: 0.008, bobsPerStride: 2, pitch: 0.0, flex: 0 },
  // Diagonal pairs in unison.
  trot: { offsets: [0.0, 0.5, 0.5, 0.0], duty: 0.42, bob: 0.02, bobsPerStride: 2, pitch: 0.01, flex: 0 },
  // Three-beat (left lead): RH, then LH + RF together, then LF.
  canter: { offsets: [0.6, 0.3, 0.3, 0.0], duty: 0.4, bob: 0.04, bobsPerStride: 1, pitch: 0.06, flex: 0.3 },
  // Rotary gallop (dog): LH, RH, RF, LF with a suspension phase.
  gallop: { offsets: [0.6, 0.48, 0.0, 0.1], duty: 0.3, bob: 0.05, bobsPerStride: 1, pitch: 0.09, flex: 1 },
};

/** Speeds (m/s) at which each gait takes over, for a ~0.6 m tall dog. */
export const TRANSITIONS: { gait: GaitName; at: number }[] = [
  { gait: 'walk', at: 0 },
  { gait: 'trot', at: 1.4 },
  { gait: 'canter', at: 3.6 },
  { gait: 'gallop', at: 5.4 },
];

/** Half-width (m/s) of the blend band around each transition speed. */
export const BLEND = 0.35;

export interface BlendedGait {
  offsets: number[];
  duty: number;
  bob: number;
  bobsPerStride: number;
  pitch: number;
  flex: number;
  /** Stride frequency (Hz). */
  frequency: number;
  weights: Record<GaitName, number>;
}

/** Shortest signed difference b − a on the unit circle of phases, in [−0.5, 0.5). */
export function phaseDelta(a: number, b: number): number {
  let d = (b - a) % 1;
  if (d >= 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

export function frac(x: number): number {
  return x - Math.floor(x);
}

/** Stride frequency rises with speed and saturates; stride length does the rest. */
export function strideFrequency(speed: number): number {
  return Math.min(3.6, 1.4 + 0.45 * speed);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Gait parameters at a given speed, blending neighbouring gaits across each transition band. */
export function blendGait(speed: number): BlendedGait {
  // Highest gait whose blend band has been entered.
  let i = 0;
  while (i + 1 < TRANSITIONS.length && speed > TRANSITIONS[i + 1].at - BLEND) i++;
  const weights: Record<GaitName, number> = { walk: 0, trot: 0, canter: 0, gallop: 0 };
  const cur = TRANSITIONS[i];
  if (i === 0) {
    weights[cur.gait] = 1;
    return mix(GAITS[cur.gait], GAITS[cur.gait], 0, speed, weights);
  }
  const prev = TRANSITIONS[i - 1];
  const t = smoothstep(cur.at - BLEND, cur.at + BLEND, speed);
  weights[prev.gait] = 1 - t;
  weights[cur.gait] = t;
  return mix(GAITS[prev.gait], GAITS[cur.gait], t, speed, weights);
}

function mix(a: GaitDef, b: GaitDef, t: number, speed: number, weights: Record<GaitName, number>): BlendedGait {
  const lerp = (x: number, y: number) => x + (y - x) * t;
  return {
    offsets: a.offsets.map((o, k) => frac(o + phaseDelta(o, b.offsets[k]) * t)),
    duty: lerp(a.duty, b.duty),
    bob: lerp(a.bob, b.bob),
    bobsPerStride: t < 0.5 ? a.bobsPerStride : b.bobsPerStride,
    pitch: lerp(a.pitch, b.pitch),
    flex: lerp(a.flex, b.flex),
    frequency: strideFrequency(speed),
    weights,
  };
}

/** Which legs are in stance at phase φ for a blended gait. */
export function stanceAt(g: BlendedGait, phase: number): boolean[] {
  return g.offsets.map((o) => frac(phase - o) < g.duty);
}
