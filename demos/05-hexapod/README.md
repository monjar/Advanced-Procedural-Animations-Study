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

## Failure modes

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
