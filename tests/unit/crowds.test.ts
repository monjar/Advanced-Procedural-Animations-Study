import { describe, expect, it } from 'vitest';
import { linearProgram2, linearProgram3, makeObstacle, nearbyObstacles, orcaVelocity, type Line } from '../../demos/19-character-crowds/orca';
import { Crowd } from '../../demos/19-character-crowds/crowd';
import { SCENARIOS, runScenario } from '../../demos/19-character-crowds/scenarios';

const scenario = (name: string) => SCENARIOS.find((s) => s.name.startsWith(name))!;
const lastArrival = (c: Crowd) => Math.max(...c.agents.map((a) => a.arrivedAt));
const P = { timeHorizon: 2, timeHorizonObst: 1, maxSpeed: 2 };

describe('linear programs', () => {
  it('projects the preferred velocity onto a violated half-plane', () => {
    // Allowed: y ≥ 0.5 (left of a line through (0, 0.5) pointing +x).
    const lines: Line[] = [{ point: { x: 0, y: 0.5 }, direction: { x: 1, y: 0 } }];
    const r = { x: 0, y: 0 };
    expect(linearProgram2(lines, 2, { x: 1, y: 0 }, false, r)).toBe(1);
    expect(r.x).toBeCloseTo(1, 9);
    expect(r.y).toBeCloseTo(0.5, 9);
  });

  it('when the half-planes exclude each other, minimises the largest violation', () => {
    // y ≥ 0.5 and y ≤ −0.5 cannot both hold: the best compromise is y = 0, violating each by 0.5.
    const lines: Line[] = [
      { point: { x: 0, y: 0.5 }, direction: { x: 1, y: 0 } },
      { point: { x: 0, y: -0.5 }, direction: { x: -1, y: 0 } },
    ];
    const r = { x: 0, y: 0 };
    const fail = linearProgram2(lines, 2, { x: 1, y: 0 }, false, r);
    expect(fail).toBe(1);
    linearProgram3(lines, 0, fail, 2, r);
    expect(r.y).toBeCloseTo(0, 6);
  });
});

describe('ORCA', () => {
  it('is reciprocal: two agents in mirror-image states choose mirror-image velocities', () => {
    const a = { position: { x: -2, y: 0.05 }, velocity: { x: 1.2, y: 0 }, radius: 0.25 };
    const b = { position: { x: 2, y: -0.05 }, velocity: { x: -1.2, y: 0 }, radius: 0.25 };
    const va = orcaVelocity(a, { x: 1.3, y: 0 }, [b], [], P, 1 / 60);
    const vb = orcaVelocity(b, { x: -1.3, y: 0 }, [a], [], P, 1 / 60);
    expect(va.x).toBeCloseTo(-vb.x, 9);
    expect(va.y).toBeCloseTo(-vb.y, 9);
    // Each dodges sideways (half the avoidance each), away from the other.
    expect(va.y).toBeGreaterThan(0.05);
  });

  it('an agent walking straight at a wall stops at it; one walking past it is not slowed', () => {
    const wall = makeObstacle([
      { x: 1, y: -2 },
      { x: 1.3, y: -2 },
      { x: 1.3, y: 2 },
      { x: 1, y: 2 },
    ]);
    const agent = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, radius: 0.25 };
    for (let i = 0; i < 300; i++) {
      agent.velocity = orcaVelocity(agent, { x: 1.3, y: 0 }, [], nearbyObstacles(wall, agent.position, 2.5), P, 1 / 60);
      agent.position.x += agent.velocity.x / 60;
    }
    expect(agent.position.x).toBeLessThanOrEqual(1 - 0.25 + 1e-6);
    expect(agent.position.x).toBeGreaterThan(0.7);
    const past = orcaVelocity({ position: { x: 0, y: 3 }, velocity: { x: 1.3, y: 0 }, radius: 0.25 }, { x: 1.3, y: 0 }, [], [], P, 1 / 60);
    expect(past.x).toBeCloseTo(1.3, 9);
  });
});

describe('scenarios', () => {
  it('circle swap: ORCA gets all 48 across without collisions, faster and straighter than social forces', () => {
    const orca = runScenario(scenario('circle'), { model: 'orca' });
    const social = runScenario(scenario('circle'), { model: 'social' });
    expect(orca.metrics.arrived).toBe(48);
    expect(orca.metrics.maxPenetration).toBeLessThan(0.02); // discrete steps: ORCA is exact only in continuous time
    expect(orca.metrics.overlapSeconds).toBeLessThan(0.1);
    expect(social.metrics.arrived).toBe(48);
    expect(lastArrival(orca)).toBeLessThan(lastArrival(social));
    expect(orca.metrics.turning).toBeLessThan(0.6 * social.metrics.turning);
  });

  it('doorway and corridor: everyone gets through, nobody enters a wall, with either model', () => {
    for (const name of ['doorway', 'corridor']) {
      for (const model of ['orca', 'social'] as const) {
        const c = runScenario(scenario(name), { model });
        expect(c.metrics.arrived, `${name} ${model}`).toBe(c.agents.length);
        expect(c.metrics.maxWallPenetration, `${name} ${model}`).toBeLessThan(0.005);
      }
    }
  }, 30000);

  it('hurrying through a door: social forces push through faster, at the price of overlap; ORCA stays polite', () => {
    const run = (model: 'orca' | 'social', hurry: number) => runScenario(scenario('doorway'), { model }, 1.5, 7, 1 / 60, hurry);
    const orca = run('orca', 1);
    const social = run('social', 3);
    expect(orca.metrics.overlapSeconds).toBeLessThan(0.5);
    expect(social.metrics.overlapSeconds).toBeGreaterThan(20);
    expect(social.metrics.maxPenetration).toBeGreaterThan(0.05);
    expect(lastArrival(social)).toBeLessThan(lastArrival(orca));
  }, 30000);

  it('is deterministic for a seed', () => {
    const a = runScenario(scenario('crossing'), { model: 'orca' }, 0.5, 3);
    const b = runScenario(scenario('crossing'), { model: 'orca' }, 0.5, 3);
    expect(a.agents.map((x) => x.position)).toEqual(b.agents.map((x) => x.position));
  });
});
