# Roadmap

Fifteen interactive studies, ordered so that each tier reuses the systems built in the previous one.
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
| 13 | RL Locomotion Policy                     | Learned       | 10          | planned |
| 14 | LLM-Directed Animation                   | Learned       | 02–07       | planned |
| 15 | Procedural Face (stretch)                | Expressive    | 01, 02      | planned |

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
- **Techniques:** PPO trained offline in `training/` (MuJoCo + Brax or SB3), exported to ONNX; in-browser inference via
  `onnxruntime-web` stepping `@mujoco/mujoco` WASM — the policy must run in the same simulator it was trained in.
  Mouse-applied perturbations. Optional DeepMimic-style imitation of a CMU clip.
- **References:** J. Schulman et al., *PPO* (2017); X. B. Peng et al., *DeepMimic* (SIGGRAPH 2018).
- **Risk:** highest schedule risk — needs GPU compute outside the browser; MuJoCo JS bindings are still WIP.

### 14 · LLM-Directed Animation
- **Techniques:** natural language → schema-validated JSON program over the procedural vocabulary from studies 02–07
  (IK targets, gait parameters, look-at, timing). LLMs are unreliable with raw joint angles, so they drive high-level
  primitives only. Bring-your-own API key stored in `localStorage` only; recorded responses keep the page usable without a key.
- **References:** G. Tevet et al., *Human Motion Diffusion Model* (2022) as the learned text-to-motion contrast.

### 15 · Procedural Face (stretch)
- **Techniques:** saccades, blinks and micro-movements; Web Audio analysis driving visemes on morph targets.
- **References:** S. Lee, J. Badler, N. Badler, *Eyes Alive* (SIGGRAPH 2002);
  K. Ruhland et al., *A Review of Eye Gaze in Virtual Agents* (2015).

---

## Definition of done (every study)
- Interactive scene, Tweakpane controls, debug-draw toggles.
- Write-up: problem, math, implementation notes, failure modes, references.
- Gallery card; zero console errors on load; 60 fps on a mid-range laptop at default settings.
- Core math covered by unit tests.

## Phasing
- **P0** scaffold: site shell, gallery, demo template, CI, Pages deploy.
- **P1** 01–04 · **P2** 05–08 · **P3** 09 · **P4** 10–12 · **P5** 13–15.

## Assets
- No Mixamo (raw assets cannot be redistributed). CC0 meshes (Quaternius, Kenney) or stylised capsule rigs.
- Mocap: CMU Graphics Lab database with attribution.
