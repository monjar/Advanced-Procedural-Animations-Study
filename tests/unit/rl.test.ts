import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import loadMujoco, { type MainModule } from '@mujoco/mujoco';
import { Mlp, type PolicyFile } from '../../demos/13-rl-locomotion/policy';
import { NUM_ACT, QuadrupedSim } from '../../demos/13-rl-locomotion/sim';

const root = resolve(__dirname, '../..');
const policy = JSON.parse(readFileSync(resolve(root, 'public/assets/rl/policy.json'), 'utf8')) as PolicyFile;
const xml = readFileSync(resolve(root, 'public/assets/rl/quadruped.xml'), 'utf8');
// Recorded by `training/train.py --export`: 100 control steps (2 s) of the policy in Python MuJoCo.
const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/rl-parity.json'), 'utf8')) as {
  qpos: number[];
  command: number[];
  frames: { obs: number[]; action: number[] }[];
  finalQpos: number[];
};

let mj: MainModule;
beforeAll(async () => {
  mj = await loadMujoco();
});

describe('RL policy in the browser runtime', () => {
  it('the TypeScript MLP reproduces PyTorch on recorded observations', () => {
    const mlp = new Mlp(policy);
    let worst = 0;
    for (const f of fixture.frames) {
      const a = mlp.act(f.obs);
      for (let i = 0; i < NUM_ACT; i++) worst = Math.max(worst, Math.abs(a[i] - f.action[i]));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('MuJoCo WASM reproduces the Python simulation, observation for observation', () => {
    const sim = new QuadrupedSim(mj, xml, policy);
    sim.reset(fixture.qpos);
    const last = new Float64Array(NUM_ACT);
    let worst = 0;
    fixture.frames.forEach((f) => {
      const o = sim.observe(fixture.command, last);
      for (let i = 0; i < o.length; i++) worst = Math.max(worst, Math.abs(o[i] - f.obs[i]));
      sim.applyAction(f.action);
      last.set(f.action);
    });
    let qposErr = 0;
    for (let i = 0; i < fixture.finalQpos.length; i++) qposErr = Math.max(qposErr, Math.abs(sim.data.qpos[i] - fixture.finalQpos[i]));
    sim.dispose();
    // Same engine version and model: the trajectories agree to float noise over two seconds of contact-rich walking.
    expect(worst).toBeLessThan(1e-6);
    expect(qposErr).toBeLessThan(1e-6);
  });

  it('walks at the commanded speed, turns, and stands still, closed loop in WASM', () => {
    const sim = new QuadrupedSim(mj, xml, policy);
    const mlp = new Mlp(policy);
    const run = (command: number[], seconds: number) => {
      sim.reset();
      const last = new Float64Array(NUM_ACT);
      const obs = new Float64Array(48);
      let minUpright = 1;
      let yaw = 0;
      const start = [sim.data.qpos[0], sim.data.qpos[1]];
      for (let k = 0; k < seconds * 50; k++) {
        sim.observe(command, last, obs);
        const a = mlp.act(obs);
        sim.applyAction(a);
        last.set(a);
        minUpright = Math.min(minUpright, sim.upright);
        yaw += sim.data.qvel[5] / 50;
      }
      return { dx: sim.data.qpos[0] - start[0], dy: sim.data.qpos[1] - start[1], yaw, minUpright };
    };
    const walk = run([0.8, 0, 0], 8);
    expect(walk.minUpright).toBeGreaterThan(0.8);
    expect(walk.dx).toBeGreaterThan(0.8 * 8 * 0.85);
    expect(walk.dx).toBeLessThan(0.8 * 8 * 1.15);
    const turn = run([0, 0, 1], 6);
    expect(Math.abs(turn.yaw - 6)).toBeLessThan(6 * 0.15);
    const stand = run([0, 0, 0], 6);
    expect(Math.hypot(stand.dx, stand.dy)).toBeLessThan(0.1);
    sim.dispose();
  });
});
