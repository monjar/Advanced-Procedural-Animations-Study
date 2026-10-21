# Character Crowds

Study 11 had sixteen thousand fish that only needed to look like a school. People in a crowd need more: they
shouldn't walk through each other or through walls, and they still have to get where they are going. This study
puts the two classic answers side by side on the same procedural walkers, in four scenes: a circle swap, two
groups crossing, a room emptying through one door, and two streams meeting in a corridor.

## Two models

**ORCA** (van den Berg, Guy, Lin & Manocha 2011), ported from the reference RVO2 library, works in
*velocity space*.

- For each neighbour, the relative velocities that would collide within the next 2 s form a truncated cone:
  the velocity obstacle.
- The agent takes half the smallest change that leaves the cone, and its neighbour, running the same rule,
  takes the other half. That half is the "reciprocal" part: when both agents dodge fully, they oscillate.
- Each half becomes a half-plane of allowed velocities. Walls add half-planes that must hold exactly.
- An incremental 2-D linear program picks the allowed velocity closest to the one the agent wants. When a
  dense crowd leaves no allowed velocity at all, a 3-D LP picks the one that violates the agent constraints
  least.

Click a person to see their half-planes.

**Social forces** (Helbing & Molnár 1995; Helbing, Farkas & Vicsek 2000) work in *force space*. People are
particles:

- driven toward the velocity they want (τ = 0.5 s);
- pushed apart by exponential repulsion (A = 2000 N, B = 0.08 m) from each other and from walls;
- once they touch, also subject to body compression and sliding friction (k = 1.2·10⁵, κ = 2.4·10⁵).

Collisions are penalised, not forbidden.

Both models share the same navigation. People follow waypoints: a doorway counts as passed once they are
through it. They slow over their last metre, and leave the scene at exits. The preferred velocity also gets a
1 cm/s random perturbation, which breaks the perfect symmetries in which ORCA can deadlock.

## Walkers

One instanced mesh per body part: torso, head, thighs, shins, arms. Any number of people takes five draw
calls. The gait is driven by the agent's actual speed, not by time. The phase advances by π per step, and the
step length grows with speed (≈ 0.45 + 0.2·v m, about 1.8 steps/s at 1.3 m/s). So the feet keep pace with the
ground, and the legs stop when the agent stops. Heading follows velocity through a critically damped spring,
because ORCA can change a velocity sharply from one step to the next, and a body that snapped to each change
would twitch. Each body leans forward with speed and banks into turns.

## Measured

Three seeds each, 60 Hz, preferred speeds 1.3 ± 0.15 m/s. "Wiggle" is total heading change per metre walked.

| scene | everyone through (s), ORCA · social | wiggle (rad/m) | path efficiency | deepest overlap |
|---|---|---|---|---|
| circle swap, 48 | **21.1** · 33.0 | **0.48** · 1.08 | **0.95** · 0.85 | 1.1 · 2.8 cm |
| crossing, 60 | **30.2** · 34.5 | **0.22** · 0.32 | **0.98** · 0.94 | 0.2 · 0 cm |
| doorway, 60 | **38.9** · 47.5 | **0.47** · 1.59 | 0.91 · 0.92 | 0.7 · 1.6 cm |
| corridor, 60 | **39.2** · 55.8 | **0.19** · 1.11 | **0.98** · 0.91 | 0.7 · 0.7 cm |

Times are medians across seeds; wiggle and efficiency are means; overlap is the deepest in any seed. No one
entered a wall in any run.

**At walking pace, ORCA wins.** In every scene, everyone gets through sooner, with between two-thirds and a
sixth of the wiggle. Its overlaps (≤ 1.1 cm) come from discrete time steps; ORCA is exact only in continuous
time.
Social-force people rarely touch either, but they keep correcting against each other's repulsion fields, and it
shows.

**Hurry them through a door and the order flips.** 90 people, one 1.2 m door:

| hurry × | ORCA: everyone out | overlap (pair·s) | social forces: everyone out | overlap |
|---|---|---|---|---|
| 0.8 | 64.5 s | 0 | 74.6 s | 0 |
| 1 | 52.3 s | 0 | 59.8 s | 0.1 |
| 2 | 38.0 s | 2.2 | **30.3 s** | 12.4 |
| 3 | 37.3 s | 16 | **25.4 s** | 63, bodies up to 7.7 cm deep |

Social-force people push: their bodies compress and they squeeze through. ORCA people wait their turn, so
hurrying them barely helps past 2×. Even then they overlap once the LP runs out of collision-free velocities
and relaxes. Which behaviour is right depends on the crowd. A queue at a ticket gate is ORCA; a crush is not.
Neither model reproduced Helbing's "faster is slower" clogging at these settings.

**ORCA's time horizon** trades foresight against freedom. With 0.5 s, people react late and swerve. One of
three circle swaps deadlocked, and corridor runs took up to 71 s. Between 2 s and 4 s the results barely change.

| | 60 people | 180 | 360 |
|---|---|---|---|
| ORCA, ms per 60 Hz step | 0.27 | 1.4 | 3.8 |
| social forces (10 substeps) | 0.41 | 1.8 | 4.7 |

Neighbours are found by brute force, which is fine at this scale. A grid would take over beyond a few hundred.

## Failure modes

- ORCA is polite to a fault. Nobody ever pushes, so dense crowds look too orderly, and a standing agent
  surrounded on all sides can't be passed.
- Symmetric standoffs can deadlock ORCA. The random perturbation breaks most of them; a short horizon makes
  them likelier.
- Social forces need small time steps (here 10 per frame), and their parameters trade wiggle against
  overlap. No setting removes both.
- Navigation is waypoints only. Real pedestrians plan around congestion, choose doors, and walk in groups.

## References

- J. van den Berg, S. J. Guy, M. Lin, D. Manocha, *Reciprocal n-Body Collision Avoidance* (ISRR 2011), and
  the RVO2 library
- J. van den Berg, M. Lin, D. Manocha, *Reciprocal Velocity Obstacles for Real-Time Multi-Agent Navigation*
  (ICRA 2008)
- D. Helbing, P. Molnár, *Social Force Model for Pedestrian Dynamics* (Phys. Rev. E 1995)
- D. Helbing, I. Farkas, T. Vicsek, *Simulating Dynamical Features of Escape Panic* (Nature 2000)
- C. W. Reynolds, *Steering Behaviors for Autonomous Characters* (GDC 1999)
