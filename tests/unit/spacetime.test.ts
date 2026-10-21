import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { centreOfMass, DOF, FOOT, forwardDynamics, G, inverseDynamics, LINKS, linkPoses, TOTAL_MASS } from '../../demos/23-spacetime/luxo';
import { Jump, keyframed, type JumpSpec } from '../../demos/23-spacetime/spacetime';
import { CMAES } from '../../demos/23-spacetime/cmaes';

const stored = JSON.parse(readFileSync(resolve(__dirname, '../../public/assets/spacetime/jumps.json'), 'utf8')) as { name: string; spec: JumpSpec; p: number[] }[];
const load = (s: (typeof stored)[number]) => {
  const j = new Jump(s.spec);
  j.set(s.p);
  return j;
};

describe("the lamp's dynamics", () => {
  it('recursive inverse dynamics matches virtual work on numerically differentiated kinematics, and forward dynamics inverts it', () => {
    const q = [0.1, 0.2, 0.1, 0.5, -1.0, 0.8];
    const qd = [0.3, -0.2, 0.5, 1, -2, 0.7];
    const qdd = [1, 2, -3, 4, -1, 2];
    const P = new Float64Array(8);
    const A = new Float64Array(4);
    const at = (t: number, dq = -1, e = 0) => {
      const qq = q.map((v, i) => v + qd[i] * t + 0.5 * qdd[i] * t * t + (i === dq ? e : 0));
      linkPoses(qq, P, A);
      return [Array.from(P), Array.from(A)];
    };
    const h = 1e-4;
    const [p0, a0] = at(0);
    const [pp, ap] = at(h);
    const [pm, am] = at(-h);
    const ref = new Array(DOF).fill(0);
    for (let j = 0; j < DOF; j++) {
      const [P1, A1] = at(0, j, 1e-6);
      const [P2, A2] = at(0, j, -1e-6);
      for (let i = 0; i < 4; i++) {
        const ax = (pp[2 * i] - 2 * p0[2 * i] + pm[2 * i]) / (h * h);
        const ay = (pp[2 * i + 1] - 2 * p0[2 * i + 1] + pm[2 * i + 1]) / (h * h);
        const al = (ap[i] - 2 * a0[i] + am[i]) / (h * h);
        ref[j] += LINKS[i].mass * (ax * (P1[2 * i] - P2[2 * i]) + (ay + G) * (P1[2 * i + 1] - P2[2 * i + 1])) / 2e-6 + (LINKS[i].inertia * al * (A1[i] - A2[i])) / 2e-6;
      }
    }
    const Q = inverseDynamics(q, qd, qdd, new Float64Array(DOF));
    for (let j = 0; j < DOF; j++) expect(Q[j]).toBeCloseTo(ref[j], 3);
    const back = forwardDynamics(q, qd, Q, 0, new Float64Array(DOF));
    for (let j = 0; j < DOF; j++) expect(back[j]).toBeCloseTo(qdd[j], 8);
  });
});

describe.each(stored.map((s) => [s.name, s] as const))('optimised jump: %s', (_name, s) => {
  const j = load(s);

  it('lands on the mark, upright', () => {
    expect(j.terms.landingError).toBeLessThan(0.02);
    expect(Math.abs(j.terms.landingTilt)).toBeLessThan(0.01);
  });

  it('asks the ground only for what it can give: push, friction within μ, centre of pressure on the sole', () => {
    const c = j.contactCheck();
    expect(c.minFy).toBeGreaterThan(0);
    expect(c.maxFriction).toBeLessThan(s.spec.friction + 0.02);
    expect(c.maxCop).toBeLessThan(FOOT);
  });

  it('flies ballistically: the centre of mass falls at g in the air', () => {
    const com = (t: number) => centreOfMass(j.state(t));
    const h = 0.02;
    for (const t of [j.t1 + 0.05, (j.t1 + j.t2) / 2, j.t2 - 0.05]) {
      const ay = (com(t + h)[1] - 2 * com(t)[1] + com(t - h)[1]) / (h * h);
      const ax = (com(t + h)[0] - 2 * com(t)[0] + com(t - h)[0]) / (h * h);
      expect(ay).toBeCloseTo(-G, 1);
      expect(ax).toBeCloseTo(0, 1);
    }
  });

  it("the hand-keyed version of the same jump needs an outside force of more than twice the lamp's weight", () => {
    const k = keyframed(s.spec);
    let peak = 0;
    for (let t = j.t1 + 0.01; t < j.t2; t += 0.01) {
      const f = k.invisible(t);
      peak = Math.max(peak, Math.hypot(f[0], f[1]));
    }
    expect(peak / (TOTAL_MASS * G)).toBeGreaterThan(2);
  });
});

describe('the optimiser', () => {
  it("CMA-ES cuts the cost of the animator's guess fivefold in 150 generations", () => {
    const j = new Jump(stored[0].spec);
    const before = j.objective(j.p);
    const es = new CMAES(j.p, 0.25, 3, 24);
    for (let g = 0; g < 150; g++) es.step((x) => j.objective(x));
    expect(es.best.f).toBeLessThan(0.2 * before);
  }, 60000);
});
