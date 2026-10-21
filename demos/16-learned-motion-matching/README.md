# Learned Motion Matching

Study 09 plays motion capture by searching a database. This study takes the database away and keeps the
motion: three small neural networks stand in for the search, the playback and the storage, following Holden,
Kanoun, Perepichka & Popa (SIGGRAPH 2020). Both versions run side by side on the same input — database on the
left, networks on the right.

## The idea

Motion matching needs two things per frame at runtime: the features **X** it searches (27 numbers: the future
trajectory, feet, hips) and the pose **Y** it plays (158 numbers: 25 joint rotations, the hips, root motion, foot
contacts). LMM learns:

| network | replaces | maps |
|---|---|---|
| decompressor | reading a pose from the database | (X, Z) → Y |
| stepper | "play the next frame" | (X, Z)ₜ → (X, Z)ₜ₊₁ |
| projector | the nearest-neighbour search | query → (X, Z) of the frame the search would find |

**Z** is a 32-number latent holding what the features do not say about the pose (arm swing, which foot leads,
the subject's mood that day). It comes from a compressor trained jointly with the decompressor, Y → Z → Y.
Its losses are on the pose vector, on joint positions through forward kinematics, and on velocities between
consecutive frames. The compressor is then frozen, and the stepper (on 20-frame rollouts) and projector (on
noisy queries labelled with the exact nearest neighbour among the frames study 09 may jump to) learn to produce Z.
Training: `training/lmm/train_lmm.py`, ~16 minutes on a CPU.

The runtime (`learned.ts`) is study 09's loop with the database calls swapped out. The controller, root motion,
trajectory adjustment, inertialization and foot locking are the same code. Rotations are regressed in the
6-D form (two matrix columns, Zhou et al. 2019), which is continuous; quaternions are not.

## Measured

| | database (study 09) | learned |
|---|---|---|
| walk / run speed (commanded 1.3 / 3.2 m/s) | 1.30 / 3.23 m/s | 1.30 / 3.19 m/s |
| 90° turn to within 15° | 0.45 s | 0.47 s |
| stop | 0.77 s | 0.85 s |
| clip switches | 3.75 /s | 3.45 /s |
| per-step joint change, 99th percentile | 17.7° | 10.2° |
| foot skating while "planted" (no foot locking) | 23.4 cm/s | 22.6 cm/s |
| memory | 7.1 MB (rotations, features, root) | **0.73 MB** (372 k weights, half precision) |
| CPU per 60 Hz step | **0.027 ms** | 0.26 ms |

And against the database itself:

| | |
|---|---|
| decompressor, true latent | 0.11 cm mean joint error |
| TypeScript vs PyTorch (half-precision weights) | max difference 4 × 10⁻⁴ |
| projector vs exact search, noisy queries | within 2 % of the nearest neighbour's cost (median); its pose 1.7–3.1 cm from that frame's |
| stepper drift, from a projected start | 1.1 cm after 1 frame, 1.5 cm after 30, 2.4 cm after 60 (one second) |

**The trade-off is clear, and it scales.** The networks are ten times smaller than the database in memory and
move at least as smoothly (they quietly filter the data's spikes). But on two minutes of mocap, the
exact search is ten times *faster* than running three networks. Holden's database was gigabytes, so search
time and memory were the problem; here neither is. LMM's case grows with the data: network cost is constant,
search cost and memory are not. To make the comparison mean anything at this size, the networks are half
Holden's width (256) and stored in half precision. At his size they would have been *larger* than this
database.

## Failure modes

- Unseen queries (directions and speeds the data never shows) project to plausible but blended poses.
- Errors in Z are invisible in X: a stepper that drifts in Z changes the arms while the features stay right,
  which is why the projector re-anchors it every few frames.
- The networks have to be retrained whenever the data changes; a database just gets a new take.

## References

- D. Holden, O. Kanoun, M. Perepichka, T. Popa, *Learned Motion Matching* (SIGGRAPH 2020)
- Y. Zhou et al., *On the Continuity of Rotation Representations in Neural Networks* (CVPR 2019)
- S. Clavet, *Motion Matching and The Road to Next-Gen Animation* (GDC 2016)
