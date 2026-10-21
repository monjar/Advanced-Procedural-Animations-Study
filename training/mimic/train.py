"""
Train a study 21 imitation policy with PPO (the study 13 implementation) across worker processes.

    uv run python mimic/train.py --clip walk --iterations 2000
    uv run python mimic/train.py --export runs/mimic-walk-<time>/model_2000.pt --clip walk
"""

from __future__ import annotations

import argparse
import base64
import json
import multiprocessing as mp
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from ppo import PPO, ActorCritic, RolloutBuffer  # noqa: E402
from env import ACTION_SCALE, DECIMATION, DT, END_EFFECTORS, NUM_ACT, NUM_OBS, POLICY_DT, MimicEnv  # noqa: E402

HIDDEN = [512, 256, 128]
STEPS_PER_ITER = 32


class RunningNorm:
    """Observation normalisation with running mean and variance (frozen into the exported policy)."""

    def __init__(self, dim: int):
        self.mean = np.zeros(dim)
        self.var = np.ones(dim)
        self.count = 1e-4

    def update(self, x: np.ndarray) -> None:
        bm, bv, bc = x.mean(0), x.var(0), len(x)
        delta = bm - self.mean
        tot = self.count + bc
        self.mean = self.mean + delta * bc / tot
        self.var = (self.var * self.count + bv * bc + delta**2 * self.count * bc / tot) / tot
        self.count = tot

    def __call__(self, x: np.ndarray) -> np.ndarray:
        return np.clip((x - self.mean) / np.sqrt(self.var + 1e-8), -5, 5).astype(np.float32)


def worker(remote, num_envs: int, seed: int, clip: str) -> None:
    os.environ["OMP_NUM_THREADS"] = "1"
    sys.path.insert(0, str(HERE))
    env = MimicEnv(num_envs, seed, clip)
    remote.send(env.obs.copy())
    while True:
        cmd, payload = remote.recv()
        if cmd == "step":
            obs, rew, done, info = env.step(payload)
            remote.send((obs, rew, done, info["timeouts"]))
        elif cmd == "stats":
            done = env.finished
            env.finished = []
            remote.send({k: float(np.mean([e[k] for e in done])) for k in done[0]} if done else {})
        elif cmd == "close":
            remote.close()
            return


class VecEnv:
    def __init__(self, workers: int, envs_per_worker: int, seed: int, clip: str):
        ctx = mp.get_context("spawn")
        self.remotes, self.procs = [], []
        for w in range(workers):
            a, b = ctx.Pipe()
            p = ctx.Process(target=worker, args=(b, envs_per_worker, seed * 1000 + w, clip), daemon=True)
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

    def stats(self) -> dict[str, float]:
        acc: dict[str, list[float]] = {}
        for r in self.remotes:
            r.send(("stats", None))
        for r in self.remotes:
            for k, v in r.recv().items():
                acc.setdefault(k, []).append(v)
        return {k: float(np.mean(v)) for k, v in acc.items()}

    def close(self) -> None:
        for r in self.remotes:
            r.send(("close", None))
        for p in self.procs:
            p.join(timeout=5)


def train(args: argparse.Namespace) -> None:
    torch.manual_seed(args.seed)
    torch.set_num_threads(4)
    run = HERE.parent / "runs" / f"mimic-{args.clip}-{time.strftime('%Y%m%d-%H%M%S')}"
    run.mkdir(parents=True, exist_ok=True)
    venv = VecEnv(args.workers, args.envs_per_worker, args.seed, args.clip)
    n = args.workers * args.envs_per_worker
    ac = ActorCritic(NUM_OBS, NUM_ACT, HIDDEN, init_std=0.5)
    ppo = PPO(ac, lr=3e-4, gamma=0.95, lam=0.95, entropy_coef=0.0, desired_kl=0.02, min_lr=5e-5, max_lr=1e-3)
    norm = RunningNorm(NUM_OBS)
    start = 0
    if args.resume:
        ckpt = torch.load(args.resume, weights_only=False)
        ac.load_state_dict(ckpt["model"])
        ppo.lr = ckpt.get("lr", ppo.lr)
        start = ckpt.get("iteration", 0)
        norm.mean, norm.var, norm.count = ckpt["norm"]
    buf = RolloutBuffer(STEPS_PER_ITER, n, NUM_OBS, NUM_ACT)
    raw = venv.obs
    norm.update(raw)
    obs = torch.as_tensor(norm(raw))
    log = open(run / "log.txt", "a")
    t_start = time.time()
    for it in range(start + 1, args.iterations + 1):
        t0 = time.time()
        for _ in range(STEPS_PER_ITER):
            actions = ppo.act(obs, buf)
            o, r, d, timeouts = venv.step(actions.numpy())
            ppo.record(buf, torch.as_tensor(r, dtype=torch.float32), torch.as_tensor(d, dtype=torch.float32), torch.as_tensor(timeouts, dtype=torch.float32))
            if it < args.freeze_norm:
                norm.update(o)
            obs = torch.as_tensor(norm(o))
        stats = ppo.update(buf, obs)
        if it % 10 == 0 or it == start + 1:
            fps = n * STEPS_PER_ITER / (time.time() - t0)
            s = venv.stats()
            terms = " ".join(f"{k}={v:.3f}" for k, v in s.items())
            line = f"it {it} fps {fps:.0f} std {ac.log_std.exp().mean().item():.3f} lr {stats['lr']:.1e} kl {stats['kl']:.4f} vloss {stats['value_loss']:.3f} | {terms} | {time.time() - t_start:.0f}s"
            print(line, flush=True)
            log.write(line + "\n")
            log.flush()
        if it % args.save_every == 0 or it == args.iterations:
            torch.save({"model": ac.state_dict(), "lr": ppo.lr, "iteration": it, "norm": (norm.mean, norm.var, norm.count)}, run / f"model_{it}.pt")
    venv.close()


