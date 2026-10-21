# Roadmap

Twenty-eight interactive studies, ordered so that each tier reuses the systems built in the previous one;
16–28 go beyond the original plan.
Every study ships as its own page in the showcase site with live controls, debug visualisation and a
technical write-up.

| #  | Study                                   | Tier          | Builds on   | Status  |
|----|-----------------------------------------|---------------|-------------|---------|
| 01 | Second-Order Dynamics & Secondary Motion | Foundations   | –           | live    |
| 02 | Analytic IK: Two-Bone, Aim, Look-At      | Foundations   | 01          | live    |
| 03 | Iterative IK Lab: CCD / FABRIK / DLS     | Foundations   | 02          | live    |
| 04 | XPBD Ropes, Tails & Cloth                | Foundations   | 01          | live    |
| 05 | Procedural Hexapod / Spider              | Locomotion    | 01, 02, 03  | live    |
| 06 | Procedural Quadruped                     | Locomotion    | 05          | live    |
| 07 | Procedural Biped (Overgrowth-style)      | Locomotion    | 01, 02      | live    |
| 08 | Foot IK & Ground Adaptation over Mocap   | Locomotion    | 02, 07      | live    |
| 09 | Motion Matching + Inertialization        | Data-driven   | 08          | live    |
| 10 | Active Ragdoll                           | Physics       | 02, 08      | live    |
| 11 | GPU Procedural Crowds                    | Physics / GPU | 01          | live    |
| 12 | Evolved Virtual Creatures                | Physics       | 10          | live    |
| 13 | RL Locomotion Policy                     | Learned       | 10          | live    |
| 14 | LLM-Directed Animation                   | Learned       | 02–07       | live    |
| 15 | Procedural Face (stretch)                | Expressive    | 01, 02      | live    |
| 16 | Learned Motion Matching                  | Beyond        | 09          | live    |
| 17 | Physics-Based Walker (SIMBICON)          | Beyond        | 10, 13      | live    |
| 18 | Procedural Hands & Grasping              | Beyond        | 02, 13      | live    |
| 19 | Character Crowds (ORCA)                  | Beyond        | 07, 11      | live    |
| 20 | Snakes & Worms                           | Further       | –           | live    |
| 21 | Physics-Based Mocap Tracking             | Further       | 08, 13      | live    |
| 22 | Hair & Tentacles (Cosserat)              | Further       | 04          | live    |
| 23 | Spacetime Constraints                    | Further       | –           | live    |
| 24 | Creature Creator                         | Further       | 01, 02, 06  | live    |
| 25 | Procedural Climbing                      | Further       | 02          | live    |
| 26 | Phase-Functioned Locomotion              | Further       | 09, 16      | live    |
| 27 | Motion-Matched Crowds                    | Further       | 09, 16, 19  | live    |
| 28 | Webcam Puppeteering                      | Further       | 08          | live    |

---

## Tier 1 — Foundations

### 01 · Second-Order Dynamics & Secondary Motion
- **Goal:** a reusable, frame-rate-stable smoothing primitive that gives procedural motion weight and personality.
- **Techniques:** second-order system parameterised by natural frequency `f`, damping `ζ` and initial response `r`;
  stability clamp on `k2` derived from the integration step; critically damped spring as a cheaper special case;
  chained followers for jiggle bones, antennae and tails.
- **Interaction:** drag a target, tune `f/ζ/r` per follower, watch a live step-response plot, vary `dt` to show stability.
- **Done when:** step response converges for all `ζ > 0`; no blow-up at `dt = 1/30` with `f = 10`; unit tested.
- **References:** t3ssel8r, *Giving Personality to Procedural Animations using Math* (2022);
  D. Holden, *Spring-It-On: The Game Developer's Spring-Roll-Call* (2021).

### 02 · Analytic IK: Two-Bone, Aim, Look-At
- **Goal:** closed-form limb IK that is exact, branch-free and cheap enough to run on every limb every frame.
- **Techniques:** law-of-cosines two-joint solve; pole vector for the bend plane; soft-IK to remove the snap
  near full extension; aim/look-at with cone limits via swing-twist decomposition; spring-smoothed gaze.
