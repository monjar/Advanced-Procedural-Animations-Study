import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PhaseNet, Runner, type NetworksFile, type PfnnModel } from '../../demos/26-phase-locomotion/pfnn';

const asset = (f: string) => resolve(__dirname, '../../public/assets/pfnn', f);
const nets = JSON.parse(readFileSync(asset('networks.json'), 'utf8')) as NetworksFile;
const model = JSON.parse(readFileSync(asset('model.json'), 'utf8')) as PfnnModel;
const start = () => ({ joints: nets.fixture.x[0].slice(model.traj.length * 4 + 2), phase: nets.fixture.phase[0] });
const runner = (kind: 'pfnn' | 'mlp') => new Runner(new PhaseNet(nets[kind], nets, kind === 'pfnn'), model, start());
const knee = (w: ArrayLike<number>) => {
  const [h, k, a] = ['LeftUpLeg', 'LeftLeg', 'LeftFoot'].map((n) => model.names.indexOf(n));
  const u = [w[h * 3] - w[k * 3], w[h * 3 + 1] - w[k * 3 + 1], w[h * 3 + 2] - w[k * 3 + 2]];
  const v = [w[a * 3] - w[k * 3], w[a * 3 + 1] - w[k * 3 + 1], w[a * 3 + 2] - w[k * 3 + 2]];
  return 180 - (Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v))) * 180) / Math.PI;
};

describe('phase-functioned network', () => {
  it('the TypeScript networks reproduce PyTorch (half-precision weights)', () => {
    for (const kind of ['pfnn', 'mlp'] as const) {
      const net = new PhaseNet(nets[kind], nets, kind === 'pfnn');
      let worst = 0;
      nets.fixture.x.forEach((x, i) => {
        const y = net.run(x, nets.fixture.phase[i], new Float64Array(model.yDims));
        for (let k = 0; k < y.length; k++) worst = Math.max(worst, Math.abs(y[k] - nets.fixture[kind][i][k]));
      });
      expect(worst, kind).toBeLessThan(1e-4);
    }
  });

  it('follows commands closed-loop: walk, turn, run, walk back — both networks', () => {
    for (const kind of ['pfnn', 'mlp'] as const) {
      const r = runner(kind);
      const segs: [{ x: number; z: number; run: boolean }, number, number][] = [
        [{ x: 0, z: 1, run: false }, 6, 1.3],
        [{ x: 1, z: 0, run: false }, 4, 1.3],
        [{ x: 1, z: 0, run: true }, 6, 3.2],
        [{ x: -1, z: 0, run: false }, 5, 1.3],
      ];
      for (const [inp, secs, want] of segs) {
        const speeds: number[] = [];
        for (let f = 0; f < secs * 60; f++) {
          const px = r.x;
          const pz = r.z;
          r.step(inp);
          if (f > 120) speeds.push(Math.hypot(r.x - px, r.z - pz) * 60);
        }
        speeds.sort((a, b) => a - b);
        const speed = speeds[speeds.length >> 1];
        const facing = Math.atan2(Math.sin(r.yaw - Math.atan2(inp.x, inp.z)), Math.cos(r.yaw - Math.atan2(inp.x, inp.z)));
        expect(Number.isFinite(r.world[0]), kind).toBe(true);
        expect(speed / want, `${kind} speed at ${want}`).toBeGreaterThan(0.75);
        expect(speed / want, `${kind} speed at ${want}`).toBeLessThan(1.15);
        expect(Math.abs(facing), `${kind} facing`).toBeLessThan(0.17);
      }
    }
  });

  it('runs with more knee bend than the plain network, which blurs the run toward the walk', () => {
    const flexion = (kind: 'pfnn' | 'mlp') => {
      const r = runner(kind);
      let max = 0;
      for (let f = 0; f < 600; f++) {
        r.step({ x: 0, z: 1, run: true });
        if (f > 180) max = Math.max(max, knee(r.world));
      }
      return max;
    };
    expect(flexion('pfnn')).toBeGreaterThan(flexion('mlp') + 5);
  });
});
