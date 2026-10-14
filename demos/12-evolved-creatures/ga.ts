import { Rng } from '../../src/math/random.ts';
import { crossover, mutate, randomGenome, type Genome } from './genome.ts';

export interface GAOptions {
  population: number;
  elite: number;
  tournament: number;
  crossoverRate: number;
  mutationRate: number;
  seed: number;
}

export const DEFAULT_GA: GAOptions = { population: 48, elite: 2, tournament: 3, crossoverRate: 0.3, mutationRate: 0.25, seed: 1 };

export interface Scored {
  genome: Genome;
  fitness: number;
}

/**
 * Generational GA: tournament selection, elitism (the best survive unchanged, so the best fitness never
 * drops), subtree crossover and mutation. Evaluation is pluggable — synchronous in Node, a worker pool in
 * the browser.
 */
export class GeneticAlgorithm {
  readonly rng: Rng;
  population: Genome[];
  generation = 0;
  readonly history: { best: number; mean: number }[] = [];
  best: Scored | null = null;

  constructor(readonly options: GAOptions = DEFAULT_GA) {
    this.rng = new Rng(options.seed);
    this.population = Array.from({ length: options.population }, () => randomGenome(this.rng));
  }

  /** Record a generation's scores and breed the next one. `fitness[i]` scores `population[i]`. */
  advance(fitness: number[]): void {
    const o = this.options;
    const scored: Scored[] = this.population.map((genome, i) => ({ genome, fitness: fitness[i] }));
    scored.sort((a, b) => b.fitness - a.fitness);
    if (!this.best || scored[0].fitness > this.best.fitness) this.best = scored[0];
    this.history.push({ best: scored[0].fitness, mean: fitness.reduce((a, b) => a + b, 0) / fitness.length });
    const pick = () => {
      let w = scored[this.rng.int(scored.length)];
      for (let k = 1; k < o.tournament; k++) {
        const c = scored[this.rng.int(scored.length)];
        if (c.fitness > w.fitness) w = c;
      }
      return w.genome;
    };
    const next: Genome[] = scored.slice(0, o.elite).map((s) => s.genome);
    while (next.length < o.population) {
      let child = this.rng.chance(o.crossoverRate) ? crossover(pick(), pick(), this.rng) : pick();
      child = mutate(child, this.rng, o.mutationRate);
      next.push(child);
    }
    this.population = next;
    this.generation++;
  }
}
