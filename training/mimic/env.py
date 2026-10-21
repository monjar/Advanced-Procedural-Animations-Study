"""
Motion-imitation environment for study 21 (DeepMimic: Peng, Abbeel, Levine & van de Panne, SIGGRAPH 2018).

A MuJoCo humanoid (built from the CMU skeleton by humanoid.py) learns to reproduce one looping mocap clip
under physics. Every 30 ms the policy sees its own state, the clip's phase and the clip's next pose, and outputs
corrections to that pose; PD servos track pose + correction for 15 physics steps of 2 ms.

From DeepMimic:
  - the imitation reward: pose, joint velocity, end-effector and root terms, each exp(−k·error²);
  - reference state initialisation: episodes start at a random phase of the clip, in the clip's state;
  - early termination: anything but the feet touching the floor ends the episode.
Departures (to train on a CPU in an hour): the action is a residual on the reference pose rather than an
absolute PD target, and every quantity is measured in the character's own heading frame, so the clip follows
the character instead of pinning it to the mocap's world path — the reward asks for the motion, not the place.

`observe()` / `apply_action()` / `Reference` are mirrored in demos/21-physics-mocap/mimic.ts and checked
against a recorded fixture.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import mujoco
import numpy as np

ASSETS = Path(__file__).resolve().parents[2] / "public" / "assets" / "mimic"
XML = ASSETS / "humanoid.xml"
CLIPS = ASSETS / "clips.json"

DT = 0.002
DECIMATION = 15
POLICY_DT = DT * DECIMATION
ACTION_SCALE = 0.4
NUM_ACT = 28
END_EFFECTORS = ["l_forearm", "r_forearm", "l_foot", "r_foot"]
# End-effector points in their bodies' frames: hands at the forearm's far end, feet at the toes' base.
NUM_OBS = 2 + 1 + 3 + 3 + 3 + NUM_ACT + NUM_ACT + NUM_ACT + 3 * len(END_EFFECTORS) + 3


# ------------------------------------------------------------------------------------------ small math


def quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw])


def quat_rotate_inverse(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rotate world vector v into the frame of unit quaternion q = (w, x, y, z)."""
    w, x, y, z = q
    return np.array(
        [
            (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y + w * z) * v[1] + 2 * (x * z - w * y) * v[2],
            2 * (x * y - w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z + w * x) * v[2],
            2 * (x * z + w * y) * v[0] + 2 * (y * z - w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2],
        ]
    )


def yaw_of(q: np.ndarray) -> float:
    w, x, y, z = q
    return math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def to_heading(yaw: float, v: np.ndarray) -> np.ndarray:
    """World vector → the heading frame (yaw removed)."""
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]])


def slerp(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        r = a + t * (b - a)
        return r / np.linalg.norm(r)
    th = math.acos(d)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)


# ------------------------------------------------------------------------------------------ reference


class Reference:
    """A looping clip sampled at any time, with the per-cycle root displacement applied."""

    def __init__(self, clip: dict, fps: float):
        self.q = np.array(clip["qpos"], dtype=np.float64)
        self.n = len(self.q)
        self.fps = fps
        self.period = self.n / fps
        c = clip["cycle"]
        self.dx, self.dy, self.dyaw = c["dx"], c["dy"], c["dyaw"]

    def qpos(self, t: float) -> np.ndarray:
        cycles = math.floor(t / self.period)
        u = (t - cycles * self.period) * self.fps
        i = int(math.floor(u)) % self.n
        a = u - math.floor(u)
        j = (i + 1) % self.n
        qa = self.q[i]
        qb = self.q[j].copy()
        if j == 0:
            # Wrapping into the next cycle: the first frame, moved by one cycle.
            qb = self._shift(qb, 1)
        out = np.empty(35)
        out[0:3] = qa[0:3] + a * (qb[0:3] - qa[0:3])
        out[3:7] = slerp(qa[3:7], qb[3:7], a)
        out[7:] = qa[7:] + a * (qb[7:] - qa[7:])
        return self._shift(out, cycles)

    def _shift(self, q: np.ndarray, k: int) -> np.ndarray:
        if k == 0:
            return q
        yaw = k * self.dyaw
        c, s = math.cos(yaw), math.sin(yaw)
        # k cycles of displacement, each rotated by the accumulated yaw drift (a geometric sum of rotations);
        # backwards (k < 0) the same steps are taken off.
        ox = oy = 0.0
        for m in range(k) if k > 0 else range(k, 0):
            cm, sm = math.cos(m * self.dyaw), math.sin(m * self.dyaw)
            sign = 1.0 if k > 0 else -1.0
            ox += sign * (cm * self.dx - sm * self.dy)
            oy += sign * (sm * self.dx + cm * self.dy)
        out = q.copy()
        out[0] = c * q[0] - s * q[1] + ox
        out[1] = s * q[0] + c * q[1] + oy
        out[3:7] = quat_mul(np.array([math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)]), q[3:7])
        return out

    def qvel(self, model: mujoco.MjModel, t: float, h: float = 1 / 120) -> np.ndarray:
        v = np.zeros(34)
        mujoco.mj_differentiatePos(model, v, 2 * h, self.qpos(t - h), self.qpos(t + h))
        return v


