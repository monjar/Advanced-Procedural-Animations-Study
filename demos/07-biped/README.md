# Procedural Biped

David Rosen's Overgrowth talk showed that convincing locomotion needs surprisingly little data: a couple
of key poses per gait, interpolated by a **stride wheel**, with physics-like springs and IK layered on top.
This study rebuilds that recipe for a mannequin that walks, runs, sprints and stops on uneven ground —
with no animation clips.

## Stride wheel

The cycle phase advances with **distance travelled**, not time:

```
φ += v / L(v) · dt
```

`L` is the stride length (two steps), growing with speed and blended between a walk and a run curve. Because
the phase is tied to distance, the feet cannot skate: if the character slows down, the wheel slows down.
The panel draws the wheel — the pointer is `φ`, the coloured arcs are each foot's stance, the dots are the
key poses.

## Key poses

A gait is a few poses for **half** a stride (right foot contact at `φ = 0`), mirrored for the other half:

| gait | keys | what they encode |
|---|---|---|
| walk | contact (0), passing (0.25) | pelvis low in double support, high over the stance foot; arm counter-swing |
| run | contact (0), mid-stance (0.14), flight (0.36) | compression at mid-stance, highest in flight, forward lean, bent elbows |

A pose only describes the **upper body and pelvis**: drop, lateral sway, roll (the swing hip drops), yaw,
chest counter-twist, lean, shoulder pitch and elbow bend. Between keys the values are smoothstepped; walk and
run are blended by speed, and both blend to a neutral standing pose (with breathing) as speed → 0.

## Legs are not keyframed

- **Planting:** each foot lifts when its phase crosses the duty factor (0.62 walking → 0.27 sprinting) and lands
  half a stance ahead of the hip. While planted it is fixed in the world.
- **Swing:** interpolated relative to the body (as in study 06), with an arc that grows with speed. The foot
  rolls: heel-off pivots on the toe late in stance, toe-down after push-off, toe-up before heel strike.
- **IK:** hip → knee → ankle by the analytic two-bone solver, knee toward the direction of travel.
- **Reach clamp:** the pelvis is lowered just enough for both ankles to be reachable. Walking this gives the
  natural double-support dip (~3 cm); at 5 m/s about 9 cm. Lowering the duty factor at sprint speeds was
  needed to keep that dip from turning into a crouch (it was 23 cm before).

## Springs

- The **pelvis** height runs through a second-order system (study 01) — landings compress, stops settle.
- The **chest** orientation lags the pose through a spring on its up vector, and leans with filtered
  acceleration: it pitches forward when speeding up and rocks back when stopping.
- The **head** height is filtered so the gaze stays level over the bob; it turns into the turn first.

## Failure modes

- Turning on the spot is handled by "tidy-up" steps, not a dedicated turn-in-place cycle.
- The pose set is tiny on purpose; there is no start/stop transition animation, only blending.
- Stairs and steep slopes need foot orientation from the surface normal (study 08 does this for mocap).

## References

- D. Rosen, *An Indie Approach to Procedural Animation* (GDC 2014)
- R. S. Johansen, *Automated Semi-Procedural Animation for Character Locomotion* (Aarhus University, 2009)
