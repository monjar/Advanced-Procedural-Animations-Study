# Study 13 training

Offline PPO training of the quadruped policy that `demos/13-rl-locomotion` runs in the browser.

```bash
cd training
uv sync                                              # Python 3.11–3.12, MuJoCo 3.15.0, PyTorch
uv run python train.py --iterations 3000             # ~25 min on an M2 Pro CPU; checkpoints in runs/
uv run python train.py --iterations 4500 --resume runs/<run>/model_3000.pt   # continue / fine-tune
uv run python evaluate.py runs/<run>/model_4500.pt   # tracking, shoves, gait metrics
uv run python train.py --export runs/<run>/model_4500.pt
```

`--export` writes `public/assets/rl/policy.json` (actor weights), copies `quadruped.xml` next to it, and records
`tests/fixtures/rl-parity.json`: two seconds of the policy in Python MuJoCo, which the unit tests replay in
MuJoCo WASM. Keep `mujoco` here and `@mujoco/mujoco` in `package.json` on the same version.

| file | |
|---|---|
| `quadruped.xml` | the robot (shared with the browser) |
| `env.py` | observation, action, rewards, resets, pushes; `observe` / `apply_action` mirror `demos/13-rl-locomotion/sim.ts` |
| `ppo.py` | PPO: actor-critic, GAE, clipped losses, KL-adaptive learning rate |
| `train.py` | worker processes, training loop, export |
| `evaluate.py` | deterministic evaluation |
