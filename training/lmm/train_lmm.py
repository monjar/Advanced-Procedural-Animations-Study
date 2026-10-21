"""
Learned Motion Matching (Holden, Kanoun, Perepichka & Popa, SIGGRAPH 2020) for the study 09 database.

    npx rolldown tools/export-lmm-data.ts --platform node -o /tmp/e.mjs && node /tmp/e.mjs   # data
    cd training && uv run python lmm/train_lmm.py                                             # ~10 min CPU

Motion matching needs the whole database at runtime: the features X to search and the poses Y to play.
LMM replaces it with three small networks:

  decompressor  (X, Z) → Y           Z: a learned 32-D latent holding what X does not say about the pose
  stepper       (X, Z)ₜ → (X, Z)ₜ₊₁   replaces "play the next frame"
  projector     query → (X, Z)       replaces the nearest-neighbour search

The runtime networks are 256 wide (Holden uses 512) and stored in half precision: this database is only
~7 MB in memory, so the networks have to be much smaller than that for the comparison to mean anything.

Z comes from a compressor trained jointly with the decompressor (Y → Z → Y, with X as side information) and is
then frozen; the stepper and projector learn to produce it. Writes public/assets/lmm/networks.json.
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "lmm" / "data"
OUT = ROOT / "public" / "assets" / "lmm"
Z_DIMS = 32
torch.manual_seed(1)
np.random.seed(1)
torch.set_num_threads(8)

meta = json.loads((DATA / "meta.json").read_text())
N, J = meta["frames"], meta["joints"]
XD, YD = meta["xDims"], meta["yDims"]
X = torch.from_numpy(np.fromfile(DATA / "X.f32", dtype="<f4").reshape(N, XD).copy())
Y = torch.from_numpy(np.fromfile(DATA / "Y.f32", dtype="<f4").reshape(N, YD).copy())
take = np.fromfile(DATA / "take.i32", dtype="<i4")
matchable = np.fromfile(DATA / "matchable.u8", dtype="u1").astype(bool)
parents = meta["parents"]
offsets = torch.tensor(meta["offsets"], dtype=torch.float32)
feature_weights = torch.tensor(meta["featureWeights"], dtype=torch.float32)
Y_ROT, Y_ROOT = 3, 3 + 6 * J

# Frames whose successor is in the same take: valid (t, t+1) pairs and rollout starts.
has_next = np.zeros(N, dtype=bool)
has_next[:-1] = take[:-1] == take[1:]


def stats(a: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    return a.mean(0), a.std(0).clamp_min(1e-3)


x_mean, x_std = stats(X)
y_mean, y_std = stats(Y)


def mlp(sizes: list[int]) -> nn.Sequential:
    layers: list[nn.Module] = []
    for i in range(len(sizes) - 1):
        layers.append(nn.Linear(sizes[i], sizes[i + 1]))
        if i < len(sizes) - 2:
            layers.append(nn.ELU())
    return nn.Sequential(*layers)


# ------------------------------------------------------------------------------------------------- kinematics


def sixd_to_mat(v: torch.Tensor) -> torch.Tensor:
    """(..., 6) → (..., 3, 3) by Gram–Schmidt, columns a, b, a×b."""
    a = nn.functional.normalize(v[..., 0:3], dim=-1)
    b = v[..., 3:6] - (a * v[..., 3:6]).sum(-1, keepdim=True) * a
    b = nn.functional.normalize(b, dim=-1)
    return torch.stack([a, b, torch.cross(a, b, dim=-1)], dim=-1)


def fk(y: torch.Tensor) -> torch.Tensor:
    """Joint positions relative to the simulation bone, (B, J, 3), from pose vectors (B, YD)."""
    rots = sixd_to_mat(y[:, Y_ROT:Y_ROOT].reshape(-1, J, 6))
    world_r = [rots[:, 0]]
    world_p = [y[:, 0:3]]
    for j in range(1, J):
        p = parents[j]
        world_p.append(world_p[p] + (world_r[p] @ offsets[j].unsqueeze(-1)).squeeze(-1))
        world_r.append(world_r[p] @ rots[:, j])
    return torch.stack(world_p, dim=1)


Q = fk(Y)  # ground-truth joint positions

# ------------------------------------------------------------------------------------------------- 1. compressor + decompressor

compressor = mlp([YD + J * 3, 512, 512, 512, Z_DIMS])
decompressor = mlp([XD + Z_DIMS, 256, 256, YD])


def decompress(x: torch.Tensor, z: torch.Tensor) -> torch.Tensor:
    return decompressor(torch.cat([(x - x_mean) / x_std, z], -1)) * y_std + y_mean


def compress(y: torch.Tensor, q: torch.Tensor) -> torch.Tensor:
    return compressor(torch.cat([(y - y_mean) / y_std, q.reshape(len(q), -1)], -1))


pairs = np.nonzero(has_next)[0]


def train_decompressor(iterations: int) -> None:
    opt = torch.optim.AdamW(list(compressor.parameters()) + list(decompressor.parameters()), lr=1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.ExponentialLR(opt, 0.99995)
    t0 = time.time()
    for it in range(iterations + 1):
        idx = torch.from_numpy(np.random.choice(pairs, 256))
        both = torch.cat([idx, idx + 1])
        z = compress(Y[both], Q[both])
        y = decompress(X[both], z)
        q = fk(y)
        y0, y1 = y[:256], y[256:]
        q0, q1 = q[:256], q[256:]
        loss_y = ((y - Y[both]) / y_std).abs().mean()
        loss_q = (q - Q[both]).abs().mean() * 25  # ~1 per 4 cm
        loss_vy = (((y1 - y0) - (Y[idx + 1] - Y[idx])) / y_std).abs().mean() * 5
        loss_vq = ((q1 - q0) - (Q[idx + 1] - Q[idx])).abs().mean() * 250
        loss_z = z.abs().mean() * 0.01 + (z**2).mean() * 0.01
        loss = loss_y + loss_q + loss_vy + loss_vq + loss_z
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if it % 2000 == 0:
            print(f"decompressor {it}: y {loss_y.item():.4f} pos {loss_q.item() / 25 * 100:.2f} cm vel {loss_vq.item() / 250 * 100:.3f} cm/frame | {time.time() - t0:.0f}s", flush=True)


# ------------------------------------------------------------------------------------------------- 2. stepper

stepper = mlp([XD + Z_DIMS, 256, 256, XD + Z_DIMS])


def train_stepper(Z: torch.Tensor, iterations: int, window: int = 20) -> None:
    z_mean, z_std = stats(Z)
    xz = torch.cat([X, Z], -1)
    xz_mean = torch.cat([x_mean, z_mean])
    xz_std = torch.cat([x_std, z_std])
    # Delta statistics normalise the stepper's output.
    nxt = torch.from_numpy(pairs)
    d = xz[nxt + 1] - xz[nxt]
    d_mean, d_std = stats(d)
    stepper.stats = (xz_mean, xz_std, d_mean, d_std)  # type: ignore[attr-defined]
    # Window starts with `window` frames in the same take.
    ok = np.ones(N, dtype=bool)
    for k in range(window):
        ok &= np.roll(has_next, -k)
    starts = np.nonzero(ok[: N - window])[0]
    opt = torch.optim.AdamW(stepper.parameters(), lr=1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.ExponentialLR(opt, 0.99995)
    t0 = time.time()
    for it in range(iterations + 1):
        s = torch.from_numpy(np.random.choice(starts, 64))
        cur = xz[s]
        loss = 0.0
        for k in range(1, window):
            delta = stepper((cur - xz_mean) / xz_std) * d_std + d_mean
            cur = cur + delta
            target = xz[s + k]
            loss = loss + ((cur - target) / xz_std).abs().mean() + ((delta - (xz[s + k] - xz[s + k - 1])) / d_std).abs().mean() * 0.5
        loss = loss / (window - 1)
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if it % 1000 == 0:
            print(f"stepper {it}: {loss.item():.4f} | {time.time() - t0:.0f}s", flush=True)


def step(xz: torch.Tensor) -> torch.Tensor:
    xz_mean, xz_std, d_mean, d_std = stepper.stats  # type: ignore[attr-defined]
    return xz + stepper((xz - xz_mean) / xz_std) * d_std + d_mean


# ------------------------------------------------------------------------------------------------- 3. projector

projector = mlp([XD, 256, 256, 256, XD + Z_DIMS])
cand = torch.from_numpy(np.nonzero(matchable)[0])
sw = feature_weights.sqrt()
Xc_w = X[cand] * sw


def nearest(q: torch.Tensor) -> torch.Tensor:
    """Index (into the database) of the weighted nearest matchable frame — study 09's search."""
    d = torch.cdist(q * sw, Xc_w)
    return cand[d.argmin(1)]


