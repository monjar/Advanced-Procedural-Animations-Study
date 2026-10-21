import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import loadMujoco, { type MainModule } from '@mujoco/mujoco';
import { Mlp } from '../../demos/13-rl-locomotion/policy';
import { MimicSim, NUM_ACT, NUM_OBS, Reference, type ClipFile, type MimicPolicyFile } from '../../demos/21-physics-mocap/mimic';

const root = resolve(__dirname, '../..');
const asset = (f: string) => resolve(root, 'public/assets/mimic', f);
const xml = readFileSync(asset('humanoid.xml'), 'utf8');
const clips = JSON.parse(readFileSync(asset('clips.json'), 'utf8')) as ClipFile;
const trained = Object.keys(clips.clips).filter((c) => existsSync(asset(`policy-${c}.json`)));

let mj: MainModule;
beforeAll(async () => {
  mj = await loadMujoco();
});

describe.each(trained)('physics-based tracking of the %s clip', (clip) => {
  const policy = JSON.parse(readFileSync(asset(`policy-${clip}.json`), 'utf8')) as MimicPolicyFile;
  const fixture = JSON.parse(readFileSync(resolve(root, `tests/fixtures/mimic-${clip}-parity.json`), 'utf8')) as { t0: number; frames: { obs: number[]; action: number[] }[]; finalQpos: number[] };
  const ref = new Reference(clips.clips[clip], clips.fps);
  const normalise = (o: ArrayLike<number>, out = new Float64Array(NUM_OBS)) => {
    for (let i = 0; i < NUM_OBS; i++) out[i] = Math.min(5, Math.max(-5, (o[i] - policy.obsMean[i]) / policy.obsStd[i]));
    return out;
  };

  it('the TypeScript MLP reproduces PyTorch on recorded observations', () => {
    const mlp = new Mlp(policy as never);
    let worst = 0;
    for (const f of fixture.frames) {
      const a = mlp.act(normalise(f.obs));
      for (let i = 0; i < NUM_ACT; i++) worst = Math.max(worst, Math.abs(a[i] - f.action[i]));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('MuJoCo WASM with the TypeScript reference and observation reproduces the Python run', () => {
    const sim = new MimicSim(mj, xml, ref, policy);
    sim.reset(fixture.t0);
    let worst = 0;
    const obs = new Float64Array(NUM_OBS);
    for (const f of fixture.frames) {
      sim.observe(obs);
      for (let i = 0; i < NUM_OBS; i++) worst = Math.max(worst, Math.abs(obs[i] - f.obs[i]));
      sim.applyAction(f.action);
    }
    let qposErr = 0;
    for (let i = 0; i < fixture.finalQpos.length; i++) qposErr = Math.max(qposErr, Math.abs(sim.data.qpos[i] - fixture.finalQpos[i]));
    sim.dispose();
    expect(worst).toBeLessThan(1e-4);
    expect(qposErr).toBeLessThan(1e-4);
  });

  it('walks the clip for 20 s without falling, at the clip speed, tracking the pose; without the policy it falls', () => {
    const run = (usePolicy: boolean, seconds: number) => {
      const sim = new MimicSim(mj, xml, ref, policy);
      const mlp = new Mlp(policy as never);
      sim.reset(0);
      const obs = new Float64Array(NUM_OBS);
      let err = 0;
      let n = 0;
      let fellAt = -1;
      const steps = Math.round(seconds / (policy.decimation * policy.dt));
      for (let k = 0; k < steps; k++) {
        sim.observe(obs);
        sim.applyAction(usePolicy ? mlp.act(normalise(obs)) : new Float64Array(NUM_ACT));
        if (sim.fallen && fellAt < 0) fellAt = sim.t;
        const r = sim.refAt(sim.t);
        let e = 0;
        for (let i = 7; i < 35; i++) e += (sim.data.qpos[i] - r[i]) ** 2;
        err += Math.sqrt(e / 28);
        n++;
      }
      const dist = Math.hypot(sim.data.qpos[0], sim.data.qpos[1]);
      sim.dispose();
      return { fellAt, dist, rmsDeg: ((err / n) * 180) / Math.PI };
    };
    const learned = run(true, 20);
    const clipSpeed = Math.hypot(clips.clips[clip].cycle.dx, clips.clips[clip].cycle.dy) / ref.period;
    expect(learned.fellAt).toBe(-1);
    expect(learned.dist / 20).toBeGreaterThan(0.8 * clipSpeed);
    expect(learned.dist / 20).toBeLessThan(1.2 * clipSpeed);
    expect(learned.rmsDeg).toBeLessThan(12);
    const plain = run(false, 6);
    expect(plain.fellAt).toBeGreaterThan(0);
    console.log(`${clip}: ${(learned.dist / 20).toFixed(2)} m/s (clip ${clipSpeed.toFixed(2)}), pose RMS ${learned.rmsDeg.toFixed(1)}°; plain tracking falls at ${plain.fellAt.toFixed(2)} s`);
  }, 120000);
});
