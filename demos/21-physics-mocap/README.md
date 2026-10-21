# Physics-Based Mocap Tracking

Study 08 plays CMU motion capture on a skeleton. This study makes a simulated body *perform* it: a 59 kg MuJoCo
humanoid with 28 motorised joints, which has to keep its balance with nothing holding it up. Played straight
into its joint motors, the walk falls over in 1.2 seconds. A policy trained with reinforcement learning, as in
DeepMimic (Peng, Abbeel, Levine & van de Panne, SIGGRAPH 2018), walks it indefinitely and survives being shoved.
The translucent blue figure is the mocap; the grey one is physics.

## The body, built from the mocap (`training/mimic/humanoid.py`)

The humanoid's bodies sit where the CMU skeleton's joints are in its rest pose. That pose is aligned with the
world, as in BVH, so retargeting needs no fitting. Each body's local rotation is its parent's inverse times its
own world rotation, split into hinge angles:
- **Three-hinge joints** (torso, neck, shoulders, hips, ankles): intrinsic Euler angles, in an order that keeps
  the large rotation off the middle axis. Shoulders drop from the T-pose about their first axis.
- **Elbows and knees:** the twist about an axis fitted to the data. It turned out the CMU knees and elbows are
  exact hinges: 0.0° off-axis.

The three-joint spine becomes one torso, and clavicles and toes fold into their neighbours. That gives 28 degrees
of freedom, as in DeepMimic. Replayed through MuJoCo's kinematics, the retargeted legs land exactly on the mocap
(0.0 cm). Hands and head are off by 2–4 cm, from the rigid torso.

A loop is cut from each take where pose, velocity and root height match best: 1.15 s of walking (CMU 16_15,
1.10 m/s) and 0.57 s of running (16_55, 3.14 m/s). Then the clip is set on the floor.

## Learning to perform it (`training/mimic/`)

PPO, using study 13's implementation, on 352 simulations across 11 worker processes.
- **Policy:** sees its own state, the clip's phase and the clip's next pose.
- **Actions:** corrections to that pose. PD servos track pose + correction for 15 physics steps of 2 ms (a
  33 Hz policy).
- **Reward:** DeepMimic's imitation reward: pose, joint velocity, end-effector and root terms, each exp(−k·err²).
- **Starts and ends:** episodes start at a random phase of the clip, in the clip's state (reference state
  initialisation). They end the moment anything but a foot touches the floor (early termination).
- **Pushes:** random shoves of up to 0.7 m/s every 2–4 s.

**Departures, to train on a CPU:**
- The action is a *residual* on the clip's pose, not an absolute target.
- Every quantity is measured in the character's own heading frame, so the reward asks for the motion, not the
  mocap's place in the world.

The walk trained for 4,000 iterations (45 M steps) in 70 minutes. Its episodes went from 1.8 s at iteration 200
to the full 10 s by iteration 1,400.

**Two things had to change before it learned at all.**
1. The adaptive learning rate (study 13's, aiming for a fixed KL divergence) collapsed to its floor. With 28
   action dimensions, a tiny change in the policy's mean is already a large KL. It now has a floor of 5·10⁻⁵ and
   a looser target.
2. Observations needed normalising, as DeepMimic does: running mean and variance, frozen into the exported
   policy.

## Measured

In MuJoCo WASM, in the browser runtime:

| | |
|---|---|
| browser vs Python | observations and final state agree to 10⁻⁴ over 3 s; the TypeScript MLP matches PyTorch to 10⁻⁴ |
| speed | 1.10 m/s (the clip: 1.10) |
| pose tracking | 0.9° RMS over the 28 joints |
| the same clip without the policy | falls at 1.23 s |
| shoves survived (6 trials each) | 0.7 m/s from every side, 6/6. At 1.0 m/s: from behind 5/6, the left 6/6, the right 4/6, the front 1/6 |

For comparison, study 17's hand-tuned SIMBICON walker survives 0.5 m/s sideways and 0.2 m/s from the front.

**A bug only the browser found.** At clip time 0 the reference velocity is measured across t < 0, and the
cycle shift there mishandled negative cycles. That produced a huge starting velocity, and the character fell in
0.84 s. Training almost never starts that close to 0, so it never noticed. The browser starts exactly there.

## Interaction

Shove it from four directions, or drag it. Turn the policy off to watch plain mocap tracking fall. Switch
between the walk and the run.

## Failure modes

- One policy per clip. Clips can't be blended or switched mid-stride, and the character can't be steered: it
  follows the clip's own direction (DeepMimic adds goals for that).
- Shoves from the front are its weak side: it was trained walking forward, and stopping isn't in the clip.
- The policy saw only flat ground.

## References

- X. B. Peng, P. Abbeel, S. Levine, M. van de Panne, *DeepMimic: Example-Guided Deep Reinforcement Learning of
  Physics-Based Character Skills* (SIGGRAPH 2018)
- J. Schulman et al., *Proximal Policy Optimization Algorithms* (2017)
- CMU Graphics Lab Motion Capture Database, subject 16
- E. Todorov, T. Erez, Y. Tassa, *MuJoCo* (IROS 2012)
