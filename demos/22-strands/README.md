# Hair & Tentacles

Study 04's ropes are chains of points: they bend, but they can't twist, and they have no sense of which way is
up along the strand. Hair, cables and octopus arms need both. This study uses **Cosserat rods**: every segment
carries an orientation as well as two endpoints, solved with XPBD. It shows three scenes: a head of hair, an
octopus whose arms reach the way a real octopus's do, and a twisted rod that buckles.

## The rod (`rod.ts`)

Kugelstadt & Schömer, *Position and Orientation Based Cosserat Rods* (2016), with XPBD compliance (Macklin et
al. 2016) and small substeps:

- **Stretch–shear:** (xᵢ₊₁ − xᵢ)/l − d₃(qᵢ) = 0. Each segment lies along its frame's third axis, at rest length.
- **Bend–twist:** Im(q̄ᵢ qᵢ₊₁) − Ω⁰ᵢ = 0. Neighbouring frames keep their rest Darboux vector: x and y are
  bending, z is twisting.

The rest Darboux vectors are the rod's natural shape. A straight strand has zeros. Curly hair has a constant
curvature plus torsion, which makes a helix. An octopus arm changes its Darboux vectors over time, as muscle.
With compliance α, Im(q̄q′) ≈ κl/2, so the bending stiffness is EI = l/(4α).

## Measured

**Stiffness is what the compliance says, once converged.** A 20-segment cantilever under gravity, against the
exact deflection of the same discrete chain:

| α | 1 iteration / substep | 4 | 16 |
|---|---|---|---|
| 3·10⁻³ | 1.51× | 1.01× | **1.00×** |
| 1·10⁻³ | 2.54× | 1.16× | **1.00×** |
| 3·10⁻⁴ | 6.15× | 1.97× | **1.06×** |

(40 substeps per frame.) Converged, the deflection is exact. Under-converged, stiff rods sag far more than they
should, so stiffness again depends on iteration count, which is the problem XPBD was meant to solve. Small steps
help, but a long stiff chain still needs many Gauss–Seidel passes, because information travels one segment per
pass.

**A factor of two in the paper's update.** At first the converged cantilever came out exactly twice as stiff
as the compliance said. Working through both constraints in terms of rotation angle showed why:
- The stretch–shear update q ← q + w_q·l·(γ,0)·q·ē₃ turns d₃ by 2·w_q·l·γ.
- Its own denominator assumes 4·w_q·l·γ.
- The bend–twist update's rotation implies the same inverse inertia as that denominator.

So the two constraints disagreed about the frames' inertia, and the static shape shifted. Doubling the
stretch–shear quaternion step makes them consistent. Its denominator was already right.

**Twist buckles a rod, roughly where Greenhill says.** One end is clamped, and the other is clamped in angle
but free to slide along its axis. Greenhill's 1883 analysis says the rod buckles under a twisting moment of
2.86π·EI/L, which here is 1.43·α_twist/α_bend turns. Twisting slowly (0.05 turns/s, converged):

| α_twist / α_bend | predicted (turns) | measured onset |
|---|---|---|
| ½ | 0.71 | 0.77–1.21 |
| 1 | 1.43 | 1.49–1.93 |
| 2 | 2.86 | 2.97, or not by 4 turns |

The onset follows the theory in direction and size, but it is noisy. Near the threshold, a tiny imperfection
grows very slowly, so detection lags behind the actual loss of stability, by different amounts in different
runs. The best runs land within 4–8%. Past buckling, the coiling isn't reliable either: the twist can slip by
two full turns, so the page stops twisting once the rod buckles.

**Hair stands up or falls over for the right reason.** A strand pointing up is a column loaded by its own
weight, and it buckles over once it is longer than L = (7.84·EI/q)^⅓. That is about 10 cm for real hair
(EI ≈ 8·10⁻⁹ N·m²), which is why long hair falls and short hair stands. The page's stiffness slider sets this
length directly. The first version gave 34 cm strands a stand-up length of 42 cm, and the character's hair stood
straight out; the physics was right and the parameters were wrong.

## Scenes

- **Hair:** about 400 strands of 14 segments, rooted on the scalp and following the head's motion. They collide
  with the head, neck and shoulders, blow in a gusty wind, and curl when given a helical rest shape. Drag the
  head, or let it shake.
- **Octopus:** eight 18-segment arms underwater (weak gravity, strong drag), idling with slow curling waves.
  Click, and the nearest arm reaches by *bend propagation* (Gutfreund et al. 1996): the curled arm is aimed at
  its base, and a bend point runs out to the tip, straightening the arm behind it. The tip then curls to grasp.
  The suckers are drawn along the material frame, so twist is visible.
- **Twisted rod:** the Greenhill experiment. A stripe along d₁ turns into a helix as the rod twists.

## Failure modes

- Gauss–Seidel convergence: long, stiff rods need many iterations. Deul et al.'s direct solver (2018) solves
  each rod exactly in linear time.
- No hair–hair contact, so hair has no volume of its own.
- Post-buckling twist can slip; self-contact is particle against particle.

## References

- T. Kugelstadt, E. Schömer, *Position and Orientation Based Cosserat Rods* (SCA 2016)
- M. Macklin, M. Müller, N. Chentanez, *XPBD: Position-Based Simulation of Compliant Constrained Dynamics*
  (2016); M. Macklin et al., *Small Steps in Physics Simulation* (SCA 2019)
- C. Deul, T. Kugelstadt, M. Weiler, J. Bender, *Direct Position-Based Solver for Stiff Rods* (CGF 2018)
- A. G. Greenhill, *On the strength of shafting when exposed both to torsion and to end thrust* (1883)
- Y. Gutfreund et al., *Organization of octopus arm movements: a model system for studying the control of
  flexible arms* (J. Neurosci. 1996)
- M. Bergou et al., *Discrete Elastic Rods* (SIGGRAPH 2008)
