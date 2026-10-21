import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMotionDB } from '../../src/anim/mmdb';
import { buildFeatures } from '../../src/anim/mmfeatures';
import { buildScenario, SCENARIOS } from '../../demos/19-character-crowds/scenarios';
import { MMCrowd, type Coupling } from '../../demos/27-mm-crowds/mmcrowd';

const buf = readFileSync(resolve(__dirname, '../../public/assets/mocap/cmu16-mm.bin'));
const db = parseMotionDB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const mf = buildFeatures(db);

function run(coupling: Coupling, pull: number) {
  const s = SCENARIOS.find((x) => x.name === 'crossing')!;
  const crowd = buildScenario(s, { model: 'orca' }, 0.4, 7);
  const mm = new MMCrowd(crowd, 'database', { mf });
  mm.coupling = coupling;
  mm.pull = pull;
  while (crowd.metrics.arrived < crowd.agents.length && crowd.metrics.time < s.timeout) mm.step(1 / 60);
  return { arrived: crowd.metrics.arrived / crowd.agents.length, overlap: mm.stats.bodyOverlap, slip: mm.stats.slipSum / mm.stats.slipSamples };
}

describe('motion-matched crowds', () => {
  const animation = run('animation', 0);
  const pulled = run('simulation', 4);

  it('everyone gets across either way', () => {
    expect(animation.arrived).toBe(1);
    expect(pulled.arrived).toBe(1);
  });

  it('pulled hard toward collision-free agents, bodies never overlap, and their feet slide for it', () => {
    expect(pulled.overlap).toBeLessThan(0.5);
    expect(pulled.slip).toBeGreaterThan(1.4 * animation.slip);
  });

  it('driven by their own animation, feet slide less but bodies collide (they cannot change velocity as fast as ORCA asks)', () => {
    expect(animation.overlap).toBeGreaterThan(10 * Math.max(0.1, pulled.overlap));
    expect(animation.overlap).toBeGreaterThan(2);
    expect(animation.slip).toBeLessThan(pulled.slip);
  });
});
