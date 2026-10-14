# Procedural Quadruped

The hexapod (study 05) steps when a foot falls too far behind — a reactive, threshold-driven gait.
Four-legged animals are not reactive like that: each gait is a **fixed timing pattern**, and speed changes
which pattern is used. This study drives a dog entirely from such a pattern table and blends between
walk, trot, canter and gallop as speed changes.

## The gait table

Gaits are described the way biologists describe them (Hildebrand): for each leg, the **phase offset**
in the stride cycle at which the foot touches down, plus a **duty factor** — the fraction of the cycle
each foot is on the ground.

| gait | LF | RF | LH | RH | duty | character |
|---|---|---|---|---|---|---|
| walk | .25 | .75 | 0 | .5 | .65 | lateral sequence, ≥ 2 feet down |
| trot | 0 | .5 | .5 | 0 | .42 | diagonal pairs |
| canter | .6 | .3 | .3 | 0 | .40 | 3-beat, left lead |
| gallop | .6 | .48 | 0 | .1 | .30 | rotary, suspension phase |

A global phase advances at the stride frequency `f(v) = min(3.6, 1.4 + 0.45·v)` Hz; leg `i` is in stance
while `frac(φ − offset_i) < duty`. Across each transition speed the neighbouring gaits are blended over
±0.35 m/s: duty factor and body motion linearly, phase offsets **on the circle** (shortest signed phase
difference), so no leg ever jumps across the cycle. The unit tests check that blending is continuous at
every speed, that the walk keeps two feet down, that the trot pairs diagonals and that the gallop has a
moment with no feet on the ground.

The footfall panel is a live Hildebrand diagram: filled bars are stance.

## Placing the feet

- **Liftoff** happens when a leg's phase crosses its duty factor.
- **Landing target:** the point under the shoulder/hip **plus half a stance of travel**, so the body passes
  over the foot at mid-stance.
- **Swing** is interpolated **relative to the moving body** (in the yaw frame), not in world space. A
  world-space ease-in-out on a body moving at constant speed makes the foot overshoot the body near the end
  of the swing — measured at 14 cm at gallop before this was fixed, which pushed the legs out of reach.
- **Over-extension guard:** if a stance leg is already straight in late stance, it lifts early and the next
  scheduled liftoff is skipped. The foot never slides; timing shifts slightly instead.
- Standing still, feet that are far from neutral are tidied up one at a time.

## The body

- **Legs** are digitigrade: the paw→carpus / paw→hock segment is placed first with a fixed lean (hock behind the
  paw), folding during swing; then the analytic two-bone IK of study 02 solves shoulder→elbow→carpus with the
  elbow pointing back and hip→stifle→hock with the knee pointing forward.
- **Body motion** follows the blended gait: vertical bob (twice per stride in walk/trot, once in
  canter/gallop), pitch rocking, and in the gallop a spine **flex** that gathers and extends the back.
- **Terrain:** pitch from the ground height under shoulders and hips; feet land on the height field.
- **Spine** bends sideways with turn rate; the body leans into turns.
- **Head stabilisation:** the head chases a target that ignores bob and pitch through a second-order filter
  (study 01), so it floats steady while the body pumps underneath — the way real quadrupeds keep their gaze
  stable.
- **Tail** is a spring chain (study 01).

## Failure modes

- Transitions are driven by speed alone; real animals add hysteresis (and switch gait to save energy).
- The canter/gallop leads never change; real animals swap lead on turns.
- No dynamics: nothing prevents a physically impossible gait if the table is edited — try a walk duty of 0.3.

## References

- M. Hildebrand, *Symmetrical gaits of horses*, Science 150 (1965); *Analysis of asymmetrical gaits*,
  J. Mammalogy (1977)
- H. Zhang, S. Starke, T. Komura, J. Saito, *Mode-Adaptive Neural Networks for Quadruped Motion Control*
  (SIGGRAPH 2018) — the data-driven alternative
