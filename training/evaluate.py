"""
Evaluate a policy checkpoint deterministically (mean actions): velocity tracking per command, falls under
shoves, and gait quality — what reward curves do not show.

    uv run python evaluate.py runs/<run>/model_3000.pt
"""

from __future__ import annotations

import json
import math
import sys

import mujoco
import numpy as np
import torch

from env import NUM_ACT, NUM_OBS, POLICY_DT, DEFAULT_POSE, XML, apply_action, observe, quat_rotate_inverse
from ppo import ActorCritic
from train import HIDDEN

COMMANDS = {
    "stand": (0.0, 0.0, 0.0),
    "walk 0.5": (0.5, 0.0, 0.0),
    "trot 1.0": (1.0, 0.0, 0.0),
    "back 0.5": (-0.5, 0.0, 0.0),
    "side 0.4": (0.0, 0.4, 0.0),
    "turn 1.0": (0.0, 0.0, 1.0),
    "arc": (0.7, 0.0, 0.6),
}


def run(ac: ActorCritic, command: tuple[float, float, float], seconds: float, push_every: float = 0.0, push: float = 0.0, seed: int = 0) -> dict:
    model = mujoco.MjModel.from_xml_path(str(XML))
    data = mujoco.MjData(model)
    rng = np.random.default_rng(seed)
    data.qpos[0:3] = [0, 0, 0.33]
    data.qpos[3:7] = [1, 0, 0, 0]
    data.qpos[7:19] = DEFAULT_POSE
    data.ctrl[:] = DEFAULT_POSE
    mujoco.mj_forward(model, data)
    feet = [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, n) for n in ("FR_foot", "FL_foot", "RR_foot", "RL_foot")]
    floor = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "floor")
    trunk = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "trunk")
    cmd = np.array(command)
    last = np.zeros(NUM_ACT)
    steps = int(seconds / POLICY_DT)
    vel_err, yaw_err = [], []
    contact_hist = []
    clearance = [[] for _ in range(4)]
    action_rate = []
    fell = False
    for k in range(steps):
        o = observe(data.qpos, data.qvel, cmd, last)
        with torch.no_grad():
            a = ac.actor(torch.as_tensor(o, dtype=torch.float32)[None])[0].numpy().astype(np.float64)
        action_rate.append(np.sum((a - last) ** 2))
        apply_action(model, data, a)
        last = a
        if push_every and k > 0 and k % int(push_every / POLICY_DT) == 0:
            ang = rng.uniform(-math.pi, math.pi)
            data.qvel[0:2] += push * np.array([math.cos(ang), math.sin(ang)])
        lin = quat_rotate_inverse(data.qpos[3:7], data.qvel[0:3])
        if k * POLICY_DT > 2.0:  # skip the start-up transient
            vel_err.append(np.linalg.norm(lin[:2] - cmd[:2]))
            yaw_err.append(abs(data.qvel[5] - cmd[2]))
        c = np.zeros(4, dtype=bool)
        touching_trunk = False
        for i in range(data.ncon):
            con = data.contact[i]
            other = con.geom2 if con.geom1 == floor else con.geom1 if con.geom2 == floor else -1
            if other in feet:
                c[feet.index(other)] = True
            if other == trunk:
                touching_trunk = True
        contact_hist.append(c)
        for j, g in enumerate(feet):
            if not c[j]:
                clearance[j].append(data.geom_xpos[g][2] - 0.022)
        gravity = quat_rotate_inverse(data.qpos[3:7], np.array([0, 0, -1.0]))
        if touching_trunk or gravity[2] > -0.5 or data.qpos[2] < 0.12:
            fell = True
            break
    ch = np.array(contact_hist)
    # Step frequency: touchdowns per foot per second; air time: mean length of swing phases.
    touchdowns = np.sum((~ch[:-1]) & ch[1:], axis=0) if len(ch) > 1 else np.zeros(4)
    duration = len(ch) * POLICY_DT
    air_runs = []
    for j in range(4):
        run_len = 0
        for v in ch[:, j]:
            if not v:
                run_len += 1
            elif run_len:
                air_runs.append(run_len * POLICY_DT)
                run_len = 0
    return {
        "fell": fell,
        "seconds": round(duration, 2),
        "vel_err": round(float(np.mean(vel_err)), 3) if vel_err else None,
        "yaw_err": round(float(np.mean(yaw_err)), 3) if yaw_err else None,
        "step_hz": round(float(np.mean(touchdowns) / max(duration, 1e-9)), 2),
        "air_time": round(float(np.mean(air_runs)), 3) if air_runs else 0.0,
        "duty": round(float(np.mean(ch)), 2),
        "clearance_cm": round(100 * float(np.mean([np.percentile(c, 90) for c in clearance if len(c) > 5] or [0])), 1),
        "action_rate": round(float(np.mean(action_rate)), 3),
    }


def main(path: str) -> None:
    ac = ActorCritic(NUM_OBS, NUM_ACT, HIDDEN)
    ac.load_state_dict(torch.load(path)["model"])
    out = {name: run(ac, cmd, 10.0) for name, cmd in COMMANDS.items()}
    pushes = [run(ac, (0.6, 0, 0), 20.0, push_every=2.0, push=1.0, seed=s) for s in range(10)]
    out["shoved (1 m/s every 2 s, 10 × 20 s)"] = {"falls": sum(p["fell"] for p in pushes)}
    mild = [run(ac, (0.6, 0, 0), 20.0, push_every=4.0, push=0.6, seed=s) for s in range(10)]
    out["shoved (0.6 m/s every 4 s, 10 × 20 s)"] = {"falls": sum(p["fell"] for p in mild)}
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
