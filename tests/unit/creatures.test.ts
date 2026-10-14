import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { Rng } from '../../src/math/random';
import { crossover, mutate, randomGenome, validate, type Genome } from '../../demos/12-evolved-creatures/genome';
import { EVAL, evaluate } from '../../demos/12-evolved-creatures/phenotype';
import { GeneticAlgorithm } from '../../demos/12-evolved-creatures/ga';

beforeAll(async () => {
  await RAPIER.init();
});

describe('creature genomes', () => {
  it('stay valid through 10 000 seeded random / mutate / crossover operations', () => {
    const rng = new Rng(42);
    let pool: Genome[] = Array.from({ length: 16 }, () => randomGenome(rng));
    let invalid = 0;
    for (let i = 0; i < 10000; i++) {
      const op = rng.int(3);
      const g = op === 0 ? randomGenome(rng) : op === 1 ? mutate(rng.pick(pool), rng, rng.range(0.05, 0.8)) : crossover(rng.pick(pool), rng.pick(pool), rng);
      if (validate(g).length) invalid++;
      pool[rng.int(pool.length)] = g;
    }
    expect(invalid).toBe(0);
    pool = [];
  });
});

describe('creature physics', () => {
  it('is deterministic: the same genome scores bitwise the same, alone or interleaved', () => {
    const rng = new Rng(5);
    const a = randomGenome(rng);
    const b = randomGenome(rng);
    const first = evaluate(a, 3);
    evaluate(b, 3);
    const second = evaluate(a, 3);
    expect(second.fitness).toBe(first.fitness);
    expect(second.distance).toBe(first.distance);
  });

  it('disqualifies a creature that gets launched', () => {
    const g = randomGenome(new Rng(8));
    const r = evaluate(g, 3, (c, t) => {
      if (Math.abs(t - 2) < 1e-9) c.bodies[0].applyImpulse({ x: 0, y: 40 * c.mass, z: 0 }, true);
    });
    expect(r.fitness).toBe(0);
    expect(['launch', 'speed']).toContain(r.disqualified);
  });

  it('a seeded GA run improves: best never drops, and ends ≥ 1.5× generation 0', () => {
    const ga = new GeneticAlgorithm({ population: 24, elite: 2, tournament: 3, crossoverRate: 0.3, mutationRate: 0.25, seed: 7 });
    for (let g = 0; g < 6; g++) ga.advance(ga.population.map((genome) => evaluate(genome, 4).fitness));
    const best = ga.history.map((h) => h.best);
    for (let i = 1; i < best.length; i++) expect(best[i]).toBeGreaterThanOrEqual(best[i - 1]);
    expect(best[best.length - 1]).toBeGreaterThanOrEqual(1.5 * best[0]);
  }, 30000);

  it('re-simulating the shipped champions reproduces their recorded fitness exactly', () => {
    const champions = JSON.parse(readFileSync('public/assets/creatures/champions.json', 'utf8')) as { fitness: number; duration: number; genome: Genome }[];
    expect(champions.length).toBeGreaterThan(0);
    for (const c of champions) {
      expect(validate(c.genome)).toEqual([]);
      expect(c.duration).toBe(EVAL.duration);
      expect(evaluate(c.genome).fitness).toBe(c.fitness);
      expect(c.fitness / c.duration).toBeGreaterThan(0.3);
    }
  }, 30000);
});
