# XPBD Ropes, Tails & Cloth

Secondary motion that must *collide* — capes, ropes, hair, tails — is beyond the springs of study 01.
The workhorse in games is **position-based dynamics**: move particles, then project constraints
directly on positions. This study implements extended PBD (XPBD) with the "small steps" scheme and
puts it on a walking mannequin, a rope bridge and a side-by-side stiffness lab.

## The solver

Per frame, `substeps` times:

1. **Predict:** `v += (g + a_ext)·h`, `x += v·h` (remember `x_prev`)
2. **Pins:** move kinematic particles to their (interpolated) targets
3. **Project constraints:** reset every Lagrange multiplier `λ`, then for each distance constraint
   `C = |x_a − x_b| − rest`:

```
α̃  = α / h²                      (α = compliance, m/N)
Δλ = (−C − α̃·λ) / (w_a + w_b + α̃)
x_a += w_a·Δλ·n     x_b −= w_b·Δλ·n     λ += Δλ
```

4. **Collide:** ground plane, spheres and capsules, with a simple positional friction
5. **Velocity:** `v = (x − x_prev) / h`, damped

## Why X(PBD)

Classic PBD scales each correction by a stiffness `k ∈ [0, 1]`. The result depends on the iteration
count and time step — run more iterations and the material gets stiffer. XPBD replaces `k` by a
**compliance** `α` with physical units; the `α̃λ` term makes the solve converge to the actual elastic
equilibrium, so stiffness becomes a material property.

The **stiffness lab** makes this visible. Four ropes with increasing compliance hang from a bar; the
labels show their stretch. In XPBD mode, change *substeps* and *iterations*: the stretch stays put. Switch
to PBD: the same ropes get stiffer as you add work. The unit tests pin this down — a 2 kg mass on a
constraint with `α = 0.01 m/N` settles at `m·g·α = 19.6 cm` within 2 % for 5, 20 or 40 substeps.

## Small steps

Macklin et al. (2019) showed that, for a fixed budget, **many substeps with one iteration** beats
few substeps with many iterations: errors shrink with `h²`, and collisions are detected more often.
The default here is 10 substeps × 1 iteration.

## Scenes

- **Cape on a walker:** 13×17 cloth with structural, shear and bending (skip-one) constraints, top row
  pinned across the shoulders of a kinematic mannequin. The mannequin's limbs are capsule colliders.
  Speed it up and the cape lifts; the lean into the turn swings it outward. Wind uses a per-triangle
  aerodynamic term (normal component of relative wind), not a uniform force, so the cloth flaps.
- **Rope bridge:** deck ropes with 3.5 % slack carry heavy planks; hand ropes hang from the posts and are
  tied to the deck by suspenders. A boulder (sphere collider) rolls across — drag it with the gizmo.
- **Stiffness lab:** see above.

Grab any free particle with the mouse; it becomes a kinematic pin until released.

## Failure modes

- No self-collision: the cape can pass through itself in extreme poses.
- Positional friction is per-substep and approximate.
- Pins interpolated across substeps avoid energy spikes from fast-moving anchors; snapping pins instead
  makes the cape jitter when the walker turns quickly.
- Bending via skip-one distance constraints is cheap but anisotropic; dihedral-angle bending is the
  accurate alternative.

## References

- M. Müller, B. Heidelberger, M. Hennix, J. Ratcliff, *Position Based Dynamics* (VRIPHYS 2006 / JVCIR 2007)
- M. Macklin, M. Müller, N. Chentanez, *XPBD: Position-Based Simulation of Compliant Constrained
  Dynamics* (MIG 2016)
- M. Macklin, K. Storey, M. Lu, P. Terdiman, N. Chentanez, S. Jeschke, M. Müller, *Small Steps in Physics
  Simulation* (SCA 2019)
