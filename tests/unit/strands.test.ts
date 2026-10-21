import { describe, expect, it } from 'vitest';
import { Rods } from '../../demos/22-strands/rod';

/** A clamped horizontal cantilever under gravity; returns the tip drop and the discrete-chain prediction. */
function cantilever(alpha: number, substeps: number, iterations: number, n = 20, mass = 0.01) {
  const l = 1 / n;
  const r = new Rods(1, n, { bendCompliance: alpha, twistCompliance: alpha, stretchCompliance: 0, damping: 4, gravity: 9.81, mass });
  r.layOut(0, [0, 0, 0], [1, 0, 0], l);
  r.w[0] = r.w[1] = 0;
  r.wq[0] = 0;
  r.setInertia(0.25);
  r.iterations = iterations;
  for (let f = 0; f < 60 * 6; f++) for (let k = 0; k < substeps; k++) r.substep(1 / 60 / substeps);
  // Joint j (at node j) carries τ_j = Σ_{k>j} m g (k − j) l and turns by τ_j / k_b with k_b = 1/(4α), i.e. EI = l/(4α).
  let predicted = 0;
  for (let j = 1; j < n; j++) {
    let tau = 0;
    for (let k = j + 1; k <= n; k++) tau += mass * 9.81 * (k - j) * l;
    predicted += 4 * alpha * tau * (n - j) * l;
  }
  return { tip: -r.x[n * 3 + 1], predicted };
}

describe('Cosserat rods (XPBD)', () => {
  it('converged, a cantilever bends exactly as its compliance says: EI = l / (4α)', () => {
    const c = cantilever(0.003, 40, 16);
    expect(c.tip / c.predicted).toBeGreaterThan(0.98);
    expect(c.tip / c.predicted).toBeLessThan(1.02);
  }, 30000);

  it('with too few iterations a stiff rod sags more than it should (the cost of position-based solving)', () => {
    const c1 = cantilever(0.001, 40, 1);
    const c16 = cantilever(0.001, 40, 16);
    expect(c1.tip).toBeGreaterThan(1.5 * c16.tip);
    expect(Math.abs(c16.tip / c16.predicted - 1)).toBeLessThan(0.03);
  }, 30000);

  it('a helical rest Darboux vector relaxes a free rod into a helix of that curvature', () => {
    const n = 30;
    const l = 0.02;
    const kappa = 20;
    const r = new Rods(1, n, { bendCompliance: 1e-4, twistCompliance: 1e-4, stretchCompliance: 0, damping: 6, gravity: 0, mass: 0.01 });
    r.layOut(0, [0, 0, 0], [1, 0, 0], l);
    r.setInertia(0.25);
    r.iterations = 8;
    for (let s = 0; s < n; s++) {
      r.rest[s * 3] = Math.sin((kappa * l) / 2);
      r.rest[s * 3 + 2] = Math.sin((0.3 * kappa * l) / 2);
    }
    for (let f = 0; f < 60 * 4; f++) for (let k = 0; k < 10; k++) r.substep(1 / 600);
    // Discrete curvature from three consecutive points, averaged over the middle.
    let sum = 0;
    let count = 0;
    for (let i = 5; i < n - 5; i++) {
      const p = (k: number) => [r.x[k * 3], r.x[k * 3 + 1], r.x[k * 3 + 2]];
      const [a, b, c] = [p(i - 1), p(i), p(i + 1)];
      const t1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const t2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
      const dot = (t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2]) / (Math.hypot(...t1) * Math.hypot(...t2));
      sum += Math.acos(Math.min(1, dot)) / l;
      count++;
    }
    const measured = sum / count;
    expect(measured / kappa).toBeGreaterThan(0.9);
    expect(measured / kappa).toBeLessThan(1.1);
  }, 30000);

  it('twisting one end spreads the twist evenly along a converged rod', () => {
    const n = 20;
    const r = new Rods(1, n, { bendCompliance: 0.004, twistCompliance: 0.004, stretchCompliance: 0, damping: 2, gravity: 0, mass: 0.01 });
    r.layOut(0, [0, 0, 0], [1, 0, 0], 1 / n);
    r.setInertia(0.25);
    r.iterations = 40;
    r.w[0] = r.w[1] = r.w[n - 1] = r.w[n] = 0;
    r.wq[0] = r.wq[n - 1] = 0;
    const base = Array.from(r.q.slice((n - 1) * 4, n * 4));
    const turns = 0.5;
    for (let f = 0; f < 60 * 6; f++)
      for (let k = 0; k < 20; k++) {
        r.twistSegment(n - 1, 2 * Math.PI * Math.min(turns, (f * 20 + k) / (60 * 20 * 3)) * 1, base);
        r.substep(1 / 1200);
      }
    const per: number[] = [];
    for (let s = 0; s < n - 1; s++) {
      const a = r.q.slice(s * 4, s * 4 + 4);
      const b = r.q.slice(s * 4 + 4, s * 4 + 8);
      const oz = a[3] * b[2] - a[0] * b[1] + a[1] * b[0] - a[2] * b[3];
      const ow = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      per.push(2 * Math.atan2(ow < 0 ? -oz : oz, Math.abs(ow)));
    }
    const total = per.reduce((x, y) => x + y, 0);
    expect(Math.abs(total) / (2 * Math.PI)).toBeCloseTo(turns, 2);
    const mean = total / per.length;
    for (const p of per) expect(Math.abs(p - mean)).toBeLessThan(0.1 * Math.abs(mean));
  }, 30000);

  it('a hair strand pointing up stands if it is shorter than its self-buckling length, and flops over if longer', () => {
    const stand = (standUp: number) => {
      const n = 14;
      const l = 0.024;
      const mass = 0.0004;
      const q = (mass / l) * 9.81;
      const EI = (q * standUp ** 3) / 7.84;
      const r = new Rods(1, n, { bendCompliance: l / (4 * EI), twistCompliance: l / (4 * EI), stretchCompliance: 0, damping: 2, gravity: 9.81, mass });
      r.layOut(0, [0, 0, 0], [0.02, 1, 0], l);
      r.w[0] = r.w[1] = 0;
      r.wq[0] = 0;
      r.setInertia(0.25);
      r.iterations = 8;
      for (let f = 0; f < 60 * 5; f++) for (let k = 0; k < 10; k++) r.substep(1 / 600);
      return r.x[n * 3 + 1];
    };
    const length = 14 * 0.024;
    expect(stand(2 * length)).toBeGreaterThan(0.8 * length); // stiff: still standing
    expect(stand(0.4 * length)).toBeLessThan(0.3 * length); // limp: fallen over
  }, 30000);
});