- **Interaction:** drag hand target and pole; toggle soft-IK and limits; head and eyes track the target.
- **Done when:** reachable targets hit within `1e-4`; unreachable targets fully extend toward target; bone
  lengths preserved; look-at never exceeds its cone.
- **References:** D. Holden, *Simple Two Joint IK* (2017); A. Nicholas, *Soft IK* (2009).

### 03 · Iterative IK Lab: CCD vs FABRIK vs Jacobian DLS
- **Goal:** side-by-side comparison of the three standard iterative solvers on identical chains.
- **Techniques:** CCD; FABRIK incl. multi-end-effector trees with sub-bases; Jacobian transpose /
  pseudo-inverse / damped least squares; hinge, cone and twist limits; per-iteration error plots.
- **Interaction:** tentacle and robot-arm scenes; iteration budget slider; solver switch; convergence graph.
- **Done when:** all three converge on reachable targets; limits respected; iteration count and error displayed.
- **References:** A. Aristidou & J. Lasenby, *FABRIK* (Graphical Models, 2011);
  S. Buss, *Introduction to Inverse Kinematics with Jacobian Transpose, Pseudoinverse and DLS Methods* (2004).

### 04 · XPBD Ropes, Tails & Cloth
- **Goal:** stable, stiffness-controllable physics for secondary motion attached to animated characters.
- **Techniques:** XPBD distance/bending constraints with compliance; substepping vs iterations;
  capsule collisions; pinning to animated transforms.
- **Interaction:** rope bridge, cape on a moving character, compliance and substep sliders.
- **Done when:** stiffness independent of iteration count (XPBD property); no tunnelling at default settings.
- **References:** M. Müller et al., *Position Based Dynamics* (2007); M. Macklin et al., *XPBD* (2016) and
  *Small Steps in Physics Simulation* (2019).

## Tier 2 — Procedural Locomotion

### 05 · Procedural Hexapod / Spider
- **Techniques:** raycast foot targets; step-distance trigger; tripod gait phase groups; arc-shaped swing
  trajectories; body height and orientation fitted to the foot plane; surface-normal-aligned movement for walls/ceilings.
- **Done when:** walks across uneven terrain and transitions floor → wall → over the top → floor without foot sliding (unit-tested). Ceilings are not covered.
- **Standing still (fixed after launch):** stopped near crates, the ramp or the wall, legs stepped forever (footholds out of
  reach; foothold ↔ body-tilt and probe ↔ body-tilt feedback loops). Now: reach-preferring footholds when idle, a settling
  budget, probes faded out when standing, continuous push-out instead of snapping clamps. Audited over 30 stops at 30–240 Hz:
  0 steps after settling (17 before), planted joints < 1 mm/frame (74 cm before); walking pops 724 → ~140 per minute.
- **References:** J. Jakobsson & J. Primate, *The Rain World Animation Process* (GDC 2016).

### 06 · Procedural Quadruped
- **Techniques:** gait phase table (walk / trot / canter / gallop) with speed-driven blending; spine curvature from turn rate;
  head stabilisation; footfall arcs.
- **Done when:** gait transitions are continuous with no foot pops.
- **References:** M. Hildebrand, *Symmetrical Gaits of Horses* (Science, 1965);
  H. Zhang et al., *Mode-Adaptive Neural Networks for Quadruped Motion Control* (SIGGRAPH 2018) as data-driven contrast.

### 07 · Procedural Biped (Overgrowth-style)
- **Techniques:** handful of key poses blended by a stride wheel; springs on pelvis and spine; velocity-driven step
  planning; pelvis bob/sway; arm counter-swing.
- **Done when:** walk → run → stop reads naturally from a single parameter set.
- **References:** D. Rosen, *An Indie Approach to Procedural Animation* (GDC 2014).

### 08 · Foot IK & Ground Adaptation over Mocap
- **Techniques:** contact detection from foot velocity/height; foot locking; pelvis drop; toe/heel alignment to slope;
  IK layered over clip playback.
- **Done when:** no foot sliding during contact on slopes and stairs; clip intent preserved on flat ground.
- **References:** R. S. Johansen, *Automated Semi-Procedural Animation for Character Locomotion* (2009).

## Tier 3 — Data-Driven

### 09 · Motion Matching + Inertialization
- **Built:** `tools/build-mm-db.mjs` packs 49 locomotion takes + idle of CMU subject 16 (117 s, 1.2 MB,
  quaternions in 16 bits, marker spikes removed); mirroring, simulation bone and 27-D features (trajectory
  +10/20/30 frames, feet, hips) are computed at load. Exact brute-force and AABB search, Holden-style spring
  trajectories, offset inertialization, path adjustment and clamping, foot-flat locking with two-bone IK.
- **Measured:** walk/run command speeds within 0.03 m/s, 90° turn in 0.45 s, stop in 0.73 s; inertialized
  switches no rougher than the data (worst 15° vs 78° for hard cuts); identical at 25/60/144 fps.
- **Deviation:** 0.5 s trajectory horizon (CMU takes are 1–4 s long); no strafing (no data).
- **References:** S. Clavet, *Motion Matching and The Road to Next-Gen Animation* (GDC 2016);
  D. Bollo, *Inertialization* (GDC 2018); D. Holden et al., *Learned Motion Matching* (SIGGRAPH 2020).

## Tier 4 — Physics-Based

### 10 · Active Ragdoll
- **Built:** 14 Rapier capsules (de Leva masses) following the CMU walk; muscles are implicit joint motors
  (gains from the weight each joint holds), PuppetMaster-style pins with pin power, hit unpinning with falloff,
  fall / limp / recover state machine.
