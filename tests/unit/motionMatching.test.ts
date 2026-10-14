import { describe, expect, it } from 'vitest';
import { FORWARD, IDLE, LEFT, RUN, runScript, type Run } from '../support/mmAudit';

const SCRIPT = [
  { duration: 1, input: IDLE },
  { duration: 5, input: FORWARD },
  { duration: 3, input: LEFT },
  { duration: 4, input: IDLE },
  { duration: 4, input: RUN },
  { duration: 3, input: IDLE },
];

const seg = (r: Run, i: number) => r.samples.filter((s) => s.segment === i);
const meanSpeed = (s: { speed: number }[]) => s.reduce((a, x) => a + x.speed, 0) / s.length;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

describe('motion matching runtime on scripted input', () => {
  const runs = new Map([25, 60, 144].map((fps) => [fps, runScript(SCRIPT, fps)]));
  const r = runs.get(60)!;

  it('walks and runs at the requested speeds', () => {
    expect(Math.abs(meanSpeed(seg(r, 1).slice(-180)) - 1.3)).toBeLessThan(0.25);
    expect(meanSpeed(seg(r, 4).slice(-120))).toBeGreaterThan(2.6);
  });

  it('turns 90° to within 15° in under a second', () => {
    const turn = seg(r, 2);
    const hit = turn.find((s) => Math.abs(s.yaw - Math.PI / 2) < (15 * Math.PI) / 180);
    expect(hit).toBeDefined();
    expect(hit!.t - turn[0].t).toBeLessThan(1);
    // ... and keeps that heading.
    for (const s of turn.slice(-60)) expect(Math.abs(s.yaw - Math.PI / 2)).toBeLessThan((15 * Math.PI) / 180);
  });

  it('stops within 1.2 s and then stands (drift < 15 cm over the rest of the hold)', () => {
    for (const i of [3, 5]) {
      const stop = seg(r, i);
      const still = stop.find((s) => s.speed < 0.15);
      expect(still).toBeDefined();
      expect(still!.t - stop[0].t).toBeLessThan(1.2);
      const a = stop[Math.round(1.5 * 60)];
      const b = stop[stop.length - 1];
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(0.15);
    }
  });

  it('keeps the simulated trajectory within 15 cm of the character, switching clips 1–6 times a second', () => {
    expect(Math.max(...r.samples.map((s) => s.simDistance))).toBeLessThanOrEqual(0.1501);
    const rate = r.matcher.transitions / r.matcher.time;
    expect(rate).toBeGreaterThan(1);
    expect(rate).toBeLessThan(6);
  });

  it('inertialized transitions are no rougher than the data itself; hard cuts are', () => {
    const steady = pct(r.steadyJumps, 0.99);
    expect(r.transitionJumps.length).toBeGreaterThan(30);
    expect(pct(r.transitionJumps, 0.99)).toBeLessThanOrEqual(steady);
    const cut = runScript(SCRIPT, 60, { inertialize: false });
    expect(pct(cut.transitionJumps, 0.99)).toBeGreaterThan(2 * steady);
    expect(pct(cut.transitionJumps, 0.5)).toBeGreaterThan(3 * pct(r.transitionJumps, 0.5));
  });

  it('behaves the same at 25, 60 and 144 fps (fixed 60 Hz internal step)', () => {
    const end = (x: Run) => x.samples[x.samples.length - 1];
    for (const fps of [25, 144]) {
      const o = runs.get(fps)!;
      expect(Math.hypot(end(o).x - end(r).x, end(o).z - end(r).z)).toBeLessThan(0.05);
      expect(o.matcher.transitions).toBe(r.matcher.transitions);
    }
  });
});

describe('foot locking', () => {
  it('cuts planted-ankle drift to a fraction of the unlocked matcher, within reach', () => {
    const free = runScript(SCRIPT, 60, {}, false);
    const locked = runScript(SCRIPT, 60, {}, true);
    expect(free.skate).toBeGreaterThan(0.1);
    expect(locked.skate).toBeLessThan(0.04);
    expect(locked.skate).toBeLessThan(0.35 * free.skate);
    expect(locked.lockError).toBeLessThan(0.07);
  });
});
