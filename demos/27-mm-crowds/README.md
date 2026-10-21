# Motion-Matched Crowds

Study 19's crowds steer with ORCA but walk on procedural legs that go exactly where they are told. This study
gives every person a mocap body, driven by study 09's motion matching (or study 16's learned version). It then
asks the question every crowd system with real animation has to answer: **who is in charge, the avoidance or
the animation?**

## Two couplings (`mmcrowd.ts`)

**Animation-driven.**
1. ORCA plans each agent's velocity from where its *body* is.
2. That velocity becomes the motion-matching input.
3. The body moves by its mocap's own root motion.
4. Where the body's root ends up is the agent's position for the next plan.

Feet stay planted, because the animation is the truth. But a motion-matched body can't change velocity at once:
it changes clip on a search, and turns as fast as the mocap turned.

**Simulation-driven.** ORCA moves its agents itself, collision-free. Each body is steered toward its agent and
then pulled the rest of the way, by at most **pull** × its own speed per step (study 09's "adjustment by
velocity"). A strong pull keeps bodies on their agents and makes feet slide; a weak pull keeps feet planted
and lets bodies lag into each other.

## Measured

Database bodies with foot locking, 60 Hz. The overlap is between the *bodies*, measured on their root positions
with a radius of 0.25 m:

| scene (people) | coupling | bodies overlap (pair·s) | deepest | feet slide while planted |
|---|---|---|---|---|
| circle swap (24) | animation-driven | 41 | 46 cm | 15 cm/s |
| | pulled, 1× own speed | 40 | 49 cm | 17 cm/s |
| | pulled, 2× | 19 | 47 cm | 25 cm/s |
| | pulled, 4× | **0** | 0 | 30 cm/s |
| crossing (36) | animation-driven | 53 | 47 cm | 15 cm/s |
| | pulled, 1× | 130 | 49 cm | 17 cm/s |
| | pulled, 2× | 51 | 49 cm | 24 cm/s |
| | pulled, 4× | **0** | 0 | 28 cm/s |
| corridor (36) | animation-driven | 84 | 49 cm (25 cm into a wall) | 14 cm/s |
| | pulled, 4× | **0** | 0 | 32 cm/s |

**There is no free setting.**
- **Animation-driven:** people walk into each other, and even into walls. ORCA's guarantee holds for velocities
  it can set, and these bodies can't take them.
- **A light pull is worst of all.** The bodies lag their agents, and the agents are planned as if the bodies
  weren't there.
- **Collision-free:** needs a pull of about four times the body's own speed, and roughly doubles foot sliding
  (28–32 cm/s against 14–15).

Production crowds live in this tension. They add avoidance-aware animation selection (searching for clips that
fit the avoidance velocity), or they accept a little interpenetration.

**What the bodies cost:**

| | per person per step | memory | at 1 ms per frame |
|---|---|---|---|
| motion matching (database search with AABB, study 09) | **16 µs** | 7.1 MB, shared | ~60 people |
| learned motion matching (study 16) | ~300 µs | 0.73 MB, shared | ~3 people |

Study 16 found the networks ten times smaller and ten times slower than the database. In a crowd the memory is
shared by everyone, so the smaller size buys nothing, while the CPU cost is paid per person. On a database this
size, the crowd is the case for the database.

## Failure modes

- Overlap is measured on roots; arms and swinging legs pass through each other regardless.
- The motion database has no side-steps or backward walking, so dodges can only be turns.
- ORCA's radius is a fixed 0.25 m, though a body's footprint changes with its stride.

## References

- J. van den Berg et al., *Reciprocal n-Body Collision Avoidance* (2011)
- S. Clavet, *Motion Matching and The Road to Next-Gen Animation* (GDC 2016)
- D. Holden, *Code vs Data Driven Displacement* (2021)
- S. Paris, J. Pettré, S. Donikian, *Pedestrian Reactive Navigation for Crowd Simulation* (Eurographics 2007)
