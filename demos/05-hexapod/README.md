# Procedural Hexapod

A six-legged walker with no animation data at all: every step is decided at runtime from raycasts.
The same controller walks hills, climbs crates, goes up a wall, over its top edge, down the far face
and back onto the floor — verified headlessly in the unit tests, not just eyeballed.

## Layers

1. **Body motion.** The body translates along its own forward axis and turns about its own up axis.
   It never consults world up, which is what lets it walk on walls.
2. **Foot targets.** Each leg has a *home* point in the body frame (offset by the predicted motion over
   one step). Three rays find a foothold near it:
   - **hip → home** — something between the hip and the home point (a wall ahead): plant on it.
   - **down through home** (body frame) — the normal case.
   - **from below home back toward the body** — the home point is past a convex edge: wrap around it and
     plant on the face below.
3. **Gait arbitration.** Legs are grouped (tripod: 2 groups of 3; ripple: 3 × 2; wave: 6 × 1). Only one
   group may swing at a time; the group whose worst foot is furthest past the *step threshold* goes next.
   When the body stops, a lower threshold tidies the stance after a short pause. A foot that falls far
   behind (fast turns) may step out of turn.
4. **Swing.** A quadratic Bézier from the old to the new foothold that bulges along the **mean of the two
   surface normals**, so a step from the floor onto a wall (or over a box edge) arcs away from the corner
   instead of cutting through it. The landing point tracks the target while airborne and snaps to the real
   foothold on touchdown; a cast from the hip keeps the swinging foot from ever ending up behind a surface.
   Feet rest on the surface along its normal (`hit + n·r`), not half inside it.
5. **Body pose.** Up is driven toward the normal of the polygon through the feet, blended with a downward
   body probe and — strongly — a forward probe that sees walls coming. Height is held above the probed
   surface, with a slight dip while legs are in the air. A **clearance pass** then casts from the body centre
   to ~60 points on the thorax, abdomen, head and hip sockets and pushes the body out of anything in between.
6. **Legs.** Coxa fixed outward, then femur + tibia by the analytic two-bone IK from study 02, pole above
   and outside the hip so knees arch up like an arachnid's.

## What to look at

- **Footfalls panel** — filled bars are stance. Tripod shows the alternating 3/3 pattern; wave shows one
  foot in the air at a time (slow but statically stable).
- **Debug → raycast probes** colours each leg's ray by which probe found the foothold
  (blue: hip→home / wall, green: down, yellow: under-edge). Watch them switch at the climbing wall.
- **Overshoot** — 0 places feet at home, so they trail behind at speed; ~0.7 lands them ahead and the
  stride evens out.

## Measured, not eyeballed

An exact inside/outside test of the level geometry (independent of the raycaster) audits a minute of
auto-wander in the unit tests. The first version of this study looked fine at a glance but measured badly:

| | before | after |
|---|---|---|
| deepest planted foot | 37 cm | < 4 cm (terrain-mesh interpolation) |
| leg-frames with a foot > 1 cm deep | > 50 % | < 1 % |
| deepest body point | 31 cm | < 6 cm, < 1 % of frames over 2 cm |
| longest time a leg has no foothold (25–60 fps jitter) | 0.7 s | < 1 s (2.5 s mid-fix, see below) |

One intermediate fix made things worse in a way only a second metric caught: fitting the body plane through
the *current* foot positions let clamped, arcing swing feet roll the body over, after which the probes found
nothing and legs were left 3 m behind. The plane now uses footholds (planted feet and landing points), and the
test suite runs the playground with jittery frame times to keep it honest.

The causes, in order of impact: feet centred *on* the surface; probes that started inside a solid (crates sunk
into the terrain, the ramp's end inside its platform) landing on buried faces — a short double-sided ray out of
each candidate foothold along its normal now rejects it if it first meets the back of a face; swings cutting
corners; and nothing keeping
the abdomen out of the floor when the body pitches onto a wall.

## Standing still

The first version walked well and stood badly: stopped anywhere near a crate, the ramp or the wall, its legs
never stopped moving. An audit that walks, stops, settles and then watches the stance (30 stops all over the
playground, at 30–240 Hz) found four separate feedback loops, each invisible on flat ground:

1. **Stepping at the unreachable.** The down probe picked the ground beside a crate a metre below the hip; the
   out-of-reach rule stepped the leg to the same foothold, which was still out of reach, forever. Standing
   feet now prefer a foothold in reach (the search moves in toward the body and finds the crate top), and the
   emergency step only goes somewhere *else*.
2. **Foothold ↔ body tilt.** At edges the best foothold depends on the body's tilt, and the tilt depends on the
   footholds: a foot lands, the body tilts, the best foothold flips back. Standing, each leg now gets one
   settling step (plus any step that brings an out-of-reach foot into reach, which cannot repeat), and settling
   swings commit to the foothold chosen at take-off.
3. **Probe ↔ body tilt.** The forward and down body probes' hit normals depend on the body's own tilt, and at a
   crease they flip as it tilts, rocking a standing body by degrees per frame. They anticipate walls for a
   walking body; standing, their weight fades out.
4. **Landing snaps.** Swing clamps moved the foot to wherever a ray from the hip first met a surface, which
   near touchdown on a hill was up to 20 cm short; the landing frame snapped it onto the foothold. Feet (and
   leg tips short of an out-of-reach foothold) are now pushed out of solids along the shortest way out, only
   when really inside, and a swing whose foothold moved keeps flying to it instead of teleporting.

| standing, 30 stops at 60 Hz, after settling | before | after |
|---|---|---|
| stops that never settle | 1 | 0 (all within 2.4 s) |
| steps while standing | 17 | 0 |
| fastest joint motion of a planted leg | 74 cm/frame | < 1 mm/frame |
| foot tip off its foothold | 26 cm | < 1 cm |
| foot tip inside geometry | 14 cm | < 2 cm |

Walking got smoother too: one-frame pops (a foot tip's motion changing by more than 10 cm between frames)
fell from 724 to about 140 per minute of wander, and the deepest swinging foot from 18 cm to 2 cm. A tempting
intermediate version that tracked moving footholds exactly made the body plane follow every flip of the raycast
target and rolled the spider off an edge in 3 of 40 long runs; the tracking is smooth early in the swing and
stiffens toward touchdown instead (0 of 40, as before).

## Failure modes

- Most remaining pops are at the top of the 80 cm-thick climbing wall: a foot wrapped onto the far face is out
  of reach, and the leg tip alternates between reaching it through the edge and resting on the top. Fixing that
  needs IK that bends the leg around the edge.
- Thin features narrower than the probe spacing can be missed or straddled.
- The forward probe makes wall transitions robust but can also make the body pitch up at small steps.
- Waypoint steering is disabled on steep surfaces (a waypoint behind a wall would turn the spider back
  down), so the auto mode climbs straight over obstacles.
- No collision for the leg segments themselves: a tibia can still clip a crate corner while wrapping over an
  edge, and for a frame or two after a foot falls out of reach the leg tip can sit short of its foothold.

## References

- J. Jakobsson & J. Primate, *The Rain World Animation Process* (GDC 2016)
- D. Rosen, *An Indie Approach to Procedural Animation* (GDC 2014)
- three-mesh-bvh (G. Johnson) for BVH-accelerated raycasts
