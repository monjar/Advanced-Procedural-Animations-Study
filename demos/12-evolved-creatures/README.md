# Evolved Virtual Creatures

Nobody designs these animals. A genetic algorithm breeds body plans and the rhythms that drive them; the
only instruction is *get as far as you can in 8 seconds*. Evolution runs live in background Web Workers —
watch the fitness chart climb — while the page plays back either this run's best or one of the champions
evolved offline.

## Genome (after Sims 1994, simplified)

- A **tree of box parts** (up to 8 genes, depth ≤ 4). Each child gene has a size, an attachment point on its
  parent (snapped to the dominant face), a hinge axis and range.
- **Brain**: every hinge is driven by its own oscillator — amplitude, phase and offset — sharing one
  frequency per creature. No sensors: these are open-loop gaits.
- A limb on the root can be **mirrored** across the body's x = 0 plane, subtree and all, half a cycle out of
  phase. Symmetric, alternating walkers come from this one bit.

Sims' genomes were directed graphs with recursion and neural brains with sensors; trees and oscillators are the
honest smaller version (see failure modes).

## Phenotype (Rapier)

Boxes at density 1000 kg/m³, hinged with revolute joints with limits, driven by force-based joint motors
towards *offset + amp·sin(2πft + phase)*. **Motor torque is capped in proportion to the part's
cross-section**, as Sims did: a strong limb has to be a thick, heavy limb.

## Fitness, and the exploits it has to survive

Distance the centre of mass travels horizontally in 8 s, measured after a 1.5 s settle. Evolution finds
every loophole in a fitness function, so:

| exploit | guard |
|---|---|
| parts spawned overlapping fly apart ("launching") | parts collide only with the ground |
| falling over counts as distance | measuring starts after the 1.5 s settle |
| physics blow-ups | NaN or any body faster than 15 m/s → fitness 0 |
| throwing itself into the air | centre of mass rising 1 m above its settled height → fitness 0 |
| huge muscles on tiny limbs | torque ∝ cross-section |

## The algorithm

Generational GA, population 48: tournament selection (3), the best 2 survive unchanged (so the best never gets
worse), 30 % subtree crossover, then mutation — Gaussian nudges to every parameter plus occasional
structural changes (add a part, drop a subtree, flip a mirror). The page splits each generation across
`hardwareConcurrency − 1` workers; the playback is recorded in a worker too, so Rapier never loads on the
main thread.

## Measured

Shipped champions (`tools/evolve.ts`, population 48, 40 generations, one run per seed — about a minute each):

| run | distance in 8 s | speed | genes | gait |
|---|---|---|---|---|
| seed 3 | 13.4 m | 1.7 m/s | 5 (one mirrored limb) | scuttles, airborne 5 % of the time |
| seed 1 | 12.0 m | 1.5 m/s | 5 (two mirrored limbs) | crawls, never airborne |
| seed 2 | 11.3 m | 1.4 m/s | 4 | hops, airborne 20 % of the time |

A random creature covers 0.9 m on average (best of 40: 3.8 m). Most of the gain comes in the first 10–20
generations; after that the best stalls for long stretches — the usual plateau of a GA without diversity
maintenance. The gaits are vigorous rather than graceful: limbs whip at up to 8 m/s.

- **Determinism**: the same genome scores bit-for-bit the same alone or interleaved with others, and a shipped
  champion re-simulated in a browser worker scores exactly its Node fitness (unit and end-to-end tests).
- 10 000 seeded random, mutate and crossover operations produce only valid genomes.
- A seeded run (population 24, 6 generations) never loses its best and ends ≥ 1.5× generation 0.
- An evaluation costs ~35 ms of CPU (9.5 s of physics at 60 Hz); three workers manage ~35 evaluations a second.

## Failure modes

- **Open-loop brains** can't react: a gait that works on flat ground falls over on anything else, and creatures
  that topple mid-run never get up.
- Without self-collision, limbs can pass through each other — which evolution happily uses.
- Tree genomes can't express repeated segments the way Sims' recursive graphs could, so no centipedes.
- Fitness is distance in any direction, so many champions are crawlers and tumblers rather than walkers.

## References

- K. Sims, *Evolving Virtual Creatures* (SIGGRAPH 1994) and *Evolving 3D Morphology and Behavior by
  Competition* (Artificial Life IV, 1994)
- T. Geijtenbeek, M. van de Panne, F. van der Stappen, *Flexible Muscle-Based Locomotion for Bipedal
  Creatures* (SIGGRAPH Asia 2013)
