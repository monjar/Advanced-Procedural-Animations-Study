import { describe, expect, it } from 'vitest';
import { bitonicPassCpu, bitonicPasses } from '../../src/gpu/bitonic';
import { buildGrid, DEFAULT_BOIDS, gridFor, gridNeighbours, localOrder, randomBoids, stepBoids, type BoidState } from '../../src/gpu/boidsCpu';

describe('bitonic sort network', () => {
  it('sorts (key, index) pairs exactly in log₂n(log₂n+1)/2 passes', () => {
    let s = 3;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let log = 4; log <= 14; log++) {
      const n = 1 << log;
      const passes = bitonicPasses(n);
      expect(passes).toHaveLength((log * (log + 1)) / 2);
      let a = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) a.set([Math.floor(rnd() * n * 0.3), i], i * 2); // many equal keys
      const expected = Array.from({ length: n }, (_, i) => [a[i * 2], i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let b = new Float32Array(n * 2);
      for (const { j, k } of passes) {
        bitonicPassCpu(a, j, k, b);
        [a, b] = [b, a];
      }
      for (let i = 0; i < n; i++) {
        expect(a[i * 2]).toBe(expected[i][0]);
        expect(a[i * 2 + 1]).toBe(expected[i][1]);
      }
    }
  });
});

describe('boids reference (CPU)', () => {
  it('grid neighbour search equals brute force (no cap)', () => {
    const p = { ...DEFAULT_BOIDS, cap: 1e9 };
    const st = randomBoids(2000, p, 7);
    // Clump some boids so cells hold many.
    for (let i = 0; i < 400; i++) st.pos.set([1 + (i % 7) * 0.1, 8 + (i % 5) * 0.1, (i % 11) * 0.1], i * 4);
    const g = gridFor(p);
    const sg = buildGrid(st, g);
    for (let i = 0; i < st.n; i += 13) {
      const grid = gridNeighbours(st, g, sg, p, i).sort((a, b) => a - b);
      const brute: number[] = [];
      for (let j = 0; j < st.n; j++) {
        if (j === i) continue;
        const d = Math.hypot(st.pos[j * 4] - st.pos[i * 4], st.pos[j * 4 + 1] - st.pos[i * 4 + 1], st.pos[j * 4 + 2] - st.pos[i * 4 + 2]);
        if (d < p.radius) brute.push(j);
      }
      expect(grid).toEqual(brute);
    }
  });

  function simulate(alignment: number, seconds: number) {
    const p = { ...DEFAULT_BOIDS, wAlignment: alignment };
    let st: BoidState = randomBoids(1024, p, 11);
    const start = localOrder(st, p);
    let escaped = 0;
    for (let t = 0; t < seconds; t += 1 / 30) {
      st = stepBoids(st, p, 1 / 30);
      for (let i = 0; i < st.n; i++) {
        for (let k = 0; k < 3; k++) if (Math.abs(st.pos[i * 4 + k] - p.center[k]) > p.half[k] + p.radius) escaped++;
      }
    }
    return { p, st, start, end: localOrder(st, p), escaped };
  }

  it('neighbours align into schools with alignment on, not without; nobody leaves the tank', () => {
    const on = simulate(DEFAULT_BOIDS.wAlignment, 20);
    const off = simulate(0, 20);
    // Local order: random start ≈ 0.56; schools ≈ 0.97; no alignment ≈ 0.63.
    expect(on.start).toBeLessThan(0.6);
    expect(on.end).toBeGreaterThan(0.9);
    expect(off.end).toBeLessThan(0.7);
    expect(on.escaped).toBe(0);
    // Separation: 5th percentile nearest-neighbour distance stays above half the separation radius.
    const st = on.st;
    const nn: number[] = [];
    for (let i = 0; i < st.n; i += 4) {
      let best = Infinity;
      for (let j = 0; j < st.n; j++) {
        if (j === i) continue;
        best = Math.min(best, Math.hypot(st.pos[j * 4] - st.pos[i * 4], st.pos[j * 4 + 1] - st.pos[i * 4 + 1], st.pos[j * 4 + 2] - st.pos[i * 4 + 2]));
      }
      nn.push(best);
    }
    nn.sort((a, b) => a - b);
    expect(nn[Math.floor(nn.length * 0.05)]).toBeGreaterThan(0.5 * on.p.separation);
  }, 20000);
});
