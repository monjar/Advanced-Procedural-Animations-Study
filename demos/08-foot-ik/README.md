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

The result is a 49 KB JSON with one 1.15 s cycle. At runtime the clip (and its ghost) is lifted 3 cm: the
toe joint touches the floor in the data, but the rendered toe is a 3.7 cm sphere around it.

## Planning: the clip is known ahead

A clip is not a player's input: every future foot position is already on disk. So instead of reacting to the
course frame by frame, the layer plans each foot's vertical offset over the contacts and swings around now.

1. **Contacts** get one constant offset: the highest the course under the foot gets (relative to the clip's
   own floor) during the **foot-flat** frames. Heel strike and toe-off frames don't count — a toe rolling
   1 cm past a riser at toe-off would otherwise lift the whole planted foot 15 cm.
2. **Where the foot really is.** Planning on the raw clip is wrong: the clip's foot slides 7.5 cm while
   planted, enough to reach the next riser, and alignment tilts the toe. The plan places each frame's foot
   where the final pose will put it — pinned by the lock, released at the lock's rate, turned to the slope.
3. **Nudge.** On the way down, a heel can land 2 cm over a nosing; standing on the tread above would mean
   floating 15 cm. Each lock tries shifts of up to ±4 cm along the course, at a cost of 2 cm of height per
   cm moved; the approaching swing eases the shift in.
4. **Swings** blend between the two contact offsets (smoothstep) and add a **clearance lift**: the smallest
   curve that keeps every swing frame clear of the course by a 2 cm margin with acceleration within
   ±40 m/s². It is a Lasry–Lions double envelope: an upper envelope of downward parabolas hung from each
   frame's requirement, then a lower envelope of narrower upward parabolas resting on it. One envelope alone
   either cuts corners or jumps in velocity; with the second one the curve is C¹ and still clears every
   frame. Requirements are first made monotone on a climb or descent, so a foot clears a flight in one move
   instead of hopping over each nosing. On flat ground every term is 0 and the clip plays as recorded.

## Per frame

1. **Offsets** from the plan. A toggled layer (or the reactive mode below) is inertialized: the jump is kept
   as a residual that decays, while the plan itself is followed exactly — springing the whole signal lags
   behind it and into the steps.
2. **Pelvis.** The whole skeleton moves to the **lower** foot's offset through a critically damped spring;
   the higher leg bends to reach its step.
3. **Foot locking.** Only the foot-flat phase (in contact, ankle still, at rest height) is pinned, and only
   horizontally — height comes from the plan, and pinning it would stop the ankle rising as the clip rolls
   onto the toe. Locking the whole contact left feet behind the body and made the IK unreachable by 11–13 cm.
4. **Reach constraint.** If either foot target is out of reach, the pelvis drops just enough.
5. **Two-bone IK on the skeleton** (study 02's solver), using the **animated** knee for the bend plane and
   written back as world-space rotations on thigh and shin. The foot keeps its animated world orientation;
   letting it inherit the shin's new tilt dipped the toe 4–5 cm into the treads.
6. **Foot alignment** to the slope normal (flat on stairs).
7. **Guard.** The posed foot is measured against the course and lifted by anything still inside. It is a
   last resort: with the plan it never exceeds 4 mm; in the reactive mode it does 20 cm of work.

Untick **swing adapt** to see the reactive alternative: each foot only gets what it needs this instant, so it
pops up at every riser.

## Measured (unit-tested on the course)

Rendered feet (ankle sphere, foot cylinder, toe sphere) and shins against the rendered course mesh — exact
sphere-vs-polyline depth, not the layer's own query — over the whole course at 60 fps. The penetration rows
also hold at 25 and 144 fps.

| | raw clip | first version | now |
|---|---|---|---|
| deepest foot inside the course | 1.8 m | 9.4 cm | < 4 mm |
| frames with a foot > 1 cm inside | 74 % | 75 % | 0 |
| peak vertical ankle acceleration | 28 m/s² | 516 m/s² | 67 m/s² |
| foot-flat frames hovering > 2 cm beyond the clip's own gap | – | 0.9 % | 1.3 % |
| foot travel during a foot-flat phase | 7.5 cm | 1.4 cm | 1.4 cm |

The first version looked plausible and measured badly: it checked only the ankle, only during foot-flat, so
toes cutting into treads and swings clipping nosings went unseen, and its reactive height made the ankle snap
(516 m/s² against the clip's own 28).

## Honest limitations

- **Stairs:** the clip's 1.44 m stride spans almost five 30 cm treads, so each swing climbs up to 75 cm.
  The layer makes that clean, not natural; a production system would shorten the stride (or pick a stair
  clip — study 09).
- **Descending:** a foot that must clear a nosing just before touchdown lands a few frames late, hovering
  up to 11 cm meanwhile (most of the 1.3 % above). A higher acceleration limit shortens it and makes the drop
  harsher.
- Planning a new contact costs up to ~4 ms once (the nudge search); the steady cost is 0.1–0.2 ms per frame.
- Without **pelvis adjust**, targets below the clip's hips are out of reach and the feet sink — that toggle
  shows why the layer needs it.
- No knee collision with step edges, only feet and lower shins are kept out.

## Data

> The data used in this project was obtained from mocap.cs.cmu.edu.
> The database was created with funding from NSF EIA-0196217.

Clip: subject 02, trial 01 (walk), via the cgspeed BVH conversion by Bruce Hahne.

## References

- R. S. Johansen, *Automated Semi-Procedural Animation for Character Locomotion* (Aarhus University, 2009)
- CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu
