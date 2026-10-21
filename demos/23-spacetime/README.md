# Spacetime Constraints

Witkin & Kass (SIGGRAPH 1988) asked a desk lamp to jump. They didn't keyframe the jump; they made the *whole
motion* the unknown, and asked for the one that obeys physics and spends the least muscle effort. The lamp
crouched before take-off, tucked in the air and absorbed the landing, though nobody asked it to. This study
redoes that experiment. Toggle "hand-keyed" to see the same jump keyed by hand, and the force it would need from
nowhere.

## The problem (`spacetime.ts`)

The lamp (`luxo.ts`) is planar: a heavy base, two arm links and a head, joined by three hinges. Its unknowns are
the three joint angles over the whole jump, each a cubic B-spline with 20 control points.

    minimise    ∫ |τ(t)|² dt                    joint torques, by inverse dynamics
    subject to  on the ground: the floor pushes (never pulls), within the friction cone (μ = 0.8), with the
                centre of pressure on the 26 cm sole
                in the air: nothing outside acts on the lamp
                land on the mark, upright; rest pose and stillness at both ends; every joint clear of the floor

**One departure from the paper.** Witkin & Kass made the base a free unknown too, and imposed "no outside force
in flight" as a constraint. Here, the base is not chosen at all:
- On the ground it stands still.
- In the air its motion is integrated from its own equations, M_bb·q̈_b = −(M_bj·θ̈ + h_b), with zero external
  force.

So it goes exactly where the arm flings it, and the flight is Newtonian by construction: the centre of mass falls
at exactly g. My first version did it the paper's way, with penalty constraints in a single least-squares solve.
It settled with the base still receiving a third of the lamp's weight from nowhere at take-off.

**Solving it** takes two stages:
1. CMA-ES (Hansen 2016) explores from an animator's guess to find the right basin. Where the lamp lands depends
   chaotically on how it flings itself, and Levenberg–Marquardt alone stalls in that landscape.
2. Levenberg–Marquardt polishes the result.

Dynamics are recursive planar kinematics (0.4 µs per inverse-dynamics call), checked against virtual work on
numerically differentiated motion.

## Measured

Precomputed by `tools/optimise-jumps.ts`; the page can also optimise a custom jump live, in a Web Worker.

| | hop 30 cm | onto a 10 cm step | long jump 45 cm |
|---|---|---|---|
| lands from the mark | 3 mm | 18 mm | 3 mm |
| floor force: minimum / peak | 10 N / 4.2× weight | 9 N / 5.0× | 14 N / 4.0× |
| friction used (of 0.8) | 0.64 | 0.47 | 0.80 |
| centre of pressure (sole: 13 cm half-width) | 12.3 cm | 11.9 cm | 10.2 cm |
| head dips before take-off | 65 cm | 55 cm | 65 cm |
| optimisation time (Node) | 40 s | 188 s | 90 s |
| **the same jump keyed by hand needs from nowhere** | **2.3× its weight** | **2.2×** | **2.7×** |

**Anticipation emerges.** No crouch was asked for, but in every jump the head swings down 55–65 cm, nearly to the
floor, before the lamp extends. Minimum effort finds the long push-off. The floor's force peaks at four to five
times the lamp's weight just before the base leaves the ground. The animator's starting guess also had a crouch;
the optimiser deepened it a great deal.

**The hand-keyed version looks fine but is impossible.** Its base is carried along a pleasing arc, which needs an
outside push of over twice the lamp's weight in mid-air. That is the "floaty" feel of keyframed jumps,
quantified.

**A failure: the hurdle.** Asked to clear a 7–10 cm bar, the optimiser landed 28 cm short every time, across five
random seeds. Stopping before the bar is a deep local minimum, and clearing it needs a very different jump that
no search found. Witkin & Kass's interactive approach let the animator steer out of such minima.

## Failure modes

- Fixed timing: the stance and flight durations are given, not optimised.
- Contact is a sole on a flat floor; no rolling foot, no compliance.
- Slow: 40–190 s per jump (Node), against seconds per spacetime window in modern trajectory optimisers
  (with analytic derivatives and sparse solvers).

## References

- A. Witkin, M. Kass, *Spacetime Constraints* (SIGGRAPH 1988)
- N. Hansen, *The CMA Evolution Strategy: A Tutorial* (2016)
- I. Mordatch, E. Todorov, Z. Popović, *Discovery of Complex Behaviors through Contact-Invariant Optimization*
  (SIGGRAPH 2012)
- J. T. Betts, *Practical Methods for Optimal Control Using Nonlinear Programming* (2010), for direct collocation
