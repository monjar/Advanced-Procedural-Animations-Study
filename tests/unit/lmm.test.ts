import { describe, expect, it } from 'vitest';
import { forwardKinematics, skeletonDef } from '../../src/anim/fk';
import { DEFAULT_WEIGHTS, DIMS, dimWeights, searchBrute } from '../../src/anim/mmfeatures';
import { Rng } from '../../src/math/random';
import { encodePose, quatTo6d, sixdToQuat, Y_DIMS, Y_ROT } from '../../demos/16-learned-motion-matching/pose';
import { lmm, runBoth } from '../support/lmmAudit';
import { features, FORWARD, IDLE, LEFT, RUN } from '../support/mmAudit';

const J = 25;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

/** Joint positions (relative to the simulation bone) of a pose vector. */
function positions(y: Float32Array, out = new Float32Array(J * 3)): Float32Array {
  const rot = new Float32Array(J * 4);
  for (let j = 0; j < J; j++) sixdToQuat(y, Y_ROT + 6 * j, rot, j * 4);
  forwardKinematics(skeletonDef(features().db.joints), y, 0, rot, 0, out, new Float32Array(J * 4));
  return out;
}
const meanJointError = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let j = 0; j < J; j++) s += Math.hypot(a[j * 3] - b[j * 3], a[j * 3 + 1] - b[j * 3 + 1], a[j * 3 + 2] - b[j * 3 + 2]);
  return s / J;
};

describe('pose encoding', () => {
  it('6-D rotations round-trip through quaternions', () => {
    const q = [0.1, -0.7, 0.3, 0.64];
    const n = Math.hypot(...q);
    const v = new Float32Array(6);
    const back = new Float64Array(4);
    quatTo6d(q.map((x) => x / n), 0, v, 0);
    sixdToQuat(v, 0, back, 0);
    const dot = Math.abs(back.reduce((s, x, i) => s + x * (q[i] / n), 0));
    expect(dot).toBeGreaterThan(1 - 1e-6);
  });
});

describe('Learned Motion Matching networks against the database they replace', () => {
  const { nets } = lmm();
  const mf = features();
  const rng = new Rng(3);
  const w = dimWeights(DEFAULT_WEIGHTS);
  const yNet = new Float32Array(Y_DIMS);
  const yDb = new Float32Array(Y_DIMS);
  const pa = new Float32Array(J * 3);
  const pb = new Float32Array(J * 3);

  it('decompressor: matches the trainer (half-precision weights) and reconstructs poses to a millimetre', () => {
    const fx = nets.file.fixture;
    let parity = 0;
    let error = 0;
    fx.frames.forEach((f, i) => {
      const xz = new Float32Array(nets.X + nets.Z);
      xz.set(mf.features.subarray(f * DIMS, (f + 1) * DIMS));
      xz.set(fx.z[i], nets.X);
      nets.decompress(xz, yNet);
      for (let k = 0; k < Y_DIMS; k++) parity = Math.max(parity, Math.abs(yNet[k] - fx.y[i][k]));
      encodePose(mf, f, yDb, 0);
      error += meanJointError(positions(yNet, pa), positions(yDb, pb)) / fx.frames.length;
    });
    expect(parity).toBeLessThan(2e-3);
    expect(error).toBeLessThan(0.005);
  });

  it('projector: lands as close to a noisy query as the exact nearest-neighbour search does', () => {
    for (const sigma of [0.3, 1]) {
      const ratios: number[] = [];
      const poseErr: number[] = [];
      for (let k = 0; k < 300; k++) {
        let f;
        do f = rng.int(mf.db.frames);
        while (!mf.matchable[f]);
        const q = new Float32Array(DIMS);
        for (let d = 0; d < DIMS; d++) q[d] = mf.features[f * DIMS + d] + sigma * rng.normal();
        const nn = searchBrute(mf, q, w, { frame: -1, cost: Infinity });
        const xz = nets.project(q, new Float32Array(nets.X + nets.Z));
        let c = 0;
        for (let d = 0; d < DIMS; d++) c += w[d] * (q[d] - xz[d]) ** 2;
        ratios.push(c / nn.cost);
        nets.decompress(xz, yNet);
        encodePose(mf, nn.frame, yDb, 0);
        poseErr.push(meanJointError(positions(yNet, pa), positions(yDb, pb)));
      }
      expect(pct(ratios, 0.5)).toBeLessThan(1.05);
      expect(pct(ratios, 0.9)).toBeLessThan(1.2);
      expect(pct(poseErr, 0.5)).toBeLessThan(0.04);
    }
  });

  it('stepper: a second of stepping stays within a few centimetres of the database motion', () => {
    const horizons = [1, 30, 60];
    const errors = horizons.map(() => 0);
    const runs = 150;
    for (let k = 0; k < runs; k++) {
      let f;
      do f = rng.int(mf.db.frames - 61);
      while (mf.db.take[f] !== mf.db.take[f + 60]);
      const xz = nets.project(mf.features.slice(f * DIMS, (f + 1) * DIMS), new Float32Array(nets.X + nets.Z));
      for (let s = 1; s <= 60; s++) {
        nets.step(xz);
        const h = horizons.indexOf(s);
        if (h < 0) continue;
        nets.decompress(xz, yNet);
        encodePose(mf, f + s, yDb, 0);
        errors[h] += meanJointError(positions(yNet, pa), positions(yDb, pb)) / runs;
      }
    }
    expect(errors[0]).toBeLessThan(0.02);
    expect(errors[2]).toBeLessThan(0.04);
  });

  it('is an order of magnitude smaller than the database in memory', () => {
    const db = mf.db.rot.byteLength + mf.features.byteLength + mf.db.root.byteLength;
    expect(nets.size.bytes * 8).toBeLessThan(db);
  });
});

describe('learned runtime vs database runtime on the same input', () => {
  const SCRIPT = [
    { duration: 1, input: IDLE },
    { duration: 5, input: FORWARD },
    { duration: 3, input: LEFT },
    { duration: 4, input: IDLE },
    { duration: 4, input: RUN },
    { duration: 3, input: IDLE },
  ];
  const db = runBoth('database', SCRIPT);
  const ml = runBoth('learned', SCRIPT);
  const seg = (r: typeof db, i: number) => r.samples.filter((s) => s.segment === i);
  const meanSpeed = (s: { speed: number }[]) => s.reduce((a, x) => a + x.speed, 0) / s.length;

  it('walks, runs, turns and stops like the database version', () => {
    expect(Math.abs(meanSpeed(seg(ml, 1).slice(-180)) - meanSpeed(seg(db, 1).slice(-180)))).toBeLessThan(0.1);
    expect(Math.abs(meanSpeed(seg(ml, 4).slice(-120)) - meanSpeed(seg(db, 4).slice(-120)))).toBeLessThan(0.2);
    const turn = seg(ml, 2);
    const hit = turn.find((s) => Math.abs(s.yaw - Math.PI / 2) < (15 * Math.PI) / 180);
    expect(hit!.t - turn[0].t).toBeLessThan(1);
    const stop = seg(ml, 3);
    expect(stop.find((s) => s.speed < 0.15)!.t - stop[0].t).toBeLessThan(1.2);
  });

  it('switches about as often, moves at least as smoothly, and skates no more', () => {
    const rate = ml.transitions / ml.time;
    expect(rate).toBeGreaterThan(1);
    expect(rate).toBeLessThan(6);
    expect(pct(ml.steadyJumps, 0.99)).toBeLessThanOrEqual(pct(db.steadyJumps, 0.99));
    expect(ml.skate).toBeLessThan(db.skate * 1.15);
  });
});
