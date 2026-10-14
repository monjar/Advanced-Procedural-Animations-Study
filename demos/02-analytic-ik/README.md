# Analytic IK: Two-Bone & Look-At

Arms and legs are two-bone chains. For those, an iterative solver is unnecessary: there is a closed-form
answer that is exact, branch-free and costs a handful of flops. Almost every engine runs this on every
limb every frame, then layers constraints on top. This study implements the solve and the pieces a
production rig needs around it.

## Law of cosines

With shoulder `S`, target `T`, bone lengths `a` (upper arm) and `b` (forearm), and `d = |T − S|`
clamped to `[|a − b|, a + b]`, the angle at the shoulder between `S→T` and the upper arm is

```
cos α = (a² + d² − b²) / (2·a·d)
```

The elbow is then

```
E = S + dir·(a·cos α) + bend·(a·sin α)
```

where `dir` is the unit vector `S→T` and `bend` is the unit **pole** direction with its component along
`dir` removed. The pole picks which way the elbow points; without it the solution is a circle of valid
elbows. Drag the octahedra to move the poles.

Degenerate cases handled explicitly: target on the shoulder, pole collinear with the target, target
beyond reach (the chain straightens toward it).

## Soft IK

A straight two-bone solve "snaps": as the target approaches full extension the elbow angle changes
infinitely fast (`d(cos α)/dd` blows up near `a + b`), which reads as a pop. Soft IK (Andy Nicholas)
remaps the distance once it passes `chain − softness`:

```
d' = (chain − s) + s·(1 − e^{−(d − (chain − s)) / s})
```

The effector now trails the target slightly near full extension and approaches it asymptotically
(the green circle marks where softening starts, the red line shows the residual error). Optional
**stretch** scales both bones so the effector still reaches the target — common for cartoon rigs.

## Wrist: swing-twist decomposition

The hand follows the target's orientation (press **R** to rotate a target). Its rotation relative to the
forearm is split into

```
q = swing · twist
```

where `twist` is the rotation about the forearm axis and `swing` the remaining rotation of that axis.
The split is what makes anatomical limits expressible: swing is limited by a cone, twist by an angle
range. Real forearms pronate along their length, so a **twist bone** (the distal half, with the orange fin)
takes a share of the twist — at 0 you get the "candy wrapper" collapse at the wrist, at ~0.5 it
distributes.

## Look-at with cone limits

The head aims at a look point, limited to a cone around the torso's forward axis; the eyes aim at the
same point, limited to a narrower cone around the head's forward axis. Out-of-cone directions are
rotated onto the cone rim toward the target (`clampToCone`), and the orientation is built with no roll
(`lookRotation`).

Each layer smooths its look point with the second-order system from study 01: eyes are fast
(`f ≈ 7`), the head is slow (`f ≈ 1.4`). That reproduces the real ordering — the eyes saccade first and
the head catches up — with two parameters instead of an animation.

## Failure modes

- Solving in world space and writing local rotations is where most two-bone bugs hide; this demo
  orients meshes from solved positions (`boneRotation`) and keeps the bend-plane normal as the twist
  reference so bones do not flip.
- When the target crosses the pole axis the bend plane flips. Real rigs blend the pole toward a
  secondary hint or animate it.
- Swing limits on a cone are not anatomical (real joint limits are elliptical / spherical polygons).

## References

- D. Holden, *Simple Two Joint IK* (theorangeduck.com, 2017)
- A. Nicholas, *Soft IK* (Softimage blog, 2009)
- M.-L. Chou, [Game Math: Swing-Twist Interpolation](https://allenchou.net/2018/05/game-math-swing-twist-interpolation-sterp/) (2018)
