import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import loadMujoco, { type MainModule } from '@mujoco/mujoco';
import { GAITS, Simbicon } from '../../demos/17-simbicon/simbicon';

const xml = readFileSync('demos/17-simbicon/biped.xml', 'utf8');
let mj: MainModule;
beforeAll(async () => {
  mj = await loadMujoco();
});

/** Walk for `seconds`; returns whether it fell, and mean forward / sideways speed over the second half. */
function walk(gait: string, seconds: number, each?: (c: Simbicon, t: number) => void) {
  const c = new Simbicon(mj, xml);
  c.gait = { ...GAITS[gait] };
  c.reset();
  let fwd = 0;
  let lat = 0;
  let fell = -1;
  const n = Math.round(seconds / c.dt);
  for (let i = 0; i < n; i++) {
    const t = i * c.dt;
    each?.(c, t);
    c.step();
    if (t > seconds / 2) {
      const h = c.state.heading;
      const v = c.data.qvel as Float64Array;
      fwd += ((Math.cos(h) * v[0] + Math.sin(h) * v[1]) * c.dt) / (seconds / 2);
      lat += ((-Math.sin(h) * v[0] + Math.cos(h) * v[1]) * c.dt) / (seconds / 2);
    }
    if (c.fallen) {
      fell = t;
      break;
    }
  }
  const result = { fell, fwd, lat, heading: c.state.heading, steps: c.state.steps };
  c.dispose();
  return result;
}

describe('SIMBICON walker (MuJoCo, torque control only)', () => {
  it.each([
    ['stroll', 0.3, 0.5],
    ['walk', 0.75, 1.05],
  ])('%s: walks straight for 20 s at its speed', (gait, lo, hi) => {
    const r = walk(gait, 20);
    expect(r.fell).toBe(-1);
    expect(r.fwd).toBeGreaterThan(lo);
    expect(r.fwd).toBeLessThan(hi);
    expect(Math.abs(r.lat)).toBeLessThan(0.1);
    expect(Math.abs(r.heading)).toBeLessThan(0.25);
  }, 60000);

  it('the balance is the feedback: without c_d / c_v it falls', () => {
    const c = new Simbicon(mj, xml);
    c.gait = { ...GAITS.walk, cd: 0, cv: 0, cdLat: 0, cvLat: 0 };
    c.reset();
    let fell = false;
    for (let i = 0; i < 10 / c.dt && !fell; i++) {
      c.step();
      fell = c.fallen;
    }
    c.dispose();
    expect(fell).toBe(true);
  }, 60000);

  it.each(['stroll', 'walk'])('%s: steers through 90° turns and a reversal without falling', (gait) => {
    const errors: number[] = [];
    const r = walk(gait, 30, (c, t) => {
      c.targetHeading = t < 8 ? 0 : t < 16 ? Math.PI / 2 : t < 24 ? -Math.PI / 2 : 0;
      // Heading error once each turn has had time to finish.
      if ([7.9, 15.9, 23.9, 29.9].some((x) => Math.abs(t - x) < c.dt / 2)) {
        const e = c.targetHeading - c.state.heading;
        errors.push(Math.abs(Math.atan2(Math.sin(e), Math.cos(e))));
      }
    });
    expect(r.fell).toBe(-1);
    // The walk turns at 0.2 rad/s, so its reversal is still finishing at 24 s; check the settled ones. The
    // heading wobbles step to step (±15–25° for the walk), hence the loose bound.
    expect(errors[0]).toBeLessThan(0.5);
    expect(errors[1]).toBeLessThan(0.5);
    expect(errors[3]).toBeLessThan(0.5);
  }, 60000);

  // Measured envelope: every shove up to these sizes is survived, from both sides and at three points in the
  // gait cycle (36 N·s for 0.5 m/s on the 71 kg character). Beyond it, some timings fall.
  it.each([
    ['stroll', 'side', 0.5],
    ['stroll', 'front/back', 0.6],
    ['walk', 'side', 0.5],
    ['walk', 'front/back', 0.2],
  ])('%s: recovers from %s shoves up to %s m/s', (gait, dir, speed) => {
    for (const side of [1, -1]) {
      for (const at of [6, 6.1, 6.2]) {
        const r = walk(gait as string, 12, (c, t) => {
          if (Math.abs(t - at) < c.dt / 2) {
            const h = c.state.heading + (dir === 'side' ? (side * Math.PI) / 2 : side > 0 ? 0 : Math.PI);
            c.push(Math.cos(h) * (speed as number), Math.sin(h) * (speed as number));
          }
        });
        expect(r.fell, `${side > 0 ? 'left/back' : 'right/front'} at ${at} s`).toBe(-1);
      }
    }
  }, 60000);
});
