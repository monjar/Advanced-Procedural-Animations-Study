import type { Rng } from '../../src/math/random.ts';

/**
 * Creature genome (after Sims 1994, simplified): a tree of box parts, each hinged to its parent and driven by
 * an oscillator sharing one frequency. A limb attached to the root can be mirrored across the body's x = 0
 * plane (with its whole subtree, half a cycle out of phase), which is how symmetric walkers appear.
 */

export type Vec3 = [number, number, number];

export interface PartGene {
  /** Parent part index (−1 for the root, which is always part 0). Parents come before children. */
  parent: number;
  /** Box half extents (m). */
  size: Vec3;
  /** Attachment point on the parent box, normalised (−1..1 per axis); snapped to the dominant face. */
  attach: Vec3;
  /** Hinge axis in the parent frame (normalised when built). */
  axis: Vec3;
  /** Hinge range ±limit (rad). */
  limit: number;
  /** Oscillation: amplitude and offset as fractions of the limit, phase in rad. */
  amp: number;
  offset: number;
  phase: number;
  /** Root limbs only: add a mirrored copy. */
  mirror: boolean;
}

export interface Genome {
  parts: PartGene[];
  /** Shared oscillator frequency (Hz). */
  frequency: number;
}

export const LIMITS = {
  maxGenes: 8,
  maxDepth: 4,
  minSize: 0.03,
  maxSize: 0.4,
  minLimit: 0.2,
  maxLimit: 1.4,
  minFrequency: 0.5,
  maxFrequency: 3,
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function randomSize(rng: Rng): Vec3 {
  return [rng.range(0.04, 0.25), rng.range(0.04, 0.25), rng.range(0.04, 0.25)];
}

function randomUnit(rng: Rng): Vec3 {
  const v: Vec3 = [rng.normal(), rng.normal(), rng.normal()];
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function randomPart(rng: Rng, parent: number): PartGene {
  return {
    parent,
    size: randomSize(rng),
    attach: [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)],
    axis: randomUnit(rng),
    limit: rng.range(LIMITS.minLimit, LIMITS.maxLimit),
    amp: rng.range(0.2, 1),
    offset: rng.range(-0.3, 0.3),
    phase: rng.range(0, Math.PI * 2),
    mirror: parent === 0 && rng.chance(0.5),
  };
}

export function depthOf(g: Genome, i: number): number {
  let d = 0;
  while (g.parts[i].parent >= 0) {
    i = g.parts[i].parent;
    d++;
  }
  return d;
}

export function randomGenome(rng: Rng): Genome {
  const parts: PartGene[] = [{ ...randomPart(rng, -1), size: [rng.range(0.1, 0.3), rng.range(0.06, 0.15), rng.range(0.1, 0.3)], mirror: false }];
  const n = 2 + rng.int(4);
  for (let i = 0; i < n; i++) {
    const g = { parts, frequency: 1 };
    const candidates = parts.map((_, k) => k).filter((k) => depthOf(g, k) < LIMITS.maxDepth - 1);
    parts.push(randomPart(rng, rng.pick(candidates)));
  }
  return { parts, frequency: rng.range(LIMITS.minFrequency, LIMITS.maxFrequency) };
}

export function cloneGenome(g: Genome): Genome {
  return { frequency: g.frequency, parts: g.parts.map((p) => ({ ...p, size: [...p.size], attach: [...p.attach], axis: [...p.axis] })) };
}

/** Problems with a genome (empty when valid). */
export function validate(g: Genome): string[] {
  const errors: string[] = [];
  if (!g.parts.length || g.parts[0].parent !== -1) errors.push('part 0 must be the root');
  if (g.parts.length > LIMITS.maxGenes) errors.push('too many parts');
  if (!(g.frequency >= LIMITS.minFrequency && g.frequency <= LIMITS.maxFrequency)) errors.push('frequency out of range');
  g.parts.forEach((p, i) => {
    if (i > 0 && !(p.parent >= 0 && p.parent < i)) errors.push(`part ${i}: parent must come first`);
    if (p.size.some((s) => !(s >= LIMITS.minSize && s <= LIMITS.maxSize))) errors.push(`part ${i}: size out of range`);
    if (p.attach.some((a) => !(a >= -1 && a <= 1))) errors.push(`part ${i}: attach out of range`);
    if (!(Math.hypot(...p.axis) > 1e-6)) errors.push(`part ${i}: degenerate axis`);
    if (!(p.limit >= LIMITS.minLimit && p.limit <= LIMITS.maxLimit)) errors.push(`part ${i}: limit out of range`);
    if (!(p.amp >= 0 && p.amp <= 1) || !(p.offset >= -0.5 && p.offset <= 0.5) || !Number.isFinite(p.phase)) errors.push(`part ${i}: oscillator out of range`);
    if (p.mirror && p.parent !== 0) errors.push(`part ${i}: only root limbs mirror`);
    if (i > 0 && depthOf(g, i) >= LIMITS.maxDepth) errors.push(`part ${i}: too deep`);
  });
  return errors;
}

/** Remove part `i` and its subtree, re-indexing parents. */
function removeSubtree(g: Genome, i: number): void {
  const doomed = new Set<number>([i]);
  for (let k = i + 1; k < g.parts.length; k++) if (doomed.has(g.parts[k].parent)) doomed.add(k);
  const remap = new Map<number, number>();
  const kept: PartGene[] = [];
  g.parts.forEach((p, k) => {
    if (doomed.has(k)) return;
    remap.set(k, kept.length);
    kept.push(p);
  });
  for (const p of kept) if (p.parent >= 0) p.parent = remap.get(p.parent)!;
  g.parts = kept;
}

/** Gaussian parameter mutation plus occasional structural change (add a part, drop a subtree, toggle a mirror). */
export function mutate(src: Genome, rng: Rng, rate = 0.25, scale = 0.15): Genome {
  const g = cloneGenome(src);
  const jitter = (v: number, s: number) => (rng.chance(rate) ? v + rng.normal() * s : v);
  g.frequency = clamp(jitter(g.frequency, scale * 1.5), LIMITS.minFrequency, LIMITS.maxFrequency);
  g.parts.forEach((p, i) => {
    p.size = p.size.map((s) => clamp(jitter(s, scale * 0.15), LIMITS.minSize, LIMITS.maxSize)) as Vec3;
    p.attach = p.attach.map((a) => clamp(jitter(a, scale * 1.5), -1, 1)) as Vec3;
    p.axis = p.axis.map((a) => jitter(a, scale * 2)) as Vec3;
    if (Math.hypot(...p.axis) < 1e-3) p.axis = [1, 0, 0];
    p.limit = clamp(jitter(p.limit, scale * 1.5), LIMITS.minLimit, LIMITS.maxLimit);
    p.amp = clamp(jitter(p.amp, scale), 0, 1);
    p.offset = clamp(jitter(p.offset, scale), -0.5, 0.5);
    p.phase = jitter(p.phase, scale * 6) % (Math.PI * 2);
    if (i > 0 && p.parent === 0 && rng.chance(rate * 0.2)) p.mirror = !p.mirror;
  });
  if (rng.chance(rate * 0.3) && g.parts.length < LIMITS.maxGenes) {
    const candidates = g.parts.map((_, k) => k).filter((k) => depthOf(g, k) < LIMITS.maxDepth - 1);
    g.parts.push(randomPart(rng, rng.pick(candidates)));
  }
  if (rng.chance(rate * 0.2) && g.parts.length > 2) removeSubtree(g, 1 + rng.int(g.parts.length - 1));
  return g;
}

/** Child = `a` with one of its subtrees replaced by a subtree of `b` (kept within the limits). */
export function crossover(a: Genome, b: Genome, rng: Rng): Genome {
  const child = cloneGenome(a);
  child.frequency = rng.chance(0.5) ? a.frequency : b.frequency;
  if (a.parts.length < 2 || b.parts.length < 2) return child;
  const target = 1 + rng.int(child.parts.length - 1);
  const parent = child.parts[target].parent;
  removeSubtree(child, target);
  // Subtree of b rooted at a random non-root part.
  const from = 1 + rng.int(b.parts.length - 1);
  const sub = [from];
  for (let k = from + 1; k < b.parts.length; k++) if (sub.includes(b.parts[k].parent)) sub.push(k);
  const map = new Map<number, number>();
  const newParent = Math.min(parent, child.parts.length - 1);
  for (const k of sub) {
    if (child.parts.length >= LIMITS.maxGenes) break;
    const src = b.parts[k];
    const p: PartGene = { ...src, size: [...src.size], attach: [...src.attach], axis: [...src.axis] };
    p.parent = k === from ? newParent : map.get(src.parent) ?? -2;
    if (p.parent === -2) continue;
    if (p.parent !== 0) p.mirror = false;
    const g = { parts: [...child.parts, p], frequency: child.frequency };
    if (depthOf(g, g.parts.length - 1) >= LIMITS.maxDepth) continue;
    map.set(k, child.parts.length);
    child.parts.push(p);
  }
  return child;
}
