# Phase-Functioned Locomotion

Holden, Komura & Saito's phase-functioned neural network (PFNN, SIGGRAPH 2017) made one change to a plain
network that predicts the next frame of motion: its weights are not fixed but a cyclic function of the gait
**phase**. In effect it is a different network at every point of the walk cycle. Their argument was that a plain
network averages poses from different points of the cycle, and the motion goes limp. This study tests that claim
on the CMU data from studies 09 and 16. Both networks are trained the same way and run side by side: PFNN (gold)
on the left, a plain network with the same layers on the right.

## The networks (`training/pfnn/train_pfnn.py`, `pfnn.ts`)

Each frame both see the same input, in the character's own frame (176 numbers):
- the trajectory, half a second back and ahead (positions and facings);
- a walk/run label;
- their own previous output: 25 joint positions and velocities.

They predict the next frame (309 numbers):
- study 16's pose vector: hips, 6-D joint rotations, root motion, foot contacts;
- the joints for next time;
- how far the phase advances.

The phase is labelled from the foot contacts: 0 at each left touch-down, 0.5 at each right one.

|                | PFNN | plain |
|---|---|---|
| layers         | 176 → 256 → 256 → 309, ELU | same, plus the phase as (sin, cos) |
| weights        | four sets, blended by a cyclic Catmull–Rom spline of the phase: W(p) = Σₖ cₖ(p)·Wₖ | one set |
| parameters     | 762,068 | 191,029 |
| CPU per frame (browser) | 0.73 ms | 0.19 ms |

Both are trained in 80 s on a CPU, on 7,204 frames (two minutes of mocap, mirrored), with every tenth take held
out.

## Measured

| | PFNN | plain | the mocap |
|---|---|---|---|
| one-step error on held-out takes (normalised) | 0.144 | **0.137** | |
| knee flexion while running | **20–93°** | 25–83° | 20–107° |
| knee flexion while walking | 17–67° | 18–67° | 0–70° |
| walk 1.3 m/s, turn, run 3.2 m/s, walk back (medians) | 1.27 · 1.24 · 2.66 · 1.18 m/s | 1.14 · 1.12 · 2.78 · 1.10 m/s | |
| facing error after each turn | ≤ 5° | ≤ 4° | |

**The claim holds where it matters.** On one-step prediction the plain network is slightly *better*: PFNN has
four times the parameters and overfits two minutes of data more. But run closed-loop, feeding on its own output
frame after frame, the plain network bends its knees noticeably less in the run (83° against PFNN's 93° and the
mocap's 107°). That is the averaging the paper describes: the run is blurred toward the walk.

**What it took to make PFNN controllable.**
- **Without input noise it locked into running.** Trained as-is, PFNN learned to lean on its own last pose. After
  a turn it kept going at 2.4–3.2 m/s when asked to walk, and it never stopped. The standard remedy fixed it: add
  noise to the previous-pose inputs during training (σ = 0.5 in normalised units), so the trajectory and gait
  inputs have to carry the decision.
- **The gait label had to be added.** The paper fed it in too. Even with the label, the noise was still needed.

**Neither network can stop** (both drift at about 0.6 m/s): the data has only two takes of stopping. Holden et al.
had 1.5 hours of motion; with two minutes, the question is less which architecture wins than what is in the data.

## Failure modes

- Small data: overfitting (PFNN) and blurring (the plain network) are two sides of having too little of it.
- No terrain. The paper's networks also learned to adapt to uneven ground, from a heightmap fitted under every
  frame; the CMU subject 16 takes are all on flat floor.
- Autoregressive drift: errors feed back into the next input. The phase clamp (never backwards, at most 0.08 of a
  cycle per frame) and the input-noise training are the guards.

## References

- D. Holden, T. Komura, J. Saito, *Phase-Functioned Neural Networks for Character Control* (SIGGRAPH 2017)
- H. Zhang, S. Starke, T. Komura, J. Saito, *Mode-Adaptive Neural Networks for Quadruped Motion Control*
  (SIGGRAPH 2018)
- S. Starke, I. Mason, T. Komura, *DeepPhase: Periodic Autoencoders for Learning Motion Phase Manifolds*
  (SIGGRAPH 2022)