def load_reference(name: str) -> Reference:
    data = json.loads(CLIPS.read_text())
    return Reference(data["clips"][name], data["fps"])


# ------------------------------------------------------------------------------------------ observation


def ee_positions(model: mujoco.MjModel, data: mujoco.MjData, ee_ids: list[int], yaw: float) -> np.ndarray:
    """End effectors relative to the root, in the heading frame (12)."""
    root = data.xpos[1]
    return np.concatenate([to_heading(yaw, data.xpos[b] - root) for b in ee_ids])


def observe(model: mujoco.MjModel, data: mujoco.MjData, ee_ids: list[int], phase: float, ref_next: np.ndarray, ref_vel: np.ndarray) -> np.ndarray:
    """
    phase (sin, cos) · root height · gravity in the root frame · root velocity (heading frame) · angular
    velocity (root frame) · joint angles · joint velocities · the clip's next joint angles · end effectors ·
    the clip's root velocity (heading frame).
    """
    q, v = data.qpos, data.qvel
    quat = q[3:7]
    yaw = yaw_of(quat)
    return np.concatenate(
        [
            [math.sin(2 * math.pi * phase), math.cos(2 * math.pi * phase)],
            [q[2]],
            quat_rotate_inverse(quat, np.array([0.0, 0.0, -1.0])),
            to_heading(yaw, v[0:3]),
            v[3:6] * 0.25,
            q[7:],
            v[6:] * 0.05,
            ref_next[7:],
            ee_positions(model, data, ee_ids, yaw),
            to_heading(yaw_of(ref_next[3:7]), ref_vel[0:3]),
        ]
    ).astype(np.float32)


def apply_action(model: mujoco.MjModel, data: mujoco.MjData, ref_next: np.ndarray, action: np.ndarray) -> None:
    data.ctrl[:] = ref_next[7:] + ACTION_SCALE * np.clip(action, -3, 3)
    mujoco.mj_step(model, data, DECIMATION)


# ------------------------------------------------------------------------------------------ batched env


