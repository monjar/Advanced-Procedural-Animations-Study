import { describe, expect, it } from 'vitest';
import { buildFeatures, DEFAULT_WEIGHTS, DIMS, dimWeights, GROUPS, GROUP_START, MIN_REMAINING, searchBrute, frameCost } from '../../src/anim/mmfeatures';
import { loadMotionDB } from '../support/mmdb';

const db = loadMotionDB();
const t0 = performance.now();
const mf = buildFeatures(db);
const buildMs = performance.now() - t0;
const w = dimWeights(DEFAULT_WEIGHTS);
const takeByName = (name: string, mirrored = false) => db.takes.find((t) => t.name === name && t.mirrored === mirrored)!;

describe('motion matching features', () => {
  it('builds for the whole mirrored database at load time', () => {
    expect(DIMS).toBe(27);
    expect(buildMs).toBeLessThan(2000); // ~150 ms on a laptop; generous for CI
  });

  it('normalises every group to zero mean and unit pooled deviation', () => {
    const N = db.frames;
    GROUPS.forEach((g, gi) => {
      let v2 = 0;
      for (let d = GROUP_START[gi]; d < GROUP_START[gi] + g.size; d++) {
        let s = 0;
        for (let f = 0; f < N; f++) s += mf.features[f * DIMS + d];
        expect(Math.abs(s / N)).toBeLessThan(1e-4);
        for (let f = 0; f < N; f++) v2 += mf.features[f * DIMS + d] ** 2;
      }
      expect(Math.sqrt(v2 / (N * g.size))).toBeCloseTo(1, 4);
    });
  });

  it('describes motion in the simulation bone frame: walks look ahead, turns bend the right way', () => {
    // Straight walk mid-take: +30 frames lands ~0.5 s × speed straight ahead.
    const walk = takeByName('16_15');
    const f = walk.start + 100;
    const ahead = mf.raw[f * DIMS + 5];
    expect(ahead).toBeGreaterThan(0.4);
    expect(ahead).toBeLessThan(0.65);
    expect(Math.abs(mf.raw[f * DIMS + 4])).toBeLessThan(0.08);
    // Mid left turn: the future bends to +x (the character's left); mirrored, to −x.
    const turn = takeByName('16_17');
    let side = 0;
    let mside = 0;
    const mturn = takeByName('16_17', true);
    for (let i = 60; i < turn.frames - 60; i++) {
      side += mf.raw[(turn.start + i) * DIMS + 10];
      mside += mf.raw[(mturn.start + i) * DIMS + 10];
    }
    expect(side).toBeGreaterThan(0);
    expect(mside).toBeLessThan(0);
    expect(Math.abs(side + mside)).toBeLessThan(0.05 * Math.abs(side));
  });

  it('only lets the search land where the take continues', () => {
    for (const t of db.takes) {
      for (let i = 0; i < t.frames; i++) expect(mf.matchable[t.start + i]).toBe(i < t.frames - MIN_REMAINING ? 1 : 0);
    }
  });

  it('finds every sampled frame as its own best match, at zero cost', () => {
    const q = new Float32Array(DIMS);
    let checked = 0;
    for (let f = 0; f < db.frames; f += 97) {
      if (!mf.matchable[f]) continue;
      q.set(mf.features.subarray(f * DIMS, (f + 1) * DIMS));
      const m = searchBrute(mf, q, w);
      expect(m.cost).toBe(0);
      expect(frameCost(mf, q, w, m.frame)).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('AABB-accelerated search', () => {
  it('returns exactly the brute-force frame and cost, on database frames and noisy queries', async () => {
    const { searchAABB } = await import('../../src/anim/mmfeatures');
    const q = new Float32Array(DIMS);
    let s = 7;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 2;
    let mismatches = 0;
    for (let i = 0; i < 1500; i++) {
      const f = Math.floor(((i * 7919) % db.frames));
      q.set(mf.features.subarray(f * DIMS, (f + 1) * DIMS));
      if (i % 2) for (let d = 0; d < DIMS; d++) q[d] += rnd() * 0.5;
      const a = searchBrute(mf, q, w);
      const b = searchAABB(mf, q, w);
      if (a.frame !== b.frame || a.cost !== b.cost) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('evaluates a fraction of the candidates', async () => {
    const mod = await import('../../src/anim/mmfeatures');
    const q = new Float32Array(DIMS);
    let total = 0;
    let n = 0;
    for (let f = 0; f < db.frames; f += 211) {
      if (!mf.matchable[f]) continue;
      q.set(mf.features.subarray(f * DIMS, (f + 1) * DIMS));
      q[0] += 0.3; // not an exact database frame
      mod.searchAABB(mf, q, w);
      total += mod.aabbEvaluated;
      n++;
    }
    const candidates = mf.matchable.reduce((a, b) => a + b, 0);
    expect(total / n / candidates).toBeLessThan(0.35);
  });
});
