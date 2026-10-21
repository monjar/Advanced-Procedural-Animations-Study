import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Creature, gaitOffsets } from '../../demos/24-creature-creator/creature';
import { PRESETS } from '../../demos/24-creature-creator/presets';
import { hills } from '../../src/world/terrain';

const terrain = hills({ seed: 11, amplitude: 0.35, scale: 5, flatRadius: 2.5 });
const preset = (name: string) => structuredClone(PRESETS.find((p) => p.name.startsWith(name))!);
const offset = (o: ReturnType<typeof gaitOffsets>, pair: number, side: -1 | 1) => o.find((x) => x.pair === pair && x.side === side)!.offset;

function walk(name: string, froude: number, seconds = 12, scaleLegs = 1) {
  const spec = preset(name);
  spec.legs = spec.legs.map((l) => ({ ...l, length: l.length * scaleLegs }));
  const c = new Creature(spec, terrain);
  c.froude = froude;
  const target = new THREE.Vector3(30, 0, 5);
  let slip = 0;
  let stanceSamples = 0;
  let samples = 0;
  const prev = c.legs.map((l) => ({ stance: l.stance, foot: l.foot.clone() }));
  for (let i = 0; i < seconds * 60; i++) {
    c.update(1 / 60, target);
    c.legs.forEach((l, k) => {
      if (l.stance && prev[k].stance) slip = Math.max(slip, l.foot.distanceTo(prev[k].foot));
      prev[k] = { stance: l.stance, foot: l.foot.clone() };
      samples++;
      if (l.stance) stanceSamples++;
    });
  }
  const s = c.stats;
  return { c, slip, stanceFraction: stanceSamples / samples, stable: s.stableTime / s.sampledTime, reachMiss: s.reachMissTime / s.stanceTime };
}

describe('creature creator', () => {
  it('chooses the gait from the number of leg pairs', () => {
    const biped = gaitOffsets(1, 0.3);
    expect(Math.abs(offset(biped, 0, -1) - offset(biped, 0, 1))).toBeCloseTo(0.5, 9);
    const insect = gaitOffsets(3, 0.3);
    // Tripod: left front, right middle and left back move together.
    expect(offset(insect, 0, -1)).toBe(offset(insect, 1, 1));
    expect(offset(insect, 2, -1)).toBe(offset(insect, 1, 1));
    expect(Math.abs(offset(insect, 0, -1) - offset(insect, 0, 1))).toBeCloseTo(0.5, 9);
    // Four legs: Hildebrand's lateral-sequence walk when slow, diagonal pairs together (trot) when fast.
    const walkG = gaitOffsets(2, 0.2);
    expect([offset(walkG, 0, -1), offset(walkG, 1, -1), offset(walkG, 0, 1), offset(walkG, 1, 1)]).toEqual([0, 0.25, 0.5, 0.75]);
    const trot = gaitOffsets(2, 0.9);
    expect(offset(trot, 1, -1)).toBeCloseTo(offset(trot, 0, 1), 9);
    expect(offset(trot, 1, 1)).toBeCloseTo(offset(trot, 0, -1), 9);
  });

  it('scales by dynamic similarity: twice the leg length, same relative stride, 1/√2 the step frequency', () => {
    const a = walk('quadruped', 0.4, 2);
    const b = walk('quadruped', 0.4, 2, 2);
    expect(b.c.stride / b.c.legLength).toBeCloseTo(a.c.stride / a.c.legLength, 6);
    expect(b.c.frequency / a.c.frequency).toBeCloseTo(1 / Math.SQRT2, 3);
  });

  it('planted feet never slide, feet stay within reach, and the stance fraction matches the duty factor', () => {
    for (const name of ['quadruped', 'biped', 'insect', 'spider', 'centipede', 'long-legged']) {
      const r = walk(name, 0.4);
      expect(r.slip, name).toBe(0);
      expect(r.reachMiss, name).toBeLessThan(0.02);
      expect(Math.abs(r.stanceFraction - r.c.duty), name).toBeLessThan(0.03);
    }
  });

  it('slow many-legged gaits are statically stable; a fast four-legged trot is not', () => {
    expect(walk('insect', 0.15).stable).toBeGreaterThan(0.9);
    expect(walk('centipede', 0.15).stable).toBeGreaterThan(0.95);
    const slow = walk('quadruped', 0.15).stable;
    const fast = walk('quadruped', 0.8).stable;
    expect(slow).toBeGreaterThan(0.45);
    expect(fast).toBeLessThan(0.05);
  });
});
