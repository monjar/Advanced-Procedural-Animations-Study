# Iterative IK Lab

Closed-form IK (study 02) stops at two bones. Spines, tails, tentacles, fingers and robot arms need an
iterative solver. The three standard families are solved here on **identical chains with identical
joint limits**, side by side, from the same target.

All three operate on the same representation: a serial chain of local joint rotations (`Chain`),
with forward kinematics

```
R_i = R_{i-1} · q_i
P_{i+1} = P_i + R_i · bone_i
```

and the same constraint projection after every update — **ball** joints are split into swing and twist
about the bone (study 02) and each is clamped; **hinge** joints keep only the twist about their axis,
clamped to a range.

## CCD — Cyclic Coordinate Descent

Walk from the tip to the root; at each joint rotate so that `joint → effector` points at
`joint → target`. Hinges rotate only about their axis (both vectors are projected onto the hinge
plane first).

- Cheap, trivially handles limits, converges fast when close.
- Characteristic artefact: the tip joints do most of the work, so chains **curl** at the end and
  motion looks unnatural. The *max step* control damps each visit — slower convergence, nicer
  poses.

## FABRIK — Forward And Backward Reaching IK

Aristidou & Lasenby's position-space solver:

1. **Backward:** put the effector on the target, then pull every joint toward its child, keeping bone
   lengths.
2. **Forward:** pin the root, then push every joint back out toward its parent.

Vanilla FABRIK is positions-only, which makes twist and hinge limits awkward. Here the forward pass is
done **as rotations**: each joint is rotated (minimal rotation) so its bone aims at the backward-pass
position, then projected onto its limits, then forward kinematics place the next joint. FABRIK
therefore obeys exactly the same constraints as the other two.

The limits must also be applied in the **backward** pass: each bone is clamped into the cone of the joint
below its child, relative to the child bone. Without that step the backward pass keeps proposing shapes
the forward pass cannot realise. Measured on this 12-joint tentacle with 30° cones, the mean residual
after 40 iterations dropped from **28.6 mm to 0.01 mm** once the backward pass was constrained.

One honest caveat shows up on the robot arm: a **yaw** joint whose bone lies on its own axis cannot be
aimed by bone direction at all. Those joints fall back to a CCD-style step against the target.

**Multi-effector:** the *tree* scenario uses the sub-base extension — in the backward pass a joint
shared by several branches is placed at the centroid of its children's proposals, then the forward
pass re-extends every branch from the root. This is where FABRIK is clearly the most convenient of the
three.

## Jacobian — transpose, pseudo-inverse, damped least squares

Linearise effector motion with respect to joint angles. Ball joints contribute three columns (world
x/y/z), hinges one:

```
J_k = a_k × (effector − P_joint)
```

| method | update | behaviour |
|---|---|---|
| transpose | `Δθ = α·Jᵀe` | always stable, slow, needs Buss' step size `α` |
| pseudo-inverse | `Δθ = Jᵀ(JJᵀ)⁻¹e` | fast near the solution, **explodes near singularities** |
| DLS | `Δθ = Jᵀ(JJᵀ + λ²I)⁻¹e` | trades a little accuracy for stability |

With a single positional effector `JJᵀ` is 3×3 regardless of how many joints there are, so the
"expensive" solver is cheap. The error vector is clamped per iteration (10 % of chain length) — without
that, DLS with small `λ` limit-cycles on unreachable targets.

Watch the target leave the workspace (it does so periodically) with **pseudo-inverse** selected: the
chain straightens, `JJᵀ` loses rank along the chain and the solution oscillates. DLS with `λ ≈ 0.1`
rides through it.

## Reading the panels

- **Per-frame solve:** iterations used, residual and time per solve at the current *iterations/frame*
  budget. With *warm start* each solve begins from last frame's pose — the normal setting for
  animation, and the reason all three look fine at 8 iterations.
- **Convergence from rest:** the same target solved from the rest pose, error per iteration on a log
  scale. This is the honest comparison: CCD and FABRIK drop fast and plateau where limits bind;
  DLS converges more evenly; transpose crawls.

## Failure modes

- CCD tip curl; FABRIK's weak handling of axis-aligned hinges; pseudo-inverse singularities; Jacobian
  methods' dependence on step clamping.
- Hard joint limits applied by projection after each step can stall any of them in a corner of the
  workspace. Production solvers add limits to the optimisation (null-space projection, or QP).
- None of these solve for orientation goals here; adding a 3-row orientation block to `J` is the
  standard extension.

## References

- A. Aristidou & J. Lasenby, *FABRIK: A fast, iterative solver for the Inverse Kinematics problem*,
  Graphical Models 73(5), 2011
- S. Buss, *Introduction to Inverse Kinematics with Jacobian Transpose, Pseudoinverse and Damped Least
  Squares Methods* (2004)
- L.-C. T. Wang & C. C. Chen, *A combined optimization method for solving the inverse kinematics problem
  of mechanical manipulators*, IEEE Trans. Robotics and Automation, 1991 (CCD)
