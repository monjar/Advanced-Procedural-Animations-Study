# Creature Creator

Spore let players build creatures with any number of legs, of any length, anywhere on the body, and they all
walked (Hecker et al., SIGGRAPH 2008). This study does the same procedurally. You shape a body from parts: a
spine, leg pairs, a head and a tail. Pick a preset, press "Randomise a creature", or drag the sliders. Nothing
is authored per body; everything below is derived from the body's shape.

## What's derived from the body (`creature.ts`)

| | from | rule |
|---|---|---|
| gait pattern | number of leg pairs | 1 pair: alternate. 2: Hildebrand's lateral-sequence walk (left hind, left fore, right hind, right fore, a quarter cycle apart), blending into a trot (diagonals together) with speed. 3: the insect tripod. 4+: a metachronal wave from back to front, the two sides half a cycle apart |
| stride, frequency | leg length h | dynamic similarity: at the same Froude number v̂ = v/√(g·h), animals take relative strides λ/h ≈ 2.3·v̂^0.6 (Alexander 1976). Frequency is v/λ |
| duty factor | speed | 0.72 − 0.35·v̂: feet spend less of each cycle on the ground as the animal speeds up (walking above 0.5, running below) |
| footholds | the body's motion | each foot aims to land half a stance ahead of where its hip will be, on the terrain, updating through the swing so it can steer |
| legs | the foot and the hip | two-bone IK (study 02). Knees point forward on front legs and backward on hind legs; many-legged bodies bend them up and out. Three-segment legs keep a digitigrade foot |
| body | the feet | every vertebra follows the head's path, so long bodies snake through turns. Height comes from where the feet actually are, interpolated between leg pairs |
| head, tail | the body's motion | the head turns toward where it is going; the tail is a second-order spring chain (study 01) |

Speed is set as a Froude number, so one slider means "stroll" or "run" for any size of creature. A 2 m-legged
creature takes the same relative strides as a 0.5 m one, at half the step rate.

## Measured

15 s on hilly terrain toward a target (`creatures2.test.ts` checks the rest):

| creature | v̂ = 0.15 · 0.4 · 0.8 → statically stable | feet out of reach |
|---|---|---|
| quadruped (walk → trot) | 61% · 32% · 0% | ≤ 1.1% of stance |
| biped | never (two feet are never a support polygon) | ≤ 1.4% |
| insect (tripod) | 98% · 64% · 32% | ≤ 0.6% |
| spider (wave) | 53% · 67% · 57% | ≤ 1.0%, but 9.6% at v̂ = 0.8 |
| centipede (wave) | 100% · 100% · 89% | ≤ 0.1% |
| long-legged | 64% · 32% · 0% | ≤ 2.8% |

The stability column follows the biology without being programmed in. A slow walking quadruped keeps its centre
over three feet most of the time. A trot never does: it balances dynamically. A tripod insect is almost always
statically stable, and a centipede always is. Planted feet never slide (they're held exactly), and the fraction
of time each foot spends on the ground matches the duty factor to within 3%.

**Where it breaks:** a fast spider. With eight long, splayed legs at v̂ = 0.8, the predicted footholds land
beyond reach almost 10% of the time, and those feet slide. Stride needs a cap from the leg's actual reach, not
only from its length.

## Failure modes

- The body's height and tilt come from the feet, but nothing checks dynamic balance. A trotting quadruped never
  falls, because nothing can make it fall. That's the gap between this and the physics-based studies (10, 17, 21).
- Gaits are chosen by leg count, not by the body. A creature with long front legs and short hind legs still trots
  like a dog.
- Knees are chosen by a rule. Spore retargeted from authored motion to get personality; this only gets
  plausibility.

## References

- C. Hecker, B. Raabe, R. W. Enslow, J. DeWeese, J. Maynard, K. van Prooijen, *Real-time Motion Retargeting to
  Highly Varied User-Created Morphologies* (SIGGRAPH 2008)
- M. Hildebrand, *Symmetrical gaits of horses* (Science 1965) and *Analysis of tetrapod gaits* (1977)
- R. McN. Alexander, *Estimates of speeds of dinosaurs* (Nature 1976); *The gaits of bipedal and quadrupedal
  animals* (IJRR 1984)
- D. M. Wilson, *Insect walking* (Annu. Rev. Entomol. 1966)