- **Deviation:** a *pinned* ragdoll, not a SIMBICON walker — balance comes from the pins (decided up front;
  physically valid balance is study 13's job).
- **Measured:** stands within 1.1° / 1.1 cm, walks within 5.6° / 2.6 cm; falls in 1.3 s without pins; a
  120 N·s shove staggers it 18 cm and it recovers in 0.3 s; 250 N·s knocks it down and it gets back up.
- **References:** PuppetMaster docs; T. Geijtenbeek & N. Pronost, *Interactive Character Animation Using
  Simulated Physics* (2012); K. Yin et al., *SIMBICON* (2007).

### 11 · GPU Procedural Crowds (Fish)
- **Built:** boids on **WebGL2 GPGPU** (decided instead of WebGPU: one code path that runs in every browser and
  in CI): key pass, bitonic sort of (cell, index), binary-search cell ranges, capped 27-cell neighbour
  update writing two render targets; instanced fish with a travelling swim wave in the vertex shader.
- **Measured:** an end-to-end test reads the textures back and matches a CPU reference exactly (sort, cell
  table, neighbour counts; positions within 2 µm after a step) at 1 024 and 16 384 boids.
- **Not done:** birds mode; GPU frame timings (CI renders in software).
- **References:** C. Reynolds, *Flocks, Herds, and Schools* (SIGGRAPH 1987).

### 12 · Evolved Virtual Creatures
- **Built:** tree genomes of hinged boxes with per-joint oscillators and mirrored limbs; Rapier phenotypes
  with cross-section-limited torque and exploit guards; generational GA across a worker pool; recorded
  playback; shipped champions evolved offline by `tools/evolve.ts`; save/load/export.
- **Measured:** deterministic — shipped champions re-simulate to their exact fitness in Node and in a browser
  worker; evolution improves ≥ 1.5× in 6 generations.
- **References:** K. Sims, *Evolving Virtual Creatures* (SIGGRAPH 1994).

## Tier 5 — Learned

### 13 · RL Locomotion Policy
- **Built:** a 12-DoF quadruped (PD actuators) trained with PPO written in PyTorch (`training/`), 57 M steps on a CPU in
  37 minutes; velocity-command tracking with shoves; runs live in **MuJoCo WASM** (`@mujoco/mujoco`, same version and
  model as training) with drag, shove, keyboard/gamepad and autopilot.
- **Measured:** WASM reproduces the Python simulation to 2 × 10⁻¹⁴; the TypeScript MLP matches PyTorch to 3.5 × 10⁻⁷;
  speed error ≤ 0.05 m/s across commands; 1 fall in 10 × 20 s of 1 m/s shoves every 2 s; emergent trot.
- **Deviation:** MuJoCo + own PPO instead of Brax/SB3; the actor runs in plain TypeScript, not onnxruntime-web (three
  matrix products do not justify a ~10 MB runtime). No DeepMimic imitation (optional).
- **References:** J. Schulman et al., *PPO* (2017); N. Rudin et al., *Learning to Walk in Minutes* (2021).

### 14 · LLM-Directed Animation
- **Built:** natural language → a program over walk_to / turn_to / look_at / point_at / reach_for / wave / nod /
  shake_head / wait with `with_previous` concurrency, performed by the study 07 biped with study 02 IK, a cone-limited
  look-at and a crouch. Claude (`claude-opus-5-5`) via structured outputs (JSON schema) plus a validator whose
  messages drive one repair round; bring-your-own key, kept in the browser; example programs work without a key.
- **Measured:** all 43 steps of the 8 example programs achieve their intent (arrive within 8 cm, point within 0.05°,
  touch within 11 cm); the client's request shape and repair loop are tested against a fake API.
- **Deviation:** the keyless examples are programs written in advance, not recorded API responses; the page says so.
- **References:** G. Tevet et al., *Human Motion Diffusion Model* (2022) as the learned text-to-motion contrast.

### 15 · Procedural Face
- **Built:** saccades (main sequence, exponential sizes), conversation gaze (mutual gaze vs aversion), microsaccades and
  drift, eye–head coordination with VOR, lid–eye coupling, blinks; a formant synthesizer that speaks typed text with a
  ground-truth viseme timeline; LPC formant tracking → visemes on procedurally generated morph targets, from the voice,
  a file or the microphone.
- **Measured:** 89–94 % of saccades ≤ 15°; blinks 17 / 24 per minute (rest / talking); mutual gaze 46 % talking vs 73 %
  listening; lip-sync on synthesized speech: 87 % vowel frames, 99 % s/sh, 76 % closures shut, jaw r = 0.89 — and a
  measured 25–35 ms output delay without which vowel accuracy falls to 68 %.
- **Deviation:** gaze interval distributions are tuned to published proportions, not fitted to Eyes Alive's data.
- **References:** S. Lee, J. Badler, N. Badler, *Eyes Alive* (SIGGRAPH 2002); K. Ruhland et al. (2015); Peterson & Barney (1952).

## Beyond the Roadmap

### 16 · Learned Motion Matching
- **Built:** Holden et al.'s compressor/decompressor, stepper and projector (`training/lmm/train_lmm.py`, ~16 min on a
  CPU) replacing study 09's database at runtime, with the same controller, inertialization and foot locking; both run
  side by side on the same input.
- **Measured:** walk/run 1.30/3.19 m/s vs 1.30/3.23; p99 per-step joint change 10.2° vs 17.7°; 0.73 MB of
  half-precision weights vs 7.1 MB; but 0.26 vs 0.027 ms per step — at two minutes of mocap the exact search is
  faster; LMM pays off as data grows.
- **References:** D. Holden, O. Kanoun, M. Perepichka, T. Popa, *Learned Motion Matching* (SIGGRAPH 2020).

### 17 · Physics-Based Walker
- **Built:** SIMBICON on a 71 kg MuJoCo biped: per-state PD targets, balance feedback θ = θ₀ + c_d·d + c_v·v in both
  planes, world-frame torso pitch/roll/yaw through the stance hip, steering, two gaits; drag and shove it.
