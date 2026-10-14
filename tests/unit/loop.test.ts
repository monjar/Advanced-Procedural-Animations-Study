import { afterEach, describe, expect, it } from 'vitest';
import { FixedStepLoop, type StepMode } from '../../src/core/loop';

type G = { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
const g = globalThis as G;
afterEach(() => {
  delete g.requestAnimationFrame;
  delete g.cancelAnimationFrame;
});

/** Per-frame displacement of a 7 m/s object drawn by the loop, for a display at `hz` with vsync noise. */
function perFrameMotion(mode: StepMode, hz: number, simRate = 60): number[] {
  let cb: FrameRequestCallback | null = null;
  g.requestAnimationFrame = (f: FrameRequestCallback) => ((cb = f), 1);
  g.cancelAnimationFrame = () => {};
  let x = 0;
  const seen: number[] = [];
  const loop = new FixedStepLoop({ fixedUpdate: (dt) => (x += 7 * dt), frame: () => seen.push(x) }, simRate);
  loop.mode = mode;
  loop.start();
  let t = 0;
  for (let i = 0; i < 240; i++) {
    t += 1000 / hz + Math.sin(i * 12.9898) * 0.5;
    cb!(t);
  }
  return seen.slice(20).map((v, i, a) => (i ? v - a[i - 1] : 0)).slice(1);
}

describe('FixedStepLoop', () => {
  it.each([60, 120, 144])('synced mode moves evenly every frame on a %s Hz display', (hz) => {
    const dx = perFrameMotion('synced', hz);
    const ideal = 7 / hz;
    for (const d of dx) expect(Math.abs(d - ideal) / ideal).toBeLessThan(0.1);
  });

  it('fixed mode judders when display and simulation rates differ (the bug synced mode fixes)', () => {
    const dx = perFrameMotion('fixed', 120);
    expect(Math.min(...dx)).toBe(0);
    expect(Math.max(...dx)).toBeCloseTo(7 / 60, 9);
  });

  it('synced mode never takes a step longer than dt', () => {
    let cb: FrameRequestCallback | null = null;
    g.requestAnimationFrame = (f: FrameRequestCallback) => ((cb = f), 1);
    g.cancelAnimationFrame = () => {};
    const steps: number[] = [];
    const loop = new FixedStepLoop({ fixedUpdate: (dt) => steps.push(dt) }, 60);
    loop.start();
    cb!(0);
    cb!(50); // a long 50 ms frame
    expect(steps.length).toBe(3);
    for (const s of steps) expect(s).toBeLessThanOrEqual(1 / 60 + 1e-12);
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(0.05, 12);
  });
});
