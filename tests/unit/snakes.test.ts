import { describe, expect, it } from 'vitest';
import { Inchworm, Sidewinder, SNAKE_SKIN, Undulation, Worm, type Friction } from '../../demos/20-snakes/gaits';
import { Slither, type Gait } from '../../demos/20-snakes/slither';

/** Speed and direction over `seconds`, after a 2 s start-up. */
function run(g: Gait, seconds = 8) {
  const s = new Slither(g);
  const dt = 1 / 240;
  for (let i = 0; i < 2 / dt; i++) s.step(dt);
  const x0 = s.X;
  const y0 = s.Y;
  for (let i = 0; i < seconds / dt; i++) s.step(dt);
  const n = s.frame.n;
  const axis = Math.atan2(s.wy[n - 1] - s.wy[0], s.wx[n - 1] - s.wx[0]);
  const dir = Math.atan2(s.Y - y0, s.X - x0);
  return { speed: Math.hypot(s.X - x0, s.Y - y0) / seconds, forward: (s.X - x0) / seconds, dir, axis, sim: s };
}
const snake = (friction: Friction, lift = 0, amplitude = 0.8) => new Undulation({ amplitude, waves: 1.5, frequency: 1, lift, turn: 0, friction });

describe('shape-driven locomotion', () => {
  it('without friction the centre of mass never moves, though the body turns (shape change carries spin)', () => {
    const s = new Slither(snake({ muF: 0, muB: 0, muN: 0 }));
    for (let i = 0; i < 240 * 5; i++) s.step(1 / 240);
    expect(Math.hypot(s.X, s.Y)).toBeLessThan(1e-12);
    expect(Math.abs(s.theta)).toBeGreaterThan(0.5);
  });

  it('slithering needs friction stronger sideways than lengthwise; speed grows with the ratio', () => {
    const speeds = [1, 2, 5].map((r) => run(snake({ muF: 0.1, muB: 0.1, muN: 0.1 * r })).forward);
    expect(Math.abs(speeds[0])).toBeLessThan(0.05);
    expect(speeds[1]).toBeGreaterThan(0.05);
    expect(speeds[2]).toBeGreaterThan(3 * speeds[1]);
  });

  it('lifting the most curved parts makes a snake on real snake-skin friction faster (Hu et al.)', () => {
    const flat = run(snake(SNAKE_SKIN, 0)).forward;
    const lifted = run(snake(SNAKE_SKIN, 1)).forward;
    expect(flat).toBeGreaterThan(0.03);
    expect(lifted).toBeGreaterThan(2 * flat);
  });

  it('sidewinding works on any friction, moving roughly at right angles to the body; without lifting it does not', () => {
    for (const mu of [0.2, 0.8]) {
      const r = run(new Sidewinder({ amplitude: 0.9, waves: 1.2, frequency: 1, liftPhase: Math.PI / 2, lift: 1, friction: { muF: mu, muB: mu, muN: mu } }));
      expect(r.speed).toBeGreaterThan(0.35);
      const angle = Math.abs(Math.atan2(Math.sin(r.dir - r.axis), Math.cos(r.dir - r.axis)));
      expect(Math.abs(angle - Math.PI / 2)).toBeLessThan(0.3);
    }
    const flat = run(new Sidewinder({ amplitude: 0.9, waves: 1.2, frequency: 1, liftPhase: Math.PI / 2, lift: 0, friction: { muF: 0.5, muB: 0.5, muN: 0.5 } }));
    expect(flat.speed).toBeLessThan(0.1);
  });

  it('an earthworm only crawls when its bristles grip backward, and crawls forward whichever way the wave runs', () => {
    const worm = (muB: number, direction: number) => run(new Worm({ stretch: 0.3, waves: 1.5, frequency: 1, direction, turn: 0, friction: { muF: 0.1, muB, muN: 0.4 } }));
    expect(worm(0.1, 1).speed).toBeLessThan(0.001);
    for (const d of [1, -1]) {
      const r = worm(0.6, d);
      expect(r.forward).toBeGreaterThan(0.015);
    }
  });

  it('an inchworm advances by nearly its whole reach every cycle', () => {
    const g = new Inchworm({ frequency: 1, reach: 0.4, grip: 2, slip: 0.05 });
    const r = run(g);
    const ideal = 0.4 * g.length;
    expect(r.forward).toBeGreaterThan(0.85 * ideal);
    expect(r.forward).toBeLessThan(1.02 * ideal);
  });
});