- **Measured:** 0.38 / 0.91 m/s; shoves survived on every trial up to 0.5 m/s sideways; no falls on the steering
  course; without balance feedback it falls.
- **References:** K. Yin, K. Loken, M. van de Panne, *SIMBICON* (SIGGRAPH 2007).

### 18 · Procedural Hands & Grasping
- **Built:** a 21-joint hand; GraspIt!-style planner (approach, slide in, close; pinches along a joint-space synergy)
  over SDF objects; Ferrari–Canny ε with soft-finger contacts, opposition, lift quality; every grasp lifted 20 cm in
  MuJoCo with the hand welded to a mocap target.
- **Measured:** top-5 grasps hold 23/30; 55 % of force-closure grasps hold vs 4 % without; among force-closure grasps
  opposition predicts the lift (AUC 0.73), ε's magnitude does not (0.49); a mocap-parented hand lifts 0/30.
- **References:** A. Miller, P. Allen, *GraspIt!* (2004); C. Ferrari, J. Canny (1992); M. Ciocarlie, P. Allen (2009).

### 19 · Character Crowds
- **Built:** ORCA ported from RVO2 (agents, polygonal obstacles, 2-D/3-D linear programs) and Helbing's social-force
  model on the same waypoint navigation; four scenes; instanced procedural walkers with speed-driven gait; per-agent
  velocity-space view.
- **Measured:** at walking pace ORCA clears every scene sooner (circle swap 21 vs 33 s) with less wiggle; hurried
  through a door, social forces push through faster (25 vs 37 s at 3×) with bodies 7.7 cm deep in each other.
- **References:** J. van den Berg et al., *Reciprocal n-Body Collision Avoidance* (2011); D. Helbing et al. (1995, 2000).


## Further Studies

### 20 · Snakes & Worms
- **Built:** Hu et al.'s slithering model (centre-of-mass and angular-momentum dynamics under anisotropic Coulomb
  friction); four creatures that only change shape: serpenoid undulation, sidewinding, an earthworm's peristalsis,
  an inchworm.
- **Measured:** equal friction goes nowhere; on corn-snake friction, lifting the bends triples the speed (0.05 →
  0.15 m/s); sidewinding 0.45 m/s at 87–97° to the body; the worm 26 mm/s, only with backward-gripping bristles.
- **References:** D. Hu, J. Nirody, T. Scott, M. Shelley, *The mechanics of slithering locomotion* (PNAS 2009).

### 21 · Physics-Based Mocap Tracking
- **Built:** a 28-DoF MuJoCo humanoid built from the CMU skeleton; DeepMimic's imitation reward, reference-state
  initialisation and early termination; PPO with residual actions and normalised observations; runs in MuJoCo WASM.
- **Measured:** walk 1.10 m/s at 0.9° RMS pose error, indefinitely; plain PD tracking falls at 1.23 s; shoves of
  0.7 m/s survived from every side.
- **References:** X. B. Peng, P. Abbeel, S. Levine, M. van de Panne, *DeepMimic* (SIGGRAPH 2018).

### 22 · Hair & Tentacles
- **Built:** position-and-orientation Cosserat rods in XPBD (stretch–shear, bend–twist); a head of ~400 strands, an
  octopus reaching by bend propagation, a twisted rod.
- **Measured:** converged deflection exact (1.00×), under-converged up to 6×; a factor of two in the published
  stretch–shear update; twist buckling within 4–8% of Greenhill's load in the best runs.
- **References:** T. Kugelstadt, E. Schömer, *Position and Orientation Based Cosserat Rods* (SCA 2016).

### 23 · Spacetime Constraints
- **Built:** Witkin & Kass's lamp: B-spline joint trajectories, minimum torque, Newtonian flight by construction,
  floor contact within friction and sole; CMA-ES then Levenberg–Marquardt; live optimisation in a worker.