class MimicEnv:
    def __init__(self, num_envs: int, seed: int, clip: str = "walk", episode_seconds: float = 10.0, pushes: bool = True):
        self.model = mujoco.MjModel.from_xml_path(str(XML))
        self.ref = load_reference(clip)
        self.num_envs = num_envs
        self.rng = np.random.default_rng(seed)
        self.datas = [mujoco.MjData(self.model) for _ in range(num_envs)]
        self.ref_data = mujoco.MjData(self.model)
        m = self.model
        self.ee_ids = [mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, n) for n in END_EFFECTORS]
        self.floor = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "floor")
        foot_bodies = {mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, n) for n in ("l_foot", "r_foot")}
        self.allowed = {g for g in range(m.ngeom) if m.geom_bodyid[g] in foot_bodies}
        self.max_steps = int(episode_seconds / POLICY_DT)
        self.pushes = pushes
        n = num_envs
        self.t = np.zeros(n)
        # Each episode plays the clip rotated by its own yaw and shifted to start at the env's position.
        self.offset_yaw = np.zeros(n)
        self.steps = np.zeros(n, dtype=np.int64)
        self.next_push = np.zeros(n)
        self.obs = np.zeros((n, NUM_OBS), dtype=np.float32)
        self.terms = {k: np.zeros(n) for k in ("pose", "vel", "ee", "root")}
        self.finished: list[dict[str, float]] = []
        self.ref_next = [np.zeros(35)] * n
        for i in range(n):
            self._reset(i)
            self.steps[i] = self.rng.integers(0, self.max_steps)

    def _ref(self, i: int, t: float) -> np.ndarray:
        """The clip at time t, rotated by the episode's yaw about the origin."""
        q = self.ref.qpos(t)
        yaw = self.offset_yaw[i]
        c, s = math.cos(yaw), math.sin(yaw)
        out = q.copy()
        out[0] = c * q[0] - s * q[1]
        out[1] = s * q[0] + c * q[1]
        out[3:7] = quat_mul(np.array([math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)]), q[3:7])
        return out

    def _ref_vel(self, i: int, t: float, h: float = 1 / 120) -> np.ndarray:
        v = np.zeros(34)
        mujoco.mj_differentiatePos(self.model, v, 2 * h, self._ref(i, t - h), self._ref(i, t + h))
        return v

    def _reset(self, i: int) -> None:
        d = self.datas[i]
        mujoco.mj_resetData(self.model, d)
        self.t[i] = self.rng.uniform(0, self.ref.period)
        self.offset_yaw[i] = self.rng.uniform(-math.pi, math.pi)
        d.qpos[:] = self._ref(i, self.t[i])
        d.qvel[:] = self._ref_vel(i, self.t[i])
        mujoco.mj_forward(self.model, d)
        self.steps[i] = 0
        self.next_push[i] = self.rng.uniform(1.5, 4.0)
        for k in self.terms:
            self.terms[k][i] = 0
        self._observe(i)

    def _observe(self, i: int) -> None:
        tn = self.t[i] + POLICY_DT
        self.ref_next[i] = self._ref(i, tn)
        self.obs[i] = observe(self.model, self.datas[i], self.ee_ids, (tn / self.ref.period) % 1.0, self.ref_next[i], self._ref_vel(i, tn))

    def _fallen(self, d: mujoco.MjData) -> bool:
        if d.qpos[2] < 0.55:
            return True
        for k in range(d.ncon):
            c = d.contact[k]
            other = c.geom2 if c.geom1 == self.floor else c.geom1 if c.geom2 == self.floor else -1
            if other >= 0 and other not in self.allowed:
                return True
        return False

    def _reward(self, i: int, d: mujoco.MjData) -> tuple[float, dict[str, float]]:
        ref_q = self._ref(i, self.t[i])
        ref_v = self._ref_vel(i, self.t[i])
        rd = self.ref_data
        rd.qpos[:] = ref_q
        mujoco.mj_kinematics(self.model, rd)
        yaw, ref_yaw = yaw_of(d.qpos[3:7]), yaw_of(ref_q[3:7])
        pose_err = float(np.sum((d.qpos[7:] - ref_q[7:]) ** 2))
        vel_err = float(np.sum((d.qvel[6:] - ref_v[6:]) ** 2))
        ee_err = 0.0
        for b in self.ee_ids:
            ee_err += float(np.sum((to_heading(yaw, d.xpos[b] - d.xpos[1]) - to_heading(ref_yaw, rd.xpos[b] - rd.xpos[1])) ** 2))
        up = quat_rotate_inverse(d.qpos[3:7], np.array([0.0, 0.0, 1.0]))
        ref_up = quat_rotate_inverse(ref_q[3:7], np.array([0.0, 0.0, 1.0]))
        root_err = (
            10 * (d.qpos[2] - ref_q[2]) ** 2
            + float(np.sum((to_heading(yaw, d.qvel[0:3]) - to_heading(ref_yaw, ref_v[0:3])) ** 2))
            + 2 * float(np.sum((up - ref_up) ** 2))
            + 0.1 * float(np.sum((d.qvel[3:6] - ref_v[3:6]) ** 2))
        )
        terms = {
            "pose": math.exp(-2 * pose_err),
            "vel": math.exp(-0.005 * vel_err),
            "ee": math.exp(-40 * ee_err),
            "root": math.exp(-2 * root_err),
        }
        r = 0.5 * terms["pose"] + 0.1 * terms["vel"] + 0.15 * terms["ee"] + 0.25 * terms["root"]
        return r, terms

    def step(self, actions: np.ndarray):
        n = self.num_envs
        rewards = np.zeros(n)
        dones = np.zeros(n, dtype=bool)
        timeouts = np.zeros(n, dtype=bool)
        for i in range(n):
            d = self.datas[i]
            if self.pushes and self.steps[i] * POLICY_DT >= self.next_push[i]:
                ang = self.rng.uniform(-math.pi, math.pi)
                mag = self.rng.uniform(0.2, 0.7)
                d.qvel[0] += mag * math.cos(ang)
                d.qvel[1] += mag * math.sin(ang)
                self.next_push[i] += self.rng.uniform(2.0, 4.0)
            apply_action(self.model, d, self.ref_next[i], actions[i])
            self.t[i] += POLICY_DT
            self.steps[i] += 1
            r, terms = self._reward(i, d)
            for k, v in terms.items():
                self.terms[k][i] += v
            fallen = self._fallen(d)
            rewards[i] = 0.0 if fallen else r
            if fallen or self.steps[i] >= self.max_steps:
                dones[i] = True
                timeouts[i] = not fallen
                self.finished.append({k: float(self.terms[k][i] / max(1, self.steps[i])) for k in self.terms} | {"seconds": float(self.steps[i] * POLICY_DT)})
                self._reset(i)
            else:
                self._observe(i)
        return self.obs.copy(), rewards, dones, {"timeouts": timeouts}
