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
4. **Swing.** Smoothstepped interpolation from the old to the new foothold plus a lift along the body's up
   axis; the landing point keeps tracking the target while airborne.
5. **Body pose.** Up is driven toward the normal of the polygon through the feet, blended with a downward
   body probe and — strongly — a forward probe that sees walls coming. Height is held above the probed
   surface, with a slight dip while legs are in the air.
6. **Legs.** Coxa fixed outward, then femur + tibia by the analytic two-bone IK from study 02, pole above
   and outside the hip so knees arch up like an arachnid's.

## What to look at

- **Footfalls panel** — filled bars are stance. Tripod shows the alternating 3/3 pattern; wave shows one
  foot in the air at a time (slow but statically stable).
- **Debug → raycast probes** colours each leg's ray by which probe found the foothold
  (blue: hip→home / wall, green: down, yellow: under-edge). Watch them switch at the climbing wall.
- **Overshoot** — 0 places feet at home, so they trail behind at speed; ~0.7 lands them ahead and the
  stride evens out.

## Failure modes

- Thin features narrower than the probe spacing can be missed or straddled.
- The forward probe makes wall transitions robust but can also make the body pitch up at small steps.
- Waypoint steering is disabled on steep surfaces (a waypoint behind a wall would turn the spider back
  down), so the auto mode climbs straight over obstacles.
- No collision between legs and geometry: a tibia can clip a crate corner during a swing.

## References

- J. Jakobsson & J. Primate, *The Rain World Animation Process* (GDC 2016)
- D. Rosen, *An Indie Approach to Procedural Animation* (GDC 2014)
- three-mesh-bvh (G. Johnson) for BVH-accelerated raycasts