- **Measured:** hop, step and long jump land within 3–18 mm; a 55–65 cm crouch emerges unasked; the hand-keyed
  versions need 2.2–2.7× the lamp's weight from nowhere; a hurdle failed (local minimum).
- **References:** A. Witkin, M. Kass, *Spacetime Constraints* (SIGGRAPH 1988).

### 24 · Creature Creator
- **Built:** a body editor (spine, leg pairs, head, tail); gait from leg count (Hildebrand), stride and frequency
  from Froude similarity, duty factor from speed, footholds, two-bone legs, a spine that follows the head.
- **Measured:** static stability follows the biology unprogrammed (centipede 89–100%, trotting quadruped 0%);
  feet out of reach ≤ 2.8% of stance, except a fast spider (9.6%).
- **References:** C. Hecker et al., *Real-time Motion Retargeting to Highly Varied User-Created Morphologies*
  (SIGGRAPH 2008); R. McN. Alexander (1976).

### 25 · Procedural Climbing
- **Built:** weighted A* over (hand, hand, foot, foot) stances; a torso solved for reach by projected Gauss–Seidel;
  three-limb support checked during every move; two-bone limbs.
- **Measured:** 24/24 random walls at 32 cm spacing in 0.58 s; denser walls are *harder* (7/24 at 25 cm).
- **References:** K. Kalisiak, M. van de Panne (2001); P. Hart, N. Nilsson, B. Raphael (1968).

### 26 · Phase-Functioned Locomotion
- **Built:** PFNN (four weight sets on a cyclic Catmull–Rom spline of the phase) and a plain network of the same
  layers, trained identically on the CMU data, running side by side.
- **Measured:** one-step error 0.144 vs 0.137 (plain slightly better), but closed loop the plain network's run
  knees reach 83° against PFNN's 93° and the mocap's 107°; input noise was needed for control.
- **References:** D. Holden, T. Komura, J. Saito, *Phase-Functioned Neural Networks* (SIGGRAPH 2017).

### 27 · Motion-Matched Crowds
- **Built:** study 19's ORCA crowds with study 09/16 bodies, coupled animation-driven (bodies move, ORCA plans) or
  simulation-driven (ORCA moves, bodies pulled at most k× their speed).
- **Measured:** no free setting: animation-driven bodies overlap (41–84 pair·s); collision-free needs a pull of
  about 4× and doubles foot sliding (28–32 vs 14–15 cm/s); 16 µs per person with the database, ~300 µs learned.
- **References:** J. van den Berg et al. (2011); S. Clavet, *Motion Matching* (GDC 2016).

### 28 · Webcam Puppeteering
- **Built:** MediaPipe Pose Landmarker in the browser (loaded on request); a simulated tracker from CMU mocap for
  scoring; One Euro filter; direction-only retargeting onto any proportions; locomotion from soft-weighted,
  stride-gated planted feet.
- **Measured:** One Euro matches a fast EMA's error moving (2.53 cm walking) with a third less jitter standing;
  walks end within 2–36 cm of the person over 2–4.4 m; standing still drifts 13 cm in 9.5 s, against 2.3 m with a
  hard foot switch; runs come up a third short.
- **References:** G. Casiez, N. Roussel, D. Vogel, *1€ Filter* (CHI 2012); V. Bazarevsky et al., *BlazePose* (2020).

---

## Definition of done (every study)
- Interactive scene, Tweakpane controls, debug-draw toggles.
- Write-up: problem, math, implementation notes, failure modes, references.
- Gallery card; zero console errors on load; 60 fps on a mid-range laptop at default settings.
- Core math covered by unit tests.

## Phasing
- **P0** scaffold: site shell, gallery, demo template, CI, Pages deploy.
- **P1** 01–04 · **P2** 05–08 · **P3** 09 · **P4** 10–12 · **P5** 13–15 · **P6** 16–19 · **P7** 20–28.

## Assets
- No Mixamo (raw assets cannot be redistributed). CC0 meshes (Quaternius, Kenney) or stylised capsule rigs.
- Mocap: CMU Graphics Lab database with attribution.
