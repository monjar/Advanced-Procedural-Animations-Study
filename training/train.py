"""
Train the study 13 quadruped policy with PPO across worker processes, then export it for the browser.

    uv run python train.py --iterations 1500            # train (checkpoints in training/runs/)
    uv run python train.py --export runs/<run>/model_1500.pt   # write public/assets/rl/policy.json + fixture

Each worker process owns a batch of simulations (MuJoCo releases the GIL only inside mj_step, so processes,
not threads); the policy runs batched in the main process.
"""

from __future__ import annotations

import argparse
import base64
import json
import multiprocessing as mp
import os
import time
from pathlib import Path

import numpy as np
import torch

from env import ACTION_SCALE, DECIMATION, DEFAULT_POSE, DT, NUM_ACT, NUM_OBS, QuadrupedEnv, apply_action, observe
from ppo import PPO, ActorCritic, RolloutBuffer

ROOT = Path(__file__).resolve().parent
HIDDEN = [256, 128, 64]
STEPS_PER_ITER = 24


def worker(remote, num_envs: int, seed: int) -> None:
    os.environ["OMP_NUM_THREADS"] = "1"
    env = QuadrupedEnv(num_envs, seed)
    remote.send(env.obs.copy())
    while True:
        cmd, payload = remote.recv()
        if cmd == "step":
            obs, rew, done, info = env.step(payload)
            remote.send((obs, rew, done, info["timeouts"]))
        elif cmd == "stats":
            done = env.finished
            env.finished = []
            remote.send({k: float(np.mean([e[k] for e in done])) for k in env.cfg.rewards} if done else {})
        elif cmd == "close":
            remote.close()
            return


class VecEnv:
    def __init__(self, workers: int, envs_per_worker: int, seed: int):
        ctx = mp.get_context("spawn")
        self.remotes, self.procs = [], []
        for w in range(workers):
            a, b = ctx.Pipe()
            p = ctx.Process(target=worker, args=(b, envs_per_worker, seed * 1000 + w), daemon=True)
            p.start()
            self.remotes.append(a)
            self.procs.append(p)
        self.k = envs_per_worker
        self.obs = np.concatenate([r.recv() for r in self.remotes])

    def step(self, actions: np.ndarray):
        for i, r in enumerate(self.remotes):
            r.send(("step", actions[i * self.k : (i + 1) * self.k]))
        out = [r.recv() for r in self.remotes]
        return tuple(np.concatenate([o[j] for o in out]) for j in range(4))

    def close(self) -> None:
        for r in self.remotes:
            r.send(("close", None))
        for p in self.procs:
            p.join(timeout=5)


def train(args: argparse.Namespace) -> None:
    torch.manual_seed(args.seed)
    torch.set_num_threads(6)  # workers are idle while the update runs
    run = ROOT / "runs" / time.strftime("%Y%m%d-%H%M%S")
    run.mkdir(parents=True, exist_ok=True)
    venv = VecEnv(args.workers, args.envs_per_worker, args.seed)
    n = args.workers * args.envs_per_worker
    ac = ActorCritic(NUM_OBS, NUM_ACT, HIDDEN)
    ppo = PPO(ac)
    start = 0
    if args.resume:
        ckpt = torch.load(args.resume)
        ac.load_state_dict(ckpt["model"])
        ppo.lr = ckpt.get("lr", ppo.lr)
        start = ckpt.get("iteration", 0)
    buf = RolloutBuffer(STEPS_PER_ITER, n, NUM_OBS, NUM_ACT)
    obs = torch.as_tensor(venv.obs, dtype=torch.float32)
    ep_reward = np.zeros(n)
    ep_len = np.zeros(n)
    done_rewards: list[float] = []
    done_lengths: list[float] = []
    log = open(run / "log.txt", "a")
    t_start = time.time()
    for it in range(start + 1, args.iterations + 1):
        t0 = time.time()
        for _ in range(STEPS_PER_ITER):
            actions = ppo.act(obs, buf)
            o, r, d, timeouts = venv.step(actions.numpy())
            ppo.record(buf, torch.as_tensor(r), torch.as_tensor(d, dtype=torch.float32), torch.as_tensor(timeouts, dtype=torch.float32))
            obs = torch.as_tensor(o, dtype=torch.float32)
            ep_reward += r
            ep_len += 1
            for i in np.nonzero(d)[0]:
                done_rewards.append(ep_reward[i])
                done_lengths.append(ep_len[i])
                ep_reward[i] = 0
                ep_len[i] = 0
        t_collect = time.time() - t0
        stats = ppo.update(buf, obs)
        if it % 10 == 0 or it == start + 1:
            fps = n * STEPS_PER_ITER / (time.time() - t0)
            rew = np.mean(done_rewards[-200:]) if done_rewards else float("nan")
            length = np.mean(done_lengths[-200:]) if done_lengths else float("nan")
            # Per-term episode sums from one worker, normalised per second of episode.
            venv.remotes[0].send(("stats", None))
            sums = venv.remotes[0].recv()
            terms = " ".join(f"{k}={v:.3f}" for k, v in sums.items() if k.startswith("tracking") or k in ("feet_air_time", "feet_clearance", "collision"))
            line = (
                f"it {it} reward {rew:.2f} len {length:.0f} fps {fps:.0f} collect {t_collect:.1f}s "
                f"std {ac.log_std.exp().mean().item():.2f} lr {stats['lr']:.1e} kl {stats['kl']:.4f} "
                f"vloss {stats['value_loss']:.3f} | {terms} | {time.time() - t_start:.0f}s"
            )
            print(line, flush=True)
            log.write(line + "\n")
            log.flush()
        if it % args.save_every == 0 or it == args.iterations:
            torch.save({"model": ac.state_dict(), "lr": ppo.lr, "iteration": it}, run / f"model_{it}.pt")
    venv.close()