def train_projector(Z: torch.Tensor, iterations: int) -> None:
    z_mean, z_std = stats(Z)
    xz = torch.cat([X, Z], -1)
    xz_mean = torch.cat([x_mean, z_mean])
    xz_std = torch.cat([x_std, z_std])
    projector.stats = (xz_mean, xz_std)  # type: ignore[attr-defined]
    opt = torch.optim.AdamW(projector.parameters(), lr=1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.ExponentialLR(opt, 0.99995)
    t0 = time.time()
    for it in range(iterations + 1):
        idx = torch.from_numpy(np.random.randint(0, N, 512))
        # Queries near the data at a spread of distances, as the controller produces them.
        noise = torch.randn(512, XD) * torch.rand(512, 1) * 1.0
        q = X[idx] + noise
        with torch.no_grad():
            nn_idx = nearest(q)
        out = projector((q - x_mean) / x_std) * xz_std + xz_mean
        target = xz[nn_idx]
        loss = ((out - target) / xz_std).abs().mean()
        # The projected features should be as close to the query as the true neighbour is.
        loss = loss + (((out[:, :XD] - q) * sw).norm(dim=1) - ((target[:, :XD] - q) * sw).norm(dim=1)).abs().mean() * 0.3
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if it % 2000 == 0:
            print(f"projector {it}: {loss.item():.4f} | {time.time() - t0:.0f}s", flush=True)


def project(q: torch.Tensor) -> torch.Tensor:
    xz_mean, xz_std = projector.stats  # type: ignore[attr-defined]
    return projector((q - x_mean) / x_std) * xz_std + xz_mean


# ------------------------------------------------------------------------------------------------- export


def b64(t: torch.Tensor) -> str:
    """Half precision: the runtime networks are the size argument for LMM, and f16 costs ~nothing in accuracy."""
    return base64.b64encode(t.detach().numpy().astype("<f2").tobytes()).decode()


def export_mlp(m: nn.Sequential) -> list[dict]:
    return [{"in": l.in_features, "out": l.out_features, "weight": b64(l.weight), "bias": b64(l.bias)} for l in m if isinstance(l, nn.Linear)]


def main() -> None:
    import sys

    scale = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
    train_decompressor(int(40000 * scale))
    with torch.no_grad():
        Z = compress(Y, Q)
        rec = decompress(X, Z)
        err_cm = (fk(rec) - Q).norm(dim=-1).mean().item() * 100
        print(f"reconstruction: mean joint error {err_cm:.2f} cm")
    train_stepper(Z, int(20000 * scale))
    train_projector(Z, int(30000 * scale))
    xz_mean, xz_std, d_mean, d_std = stepper.stats  # type: ignore[attr-defined]
    p_mean, p_std = projector.stats  # type: ignore[attr-defined]
    OUT.mkdir(parents=True, exist_ok=True)
    networks = {
        "about": "Learned Motion Matching networks for study 16, trained by training/lmm/train_lmm.py.",
        "xDims": XD,
        "zDims": Z_DIMS,
        "yDims": YD,
        "x": {"mean": X.mean(0).tolist(), "std": x_std.tolist()},
        "y": {"mean": y_mean.tolist(), "std": y_std.tolist()},
        "decompressor": export_mlp(decompressor),
        "stepper": {"layers": export_mlp(stepper), "inMean": xz_mean.tolist(), "inStd": xz_std.tolist(), "outMean": d_mean.tolist(), "outStd": d_std.tolist()},
        "projector": {"layers": export_mlp(projector), "outMean": p_mean.tolist(), "outStd": p_std.tolist()},
        # A few database frames and their (X, Z) for the TypeScript parity test.
        "fixture": {"frames": [0, 1000, 5000, 9000], "z": Z[[0, 1000, 5000, 9000]].tolist(), "y": rec[[0, 1000, 5000, 9000]].tolist()},
    }
    (OUT / "networks.json").write_text(json.dumps(networks))
    print(f"exported {(OUT / 'networks.json').stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
