# Foot IK & Ground Adaptation over Mocap

Motion capture is recorded on a flat floor. Play it on a ramp or a staircase and the feet sink into the
geometry or hang in the air. Every shipped game fixes this with a **procedural layer on top of the clip**
rather than more data. This study does it on real data — a CMU walk — over a course with a ramp, stairs up and
down, a slope and bumps. Untick **foot IK** to see the raw clip.

## Data pipeline (`tools/bvh-to-clip.mjs`)

1. Parse the CMU BVH (Bruce Hahne's MotionBuilder-friendly conversion), drop finger joints.
2. Scale to metres (leg length normalised to 0.88 m), resample 120 → 60 Hz, skip the added T-pose frame.
3. **Contact labels:** a foot is in contact when its ankle or toe is near the ground and slow; short gaps are
   closed.
4. **One gait cycle** between two right-foot contacts near the middle of the take, rotated to walk along +Z.
5. **Loop fix:** the end-to-start rotation mismatch of every joint is distributed over the cycle so the loop is
   seamless; the root displacement per cycle becomes root motion.

The result is a 49 KB JSON with one 1.15 s cycle.

## The layer, per frame

1. **Terrain offset per foot.** For each raw clip foot, the ground under heel and toe (the higher of the two).
   During swing, the offset blends from the height at the previous landing to the height at the **next**
   landing — looked up in the clip's future — so the swing foot rises over a step before reaching it.
2. **Pelvis.** The whole skeleton moves to the **lower** foot's offset through a critically damped spring;
   the higher leg bends to reach its step.
3. **Foot locking.** A contact is not one phase: the ankle rolls 15–20 cm from heel strike through flat foot
   to heel-off. Only the **foot-flat** phase (in contact, ankle still, at rest height) is pinned in world
   space. Locking the whole contact left feet behind the body and made the IK unreachable by 11–13 cm.
4. **Reach constraint.** If either foot target is out of reach (stepping down, or a lock fighting the
   clip's own slide), the pelvis drops just enough. World targets are unaffected.
5. **Two-bone IK on the skeleton.** Hip → knee → ankle are solved with the analytic solver of study 02,
   using the **animated** knee to define the bend plane, then written back as world-space rotations on the
   thigh and shin bones — the clip's knee direction and leg twist survive.
6. **Foot alignment.** Planted feet rotate to the slope normal (flat on stairs).

## Measured (unit-tested on the course)

| | raw clip | with the layer |
|---|---|---|
| worst foot-flat error vs supporting surface | > 1.5 m (stairs) | < 2 cm on every segment |
| worst IK reach error | – | < 1 mm |
| foot travel during a foot-flat phase | 7.5 cm | 1.4 cm |

## Honest limitations

- **Stairs:** the clip's stride does not match the tread spacing, so a foot often lands with the toe on a
  tread and the heel over the step below. The layer rests the foot on the higher surface; a production
  system would adjust stride length to the stairs.
- No knee-collision with the step edges during swing, only height adaptation.
- One clip, one speed — study 09 (motion matching) is where clip selection and transitions come in.

## Data

> The data used in this project was obtained from mocap.cs.cmu.edu.
> The database was created with funding from NSF EIA-0196217.

Clip: subject 02, trial 01 (walk), via the cgspeed BVH conversion by Bruce Hahne.

## References

- R. S. Johansen, *Automated Semi-Procedural Animation for Character Locomotion* (Aarhus University, 2009)
- CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu
