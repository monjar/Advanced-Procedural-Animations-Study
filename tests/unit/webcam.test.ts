import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseMotionDB } from '../../src/anim/mmdb';
import { COUNT, LM, record, USED, type Recording } from '../../demos/28-webcam-puppet/landmarks';
import { ADULT, Ema, Locomotion, measure, OneEuro, retarget } from '../../demos/28-webcam-puppet/puppet';

const buf = readFileSync('public/assets/mocap/cmu16-mm.bin');
const db = parseMotionDB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, false);
const DT = 1 / 30;
const STAND = ['16_02', '16_06', '16_09', '16_10', '16_02', '16_06', '16_09', '16_10'];

type Filter = { filter(v: ArrayLike<number>, dt: number, out: Float64Array): Float64Array } | null;
/** RMS error (m) against the truth and RMS second difference (m/frame²) of a filter's output. */
function score(rec: Recording, f: Filter): { err: number; jitter: number } {
  const out = new Float64Array(COUNT * 3);
  const h: Float64Array[] = [];
  let err = 0;
  let jit = 0;
  let n = 0;
  rec.noisy.forEach((v, k) => {
    const y = f ? f.filter(v, DT, out).slice() : Float64Array.from(v);
    h.push(y);
    for (const lm of USED)
      for (let c = 0; c < 3; c++) {
        const i = lm * 3 + c;
        err += (y[i] - rec.truth[k][i]) ** 2;
        if (k >= 2) jit += (y[i] - 2 * h[k - 1][i] + h[k - 2][i]) ** 2;
        n++;
      }
  });
  return { err: Math.sqrt(err / n), jitter: Math.sqrt(jit / n) };
}

/** Where the puppet ends up after a recording, against where the person did. */
function walk(rec: Recording, setup: (l: Locomotion) => void = () => {}, still = false): number {
  const own = measure(rec.noisy);
  const loco = new Locomotion();
  setup(loco);
  const f = new OneEuro(COUNT * 3);
  const out = new Float64Array(COUNT * 3);
  for (const v of rec.noisy) loco.update(retarget(f.filter(v, DT, out), own), DT);
  const n = rec.frames - 1;
  const tx = still ? 0 : rec.rootPath[n][0] - rec.rootPath[0][0];
  const tz = still ? 0 : rec.rootPath[n][1] - rec.rootPath[0][1];
  return Math.hypot(loco.root[0] - tx, loco.root[2] - tz);
}

describe('webcam puppet', () => {
  const walking = record(db, ['16_15']);
  const standing = record(db, STAND);

  it('One Euro: as accurate as a fast moving average while walking, much steadier standing', () => {
    const raw = score(walking, null);
    const oe = score(walking, new OneEuro(COUNT * 3));
    const ema = score(walking, new Ema(COUNT * 3, 0.5));
    expect(oe.err).toBeLessThan(raw.err);
    expect(oe.err).toBeLessThanOrEqual(ema.err);
    expect(oe.jitter).toBeLessThan(raw.jitter / 2.5);
    const oeStill = score(standing, new OneEuro(COUNT * 3));
    const emaStill = score(standing, new Ema(COUNT * 3, 0.5));
    expect(oeStill.jitter).toBeLessThan(0.75 * emaStill.jitter);
  });

  it('retargeting keeps the character’s bone lengths, whoever is tracked', () => {
    const child = { ...ADULT, thigh: 0.26, shin: 0.27, upperArm: 0.18 };
    for (const lm of walking.noisy.slice(0, 20)) {
      const p = retarget(lm, child);
      const len = (a: number, b: number) => Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1], p[a][2] - p[b][2]);
      expect(len(1, 2)).toBeCloseTo(0.26, 6);
      expect(len(6, 7)).toBeCloseTo(0.27, 6);
      expect(len(12, 13)).toBeCloseTo(0.18, 6);
    }
  });

  it('measures the person’s proportions through the tracker noise', () => {
    const truth = measure(walking.truth);
    const est = measure(walking.noisy);
    expect(Math.abs(est.thigh - truth.thigh)).toBeLessThan(0.03);
    expect(Math.abs(est.shin - truth.shin)).toBeLessThan(0.03);
    expect(Math.abs(est.upperArm - truth.upperArm)).toBeLessThan(0.03);
  });

  it('walks the puppet as far as the person walked, from the feet alone', () => {
    for (const id of ['16_15', '16_32', '16_34']) expect(walk(record(db, [id]))).toBeLessThan(0.4);
  });

  it('a person standing still stays put — the stride gate is what makes it so', () => {
    expect(walk(standing, undefined, true)).toBeLessThan(0.3);
    expect(walk(standing, (l) => (l.strideMin = [-2, -1]), true)).toBeGreaterThan(1);
  });

  it('landmark indices follow MediaPipe’s layout', () => {
    expect([LM.nose, LM.leftShoulder, LM.leftHip, LM.rightFootIndex]).toEqual([0, 11, 23, 32]);
  });
});
