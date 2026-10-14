// Evolve the shipped champions for study 12 (Node ≥ 22, TypeScript run directly):
//
//   node --experimental-transform-types tools/evolve.ts [generations=40] [seeds=1,2,3]
//
// Runs the same GA and physics as the page, one run per seed, and writes the best genome of each run with its
// fitness to public/assets/creatures/champions.json. The unit tests re-simulate them and expect the exact
// fitness back.
import { writeFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { DEFAULT_GA, GeneticAlgorithm } from '../demos/12-evolved-creatures/ga.ts';
import { EVAL, evaluate } from '../demos/12-evolved-creatures/phenotype.ts';

await RAPIER.init();
const generations = Number(process.argv[2] ?? 40);
const seeds = (process.argv[3] ?? '1,2,3').split(',').map(Number);
const champions = [];
for (const seed of seeds) {
  const ga = new GeneticAlgorithm({ ...DEFAULT_GA, seed });
  const t0 = performance.now();
  for (let g = 0; g < generations; g++) {
    ga.advance(ga.population.map((genome) => evaluate(genome).fitness));
    const h = ga.history[g];
    if (g % 5 === 4 || g === generations - 1) console.log(`seed ${seed} gen ${g + 1}: best ${h.best.toFixed(2)} m, mean ${h.mean.toFixed(2)} m`);
  }
  const best = ga.best!;
  champions.push({
    name: `seed ${seed}`,
    seed,
    generations,
    population: DEFAULT_GA.population,
    duration: EVAL.duration,
    fitness: best.fitness,
    history: ga.history.map((h) => [+h.best.toFixed(4), +h.mean.toFixed(4)]),
    genome: best.genome,
  });
  console.log(`seed ${seed}: ${best.fitness.toFixed(3)} m in ${EVAL.duration} s, ${best.genome.parts.length} genes (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}
champions.sort((a, b) => b.fitness - a.fitness);
writeFileSync('public/assets/creatures/champions.json', JSON.stringify(champions));