# ---------------------------------------------------------------------------------------------- export


def f32_b64(t: torch.Tensor) -> str:
    return base64.b64encode(t.detach().numpy().astype("<f4").tobytes()).decode()


def export(args: argparse.Namespace) -> None:
    ckpt = torch.load(args.export)
    ac = ActorCritic(NUM_OBS, NUM_ACT, HIDDEN)
    ac.load_state_dict(ckpt["model"])
    linears = [m for m in ac.actor if isinstance(m, torch.nn.Linear)]
    out_dir = ROOT.parent / "public" / "assets" / "rl"
    out_dir.mkdir(parents=True, exist_ok=True)
    policy = {
        "about": "Study 13 quadruped policy: PPO, MLP with ELU, obs 48 -> joint offsets 12. See training/.",
        "iteration": ckpt.get("iteration"),
        "obs": NUM_OBS,
        "act": NUM_ACT,
        "actionScale": ACTION_SCALE,
        "decimation": DECIMATION,
        "dt": DT,
        "defaultPose": DEFAULT_POSE.tolist(),
        "layers": [
            {"in": l.in_features, "out": l.out_features, "weight": f32_b64(l.weight), "bias": f32_b64(l.bias)} for l in linears
        ],
    }
    (out_dir / "policy.json").write_text(json.dumps(policy))
    (out_dir / "quadruped.xml").write_text((ROOT / "quadruped.xml").read_text())

    # Parity fixture: a short closed-loop run in Python MuJoCo. The TypeScript test replays the recorded actions
    # open-loop in MuJoCo WASM and compares observations, and runs the TypeScript MLP on the recorded
    # observations and compares actions.
    import mujoco

    model = mujoco.MjModel.from_xml_path(str(ROOT / "quadruped.xml"))
    data = mujoco.MjData(model)
    data.qpos[0:3] = [0, 0, 0.33]
    data.qpos[3:7] = [1, 0, 0, 0]
    data.qpos[7:19] = DEFAULT_POSE
    data.ctrl[:] = DEFAULT_POSE
    mujoco.mj_forward(model, data)
    command = np.array([0.8, 0.0, 0.3])
    last = np.zeros(NUM_ACT)
    frames = []
    for _ in range(100):
        o = observe(data.qpos, data.qvel, command, last)
        with torch.no_grad():
            a = ac.actor(torch.as_tensor(o, dtype=torch.float32)[None])[0].numpy().astype(np.float64)
        frames.append({"obs": o.tolist(), "action": a.tolist()})
        apply_action(model, data, a)
        last = a
    fixture = {"qpos": [0, 0, 0.33, 1, 0, 0, 0, *DEFAULT_POSE.tolist()], "command": command.tolist(), "frames": frames, "finalQpos": data.qpos.tolist()}
    fixtures = ROOT.parent / "tests" / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)
    (fixtures / "rl-parity.json").write_text(json.dumps(fixture))
    print(f"exported {out_dir / 'policy.json'} ({(out_dir / 'policy.json').stat().st_size / 1024:.0f} KB) and tests/fixtures/rl-parity.json")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--iterations", type=int, default=1500)
    p.add_argument("--workers", type=int, default=11)
    p.add_argument("--envs-per-worker", type=int, default=48)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--save-every", type=int, default=100)
    p.add_argument("--resume", type=str, default="")
    p.add_argument("--export", type=str, default="")
    a = p.parse_args()
    if a.export:
        export(a)
    else:
        train(a)