def f32_b64(t: torch.Tensor) -> str:
    return base64.b64encode(t.detach().numpy().astype("<f4").tobytes()).decode()


def export(args: argparse.Namespace) -> None:
    ckpt = torch.load(args.export, weights_only=False)
    mean, var, _ = ckpt["norm"]
    ac = ActorCritic(NUM_OBS, NUM_ACT, HIDDEN)
    ac.load_state_dict(ckpt["model"])
    linears = [m for m in ac.actor if isinstance(m, torch.nn.Linear)]
    out = HERE.parent.parent / "public" / "assets" / "mimic" / f"policy-{args.clip}.json"
    out.write_text(
        json.dumps(
            {
                "about": f"Study 21 imitation policy ({args.clip}): PPO, MLP with ELU, obs {NUM_OBS} -> pose corrections {NUM_ACT}. See training/mimic/.",
                "clip": args.clip,
                "iteration": ckpt.get("iteration"),
                "obs": NUM_OBS,
                "act": NUM_ACT,
                "actionScale": ACTION_SCALE,
                "decimation": DECIMATION,
                "dt": DT,
                "obsMean": np.round(mean, 6).tolist(),
                "obsStd": np.round(np.sqrt(var + 1e-8), 6).tolist(),
                "layers": [{"in": l.in_features, "out": l.out_features, "weight": f32_b64(l.weight), "bias": f32_b64(l.bias)} for l in linears],
            }
        )
    )
    print(f"exported {out} ({out.stat().st_size / 1024:.0f} KB)")

    # Parity fixture: a closed-loop run in Python MuJoCo from a fixed start, which the TypeScript test replays.
    import mujoco
    from env import XML, apply_action, load_reference, observe

    model = mujoco.MjModel.from_xml_path(str(XML))
    ref = load_reference(args.clip)
    env = MimicEnv(1, 0, args.clip, pushes=False)
    env.offset_yaw[0] = 0.0
    t0 = 0.3
    env.t[0] = t0
    d = env.datas[0]
    mujoco.mj_resetData(env.model, d)
    d.qpos[:] = env._ref(0, t0)
    d.qvel[:] = env._ref_vel(0, t0)
    mujoco.mj_forward(env.model, d)
    frames = []
    for _ in range(100):
        env._observe(0)
        o = env.obs[0].astype(np.float64)
        normed = np.clip((o - mean) / np.sqrt(var + 1e-8), -5, 5)
        with torch.no_grad():
            a = ac.actor(torch.as_tensor(normed, dtype=torch.float32)[None])[0].numpy().astype(np.float64)
        frames.append({"obs": o.tolist(), "action": a.tolist()})
        apply_action(env.model, d, env.ref_next[0], a)
        env.t[0] += POLICY_DT
    fixture = {"clip": args.clip, "t0": t0, "frames": frames, "finalQpos": d.qpos.tolist()}
    fx = HERE.parent.parent / "tests" / "fixtures" / f"mimic-{args.clip}-parity.json"
    fx.write_text(json.dumps(fixture))
    print(f"wrote {fx}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--clip", default="walk")
    p.add_argument("--iterations", type=int, default=2000)
    p.add_argument("--workers", type=int, default=11)
    p.add_argument("--envs-per-worker", type=int, default=32)
    p.add_argument("--freeze-norm", type=int, default=500)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--save-every", type=int, default=100)
    p.add_argument("--resume", type=str, default="")
    p.add_argument("--export", type=str, default="")
    a = p.parse_args()
    export(a) if a.export else train(a)
