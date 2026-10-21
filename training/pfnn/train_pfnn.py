"""
Train study 26's phase-functioned neural network (Holden, Komura & Saito, SIGGRAPH 2017) and a plain MLP of the
same layer sizes, on the CMU subject 16 locomotion exported by tools/export-pfnn-data.ts.

    uv run python pfnn/train_pfnn.py      # ~10 min CPU; writes public/assets/pfnn/networks.json

PFNN: every layer's weights are a cyclic Catmull–Rom spline over four control sets, evaluated at the gait phase:
W(p) = Σₖ cₖ(p) Wₖ. The network is a different function at each point of the walk cycle. The baseline gets the
phase as an input (sin, cos) and has one weight set — the paper's comparison, which blurs poses together.

Held-out takes (every tenth take) measure generalisation; both networks are exported at half precision with
their normalisation and a parity fixture.
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
OUT = HERE.parents[1] / "public" / "assets" / "pfnn" / "networks.json"
import os

HIDDEN = int(os.environ.get('HIDDEN', 256))
DROPOUT = float(os.environ.get('DROPOUT', 0.3))
WEIGHT_DECAY = float(os.environ.get('WD', 1e-4))
ONLY = os.environ.get('ONLY', '')
# Noise on the previous-pose inputs (normalised units) while training: an autoregressive network otherwise
# learns to lean on its own last pose and ignore the trajectory and gait it is given.
POSE_NOISE = float(os.environ.get('POSE_NOISE', 0.5))


def catmull_rom_coeffs(phase: torch.Tensor) -> torch.Tensor:
    """(batch, 4) weights of control sets 0..3 for cyclic Catmull–Rom at phase ∈ [0, 1)."""
    p = phase * 4
    k1 = torch.floor(p).long() % 4
    t = p - torch.floor(p)
    t2, t3 = t * t, t * t * t
    # Coefficients of W[k0], W[k1], W[k2], W[k3] (k0 = k1 − 1, k2 = k1 + 1, k3 = k1 + 2).
    c0 = -0.5 * t + t2 - 0.5 * t3
    c1 = 1 - 2.5 * t2 + 1.5 * t3
    c2 = 0.5 * t + 2 * t2 - 1.5 * t3
    c3 = -0.5 * t2 + 0.5 * t3
    out = torch.zeros(phase.shape[0], 4)
    rows = torch.arange(phase.shape[0])
    for c, k in ((c0, (k1 - 1) % 4), (c1, k1), (c2, (k1 + 1) % 4), (c3, (k1 + 2) % 4)):
        out[rows, k] += c
    return out


class PhaseLinear(nn.Module):
    def __init__(self, n_in: int, n_out: int):
        super().__init__()
        self.w = nn.Parameter(torch.randn(4, n_out, n_in) * np.sqrt(2 / (n_in + n_out)))
        self.b = nn.Parameter(torch.zeros(4, n_out))

    def forward(self, x: torch.Tensor, coeffs: torch.Tensor) -> torch.Tensor:
        # Linear in W: Σₖ cₖ (Wₖ x + bₖ), four matrix products for the whole batch.
        ys = torch.einsum("koi,bi->bko", self.w, x) + self.b[None]
        return (coeffs[:, :, None] * ys).sum(1)


class PFNN(nn.Module):
    def __init__(self, n_in: int, n_out: int):
        super().__init__()
        self.l1, self.l2, self.l3 = PhaseLinear(n_in, HIDDEN), PhaseLinear(HIDDEN, HIDDEN), PhaseLinear(HIDDEN, n_out)
        self.drop = nn.Dropout(DROPOUT)

    def forward(self, x: torch.Tensor, phase: torch.Tensor) -> torch.Tensor:
        c = catmull_rom_coeffs(phase)
        h = nn.functional.elu(self.l1(self.drop(x), c))
        h = nn.functional.elu(self.l2(self.drop(h), c))
        return self.l3(self.drop(h), c)


class MLP(nn.Module):
    def __init__(self, n_in: int, n_out: int):
        super().__init__()
        self.l1, self.l2, self.l3 = nn.Linear(n_in + 2, HIDDEN), nn.Linear(HIDDEN, HIDDEN), nn.Linear(HIDDEN, n_out)
        self.drop = nn.Dropout(DROPOUT)

    def forward(self, x: torch.Tensor, phase: torch.Tensor) -> torch.Tensor:
        a = 2 * np.pi * phase
        x = torch.cat([x, torch.sin(a)[:, None], torch.cos(a)[:, None]], 1)
        h = nn.functional.elu(self.l1(self.drop(x)))
        h = nn.functional.elu(self.l2(self.drop(h)))
        return self.l3(self.drop(h))


def f16_b64(t: torch.Tensor) -> str:
    return base64.b64encode(t.detach().numpy().astype("<f2").tobytes()).decode()


def main() -> None:
    meta = json.loads((DATA / "meta.json").read_text())
    n = meta["frames"]
    X = np.fromfile(DATA / "X.f32", dtype=np.float32).reshape(n, meta["xDims"])
    Y = np.fromfile(DATA / "Y.f32", dtype=np.float32).reshape(n, meta["yDims"])
    P = np.fromfile(DATA / "phase.f32", dtype=np.float32)
    take = np.fromfile(DATA / "take.i32", dtype=np.int32)
    val = take % 10 == 3
    xm, xs = X[~val].mean(0), X[~val].std(0)
    ym, ys = Y[~val].mean(0), Y[~val].std(0)
    xs = np.maximum(xs, 1e-2)
    ys = np.maximum(ys, 1e-2)
    Xn = torch.tensor((X - xm) / xs)
    Yn = torch.tensor((Y - ym) / ys)
    Pt = torch.tensor(P)
    tr = torch.tensor(np.nonzero(~val)[0])
    va = torch.tensor(np.nonzero(val)[0])
    print(f"{n} frames: {len(tr)} train, {len(va)} held out ({int(val.sum())} frames from {len(set(take[val]))} takes)")
    pose_from = len(meta.get("traj", [0] * 6)) * 4 + 2  # trajectory and gait come first
    torch.manual_seed(0)
    torch.set_num_threads(4)
    results = {}
    for name, model in (("pfnn", PFNN(meta["xDims"], meta["yDims"])), ("mlp", MLP(meta["xDims"], meta["yDims"]))):
        if ONLY and name != ONLY:
            continue
        opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=WEIGHT_DECAY)
        epochs = 120
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
        t0 = time.time()
        for ep in range(epochs):
            model.train()
            perm = tr[torch.randperm(len(tr))]
            for i in range(0, len(perm), 64):
                idx = perm[i : i + 64]
                xb = Xn[idx].clone()
                xb[:, pose_from:] += POSE_NOISE * torch.randn_like(xb[:, pose_from:])
                loss = ((model(xb, Pt[idx]) - Yn[idx]) ** 2).mean()
                opt.zero_grad()
                loss.backward()
                opt.step()
            sched.step()
            if ep % 20 == 19 or ep == epochs - 1:
                model.eval()
                with torch.no_grad():
                    tl = ((model(Xn[tr], Pt[tr]) - Yn[tr]) ** 2).mean().item()
                    vl = ((model(Xn[va], Pt[va]) - Yn[va]) ** 2).mean().item()
                print(f"{name} epoch {ep + 1}: train {tl:.4f} held-out {vl:.4f} ({time.time() - t0:.0f}s)", flush=True)
        results[name] = model
    if ONLY:
        return
    pf, mlp = results["pfnn"], results["mlp"]
    pf.eval()
    mlp.eval()
    params = {k: sum(p.numel() for p in m.parameters()) for k, m in results.items()}

    def layers_pfnn(m: PFNN):
        return [{"in": l.w.shape[2], "out": l.w.shape[1], "weight": f16_b64(l.w), "bias": f16_b64(l.b)} for l in (m.l1, m.l2, m.l3)]

    def layers_mlp(m: MLP):
        return [{"in": l.in_features, "out": l.out_features, "weight": f16_b64(l.weight), "bias": f16_b64(l.bias)} for l in (m.l1, m.l2, m.l3)]

    # Parity fixture: a few held-out frames through both networks (weights rounded to half, as exported).
    with torch.no_grad():
        for m in (pf, mlp):
            for p in m.parameters():
                p.copy_(p.half().float())
        sample = va[:: max(1, len(va) // 8)][:8]
        fixture = {
            "x": X[sample.numpy()].tolist(),
            "phase": P[sample.numpy()].tolist(),
            "pfnn": (pf(Xn[sample], Pt[sample]).numpy() * ys + ym).tolist(),
            "mlp": (mlp(Xn[sample], Pt[sample]).numpy() * ys + ym).tolist(),
        }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "about": "Study 26: PFNN (phase-functioned, 4 control weight sets) and an MLP of the same layer sizes. See training/pfnn/.",
                "hidden": HIDDEN,
                "params": params,
                "x": {"mean": xm.tolist(), "std": xs.tolist()},
                "y": {"mean": ym.tolist(), "std": ys.tolist()},
                "pfnn": layers_pfnn(pf),
                "mlp": layers_mlp(mlp),
                "fixture": fixture,
            }
        )
    )
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB), params {params}")


if __name__ == "__main__":
    main()
