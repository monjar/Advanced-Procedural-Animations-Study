# RL Locomotion Policy

A quadruped that learned to walk by trial and error. Nothing about its gait is written down: a neural network
maps what the robot senses to joint targets fifty times a second, and it was trained with reinforcement
learning to follow a commanded velocity. The trot you see — diagonal legs moving together — is something the
policy found on its own.

Training ran offline in Python MuJoCo; this page runs the same network against the same model in **MuJoCo WASM**.
The policy only works in the simulator it was trained in, so that is the part that has to be exactly right.

## The task

- **Robot.** 13 kg, Go1-like proportions: trunk, four legs of hip abduction + hip flexion + knee, 21 cm thigh and
  calf. Each joint is a PD position actuator (kp 30, kd 0.75, Go1's torque limits). Physics at 200 Hz, policy at 50 Hz.
- **Observation (48).** Trunk linear and angular velocity in the body frame, gravity in the body frame, the
  command (forward, sideways, turn rate), joint angles relative to the standing pose, joint velocities, and the
  previous action.
- **Action (12).** Offsets from the standing pose, ×0.25 rad, as PD targets.
- **Reward** (after legged_gym): exp(−|v_cmd − v|² / 0.25) for velocity and turn-rate tracking, plus penalties
  for vertical bounce, roll/pitch rates, tilt, height error, torque, joint acceleration, action changes, leg (not
  foot) contacts, joint limits, motion when told to stand, and swing feet scuffing low and fast; a feet-air-time
  term rewards real steps.
- **Randomisation.** Friction 0.6–1.25, random start pose, commands resampled every 10 s (10 % "stand"), and a
  shove of up to 1.2 m/s every 4 s — which is why you can drag and push it here.

## Training (`training/`)

PPO (Schulman et al. 2017) written out in ~200 lines of PyTorch rather than taken from a library: clipped
surrogate and value losses, GAE(λ = 0.95), a state-independent learned action std, and the KL-adaptive learning
rate from rsl_rl. 528 simulations across 11 worker processes give ~25 000 steps/s on an M2 Pro CPU — no GPU.

| run | iterations | env steps | time |
|---|---|---|---|
| base | 3 000 | 38 M | 24 min |
| fine-tune: stronger shoves, swing-clearance term | +1 500 | +19 M | 13 min |

Reward curves say little about whether a gait is any good, so `training/evaluate.py` runs the deterministic
policy on fixed commands and measures it. The fine-tune is what shipped:

| | base | shipped |
|---|---|---|
| speed error (walk 0.5, trot 1.0, back, side, turn, arc) | 0.03–0.07 m/s | 0.04–0.05 m/s |
| turn-rate error | 0.03 rad/s | 0.02–0.05 rad/s |
| falls, shoved 1 m/s every 2 s (10 × 20 s) | 6 | **1** |
| falls, shoved 0.6 m/s every 4 s | 0 | 0 |
| swing foot clearance, trot / sidestep | 4.5 / 2.5 cm | **6.2 / 5.6 cm** |
| standing: feet in contact | 98 % | 100 % |

## Running it in the browser

- **Same simulator.** `@mujoco/mujoco` 3.15.0, the official WASM build, loads the same MJCF file the trainer
  used (pinned to the same version as the Python package).
- **Same controller.** `sim.ts` transcribes `env.py`'s observation and action code line for line.
- **Same network.** The actor is three matrix–vector products with ELU, so it runs in plain TypeScript
  (`policy.ts`, 53 k float32 weights, 284 KB) instead of through onnxruntime-web (~10 MB) — a deliberate
  deviation from the plan, made because the runtime would be two orders of magnitude bigger than the model.

The unit tests check all three against a run recorded in Python:

| check | result |
|---|---|
| TypeScript MLP vs PyTorch, 100 recorded observations | max error 3.5 × 10⁻⁷ |
| MuJoCo WASM vs Python MuJoCo, 2 s of walking replayed open-loop | observations agree to 2 × 10⁻¹⁴, final state to 4 × 10⁻¹⁵ |
| closed loop in WASM: 0.8 m/s for 8 s | 7.7 m (96 %), never tilts past 37° |
| closed loop: turn at 1 rad/s, stand | within 15 % / drifts < 10 cm |

The WASM build reproduces the native one to rounding error, so the policy sees in the browser exactly what it saw
in training. A control step (policy + 4 physics steps) costs ~0.2 ms; rendering interpolates between steps so
50 Hz control does not judder on a 60 or 120 Hz display.

## Interaction

- **Autopilot** runs a command programme (stand, walk, trot and turn, sidestep, back up, spin); **manual** takes
  W/S, A/D, Q/E or a gamepad. Commands are eased over 0.25 s, as a joystick would be.
- **Drag** the robot: a spring–damper force on the trunk (capped at 250 N) pulls it toward the cursor.
- **Shove** adds a random 0.2–2 m/s kick — the same perturbation as in training.
- If it does go over, it is stood back up after a second (the policy was never taught to get up).

## Failure modes

- Shoves above ~1.5 m/s, or one every second or two, can still knock it over; it has no recovery behaviour.
- It is a flat-ground policy: there is no terrain in training and no perception of it.
- Observations include trunk linear velocity, which a real robot would have to estimate; fine in simulation.
- Sideways and backward walking are less tidy than forward (fewer commands of that kind during training).

## References

- J. Schulman et al., *Proximal Policy Optimization Algorithms* (2017)
- N. Rudin et al., *Learning to Walk in Minutes Using Massively Parallel Deep Reinforcement Learning* (CoRL 2021) — reward terms and rsl_rl
- E. Todorov et al., *MuJoCo: A physics engine for model-based control* (IROS 2012); MuJoCo WASM bindings (Google DeepMind)
- X. B. Peng et al., *DeepMimic* (SIGGRAPH 2018) — imitation of mocap, not done here
