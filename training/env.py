"""
Quadruped velocity-tracking environment (study 13).

The policy runs at 50 Hz: every step it outputs 12 joint-position offsets, the PD actuators in quadruped.xml
track `DEFAULT_POSE + ACTION_SCALE * action` for DECIMATION physics steps of 5 ms, and the observation is read
back. `observe()` and `apply_action()` are mirrored line for line by demos/13-rl-locomotion/policyEnv.ts and
checked against a recorded fixture, so the browser runs exactly the controller that was trained.

Rewards follow legged_gym (Rudin et al., "Learning to Walk in Minutes Using Massively Parallel Deep RL", 2021):
exponential velocity tracking, plus penalties that make the motion smooth enough to look like a gait rather than
vibration, and a feet-air-time term that encourages real steps.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import mujoco
import numpy as np

XML = Path(__file__).with_name("quadruped.xml")

DT = 0.005
DECIMATION = 4
POLICY_DT = DT * DECIMATION
ACTION_SCALE = 0.25
# FR, FL, RR, RL × (hip, thigh, calf)
DEFAULT_POSE = np.array([0.0, 0.8, -1.6] * 4)
NUM_OBS = 48
NUM_ACT = 12

# Observation scales (legged_gym defaults).
LIN_VEL_SCALE = 2.0
ANG_VEL_SCALE = 0.25
DOF_VEL_SCALE = 0.05
COMMAND_SCALE = np.array([LIN_VEL_SCALE, LIN_VEL_SCALE, ANG_VEL_SCALE])
CLIP_ACTIONS = 100.0


def quat_rotate_inverse(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rotate world vector v into the frame of unit quaternion q = (w, x, y, z)."""
    w, x, y, z = q
    # R^T v, written out so the TypeScript mirror is a direct transcription.
    return np.array(
        [
            (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y + w * z) * v[1] + 2 * (x * z - w * y) * v[2],
            2 * (x * y - w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z + w * x) * v[2],
            2 * (x * z + w * y) * v[0] + 2 * (y * z - w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2],
        ]
    )


def observe(qpos: np.ndarray, qvel: np.ndarray, command: np.ndarray, last_action: np.ndarray) -> np.ndarray:
    """48-D observation. qvel of a free joint is (world linear, body angular)."""
    quat = qpos[3:7]
    lin_vel = quat_rotate_inverse(quat, qvel[0:3])
    ang_vel = qvel[3:6]
    gravity = quat_rotate_inverse(quat, np.array([0.0, 0.0, -1.0]))
    return np.concatenate(
        [
            lin_vel * LIN_VEL_SCALE,
            ang_vel * ANG_VEL_SCALE,
            gravity,
            command * COMMAND_SCALE,
            qpos[7:19] - DEFAULT_POSE,
            qvel[6:18] * DOF_VEL_SCALE,
            last_action,
        ]
    )


def apply_action(model: mujoco.MjModel, data: mujoco.MjData, action: np.ndarray) -> None:
    data.ctrl[:] = DEFAULT_POSE + ACTION_SCALE * np.clip(action, -CLIP_ACTIONS, CLIP_ACTIONS)
    for _ in range(DECIMATION):
        mujoco.mj_step(model, data)


@dataclass
class EnvConfig:
    episode_seconds: float = 20.0
    command_seconds: float = 10.0
    vx: tuple[float, float] = (-1.0, 1.2)
    vy: tuple[float, float] = (-0.6, 0.6)
    yaw: tuple[float, float] = (-1.2, 1.2)
    stand_fraction: float = 0.1
    push_seconds: float = 4.0
    push_speed: float = 1.2
    friction: tuple[float, float] = (0.6, 1.25)
    rewards: dict[str, float] = field(
        default_factory=lambda: {
            "tracking_lin_vel": 1.0,
            "tracking_ang_vel": 0.5,
            "lin_vel_z": -2.0,
            "ang_vel_xy": -0.05,
            "orientation": -1.0,
            "base_height": -10.0,
            "torques": -2e-4,
            "dof_acc": -2.5e-7,
            "action_rate": -0.01,
            "collision": -1.0,
            "feet_air_time": 1.0,
            "stand_still": -0.5,
            "dof_pos_limits": -5.0,
            # Swing feet moving fast close to the ground: scuffing. Pushes the gait toward clear steps.
            "feet_clearance": -8.0,
        }
    )
    tracking_sigma: float = 0.25
    clearance_target: float = 0.07
    base_height_target: float = 0.26


class QuadrupedEnv:
    """A batch of independent simulations sharing one model, stepped in a Python loop."""

    def __init__(self, num_envs: int, seed: int, cfg: EnvConfig | None = None):
        self.cfg = cfg or EnvConfig()
        self.model = mujoco.MjModel.from_xml_path(str(XML))
        self.num_envs = num_envs
        self.rng = np.random.default_rng(seed)
        self.datas = [mujoco.MjData(self.model) for _ in range(num_envs)]
        m = self.model
        self.foot_geoms = [mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, n) for n in ("FR_foot", "FL_foot", "RR_foot", "RL_foot")]
        self.floor = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "floor")
        self.trunk_geom = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "trunk")
        self.joint_low = m.jnt_range[1:, 0].copy()
        self.joint_high = m.jnt_range[1:, 1].copy()
        self.default_friction = m.geom_friction.copy()

        n = num_envs
        self.commands = np.zeros((n, 3))
        self.last_actions = np.zeros((n, NUM_ACT))
        self.last_dof_vel = np.zeros((n, NUM_ACT))
        self.air_time = np.zeros((n, 4))
        self.last_contacts = np.zeros((n, 4), dtype=bool)
        self.episode_steps = np.zeros(n, dtype=np.int64)
        self.command_steps = np.zeros(n, dtype=np.int64)
        self.push_steps = np.zeros(n, dtype=np.int64)
        self.frictions = np.ones(n)
        self.episode_sums: dict[str, np.ndarray] = {k: np.zeros(n) for k in self.cfg.rewards}
        # Per-second reward terms of finished episodes, for logging.
        self.finished: list[dict[str, float]] = []
        self.last_feet = np.zeros((n, 4, 3))
        self.obs = np.zeros((n, NUM_OBS), dtype=np.float32)
        self.max_steps = int(self.cfg.episode_seconds / POLICY_DT)
        for i in range(n):
            self._reset(i)
            # Stagger episodes so resets do not all happen together.
            self.episode_steps[i] = self.rng.integers(0, self.max_steps)

    # ------------------------------------------------------------------ resets and commands

    def _sample_command(self, i: int) -> None:
        c = self.cfg
        if self.rng.random() < c.stand_fraction:
            self.commands[i] = 0.0
        else:
            self.commands[i] = [self.rng.uniform(*c.vx), self.rng.uniform(*c.vy), self.rng.uniform(*c.yaw)]
            # Tiny planar commands are noise: treat them as standing.
            if np.linalg.norm(self.commands[i, :2]) < 0.2:
                self.commands[i, :2] = 0.0
        self.command_steps[i] = 0

    def _reset(self, i: int) -> None:
        d = self.datas[i]
        mujoco.mj_resetData(self.model, d)
        yaw = self.rng.uniform(-math.pi, math.pi)
        d.qpos[0:3] = [self.rng.uniform(-1, 1), self.rng.uniform(-1, 1), 0.33]
        d.qpos[3:7] = [math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)]
        d.qpos[7:19] = DEFAULT_POSE * self.rng.uniform(0.8, 1.2, NUM_ACT)
        d.qvel[0:6] = self.rng.uniform(-0.3, 0.3, 6)
        d.ctrl[:] = DEFAULT_POSE
        mujoco.mj_forward(self.model, d)
        self.frictions[i] = self.rng.uniform(*self.cfg.friction)
        self.last_actions[i] = 0
        self.last_dof_vel[i] = 0
        self.air_time[i] = 0
        self.last_contacts[i] = False
        self.episode_steps[i] = 0
        self.push_steps[i] = 0
        self._sample_command(i)
        self.last_feet[i] = d.geom_xpos[self.foot_geoms]
        self.obs[i] = observe(d.qpos, d.qvel, self.commands[i], self.last_actions[i])

    # ------------------------------------------------------------------ stepping

    def _contacts(self, d: mujoco.MjData) -> tuple[np.ndarray, int, bool]:
        feet = np.zeros(4, dtype=bool)
        legs = 0
        trunk = False
        for k in range(d.ncon):
            con = d.contact[k]
            g1, g2 = con.geom1, con.geom2
            other = g2 if g1 == self.floor else g1 if g2 == self.floor else -1
            if other < 0:
                continue
            if other == self.trunk_geom:
                trunk = True
            elif other in self.foot_geoms:
                feet[self.foot_geoms.index(other)] = True
            else:
                legs += 1
        return feet, legs, trunk

    def step(self, actions: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
        cfg = self.cfg
        w = cfg.rewards
        n = self.num_envs
        rewards = np.zeros(n)
        dones = np.zeros(n, dtype=bool)
        timeouts = np.zeros(n, dtype=bool)
        actions = np.clip(actions, -CLIP_ACTIONS, CLIP_ACTIONS)
        friction = self.model.geom_friction
        for i in range(n):
            d = self.datas[i]
            friction[:, 0] = self.default_friction[:, 0] * self.frictions[i]
            apply_action(self.model, d, actions[i])

            quat = d.qpos[3:7]
            lin_vel = quat_rotate_inverse(quat, d.qvel[0:3])
            ang_vel = d.qvel[3:6]
            gravity = quat_rotate_inverse(quat, np.array([0.0, 0.0, -1.0]))
            dof_pos = d.qpos[7:19]
            dof_vel = d.qvel[6:18]
            cmd = self.commands[i]
            feet, legs, trunk = self._contacts(d)

            first_contact = (self.air_time[i] > 0) & feet
            self.air_time[i] += POLICY_DT
            moving_cmd = np.linalg.norm(cmd[:2]) > 0.1 or abs(cmd[2]) > 0.1
            air = np.sum((self.air_time[i] - 0.5) * first_contact) * moving_cmd
            self.air_time[i][feet] = 0.0

            torques = d.actuator_force
            feet_pos = d.geom_xpos[self.foot_geoms]
            feet_speed = np.linalg.norm((feet_pos[:, :2] - self.last_feet[i][:, :2]) / POLICY_DT, axis=1)
            self.last_feet[i] = feet_pos
            height = feet_pos[:, 2] - 0.022
            clearance = np.sum(np.clip(cfg.clearance_target - height, 0, None) ** 2 * feet_speed * ~feet)
            over = np.clip(dof_pos - self.joint_high * 0.95, 0, None) + np.clip(self.joint_low * 0.95 - dof_pos, 0, None)
            terms = {
                "tracking_lin_vel": math.exp(-np.sum((cmd[:2] - lin_vel[:2]) ** 2) / cfg.tracking_sigma),
                "tracking_ang_vel": math.exp(-((cmd[2] - ang_vel[2]) ** 2) / cfg.tracking_sigma),
                "lin_vel_z": lin_vel[2] ** 2,
                "ang_vel_xy": np.sum(ang_vel[:2] ** 2),
                "orientation": np.sum(gravity[:2] ** 2),
                "base_height": (d.qpos[2] - cfg.base_height_target) ** 2,
                "torques": np.sum(torques**2),
                "dof_acc": np.sum(((self.last_dof_vel[i] - dof_vel) / POLICY_DT) ** 2),
                "action_rate": np.sum((self.last_actions[i] - actions[i]) ** 2),
                "collision": float(legs),
                "feet_air_time": air,
                "stand_still": np.sum(np.abs(dof_pos - DEFAULT_POSE)) * (not moving_cmd),
                "dof_pos_limits": np.sum(over),
                "feet_clearance": clearance,
            }
            r = 0.0
            for k, v in terms.items():
                val = v * w[k] * POLICY_DT
                r += val
                self.episode_sums[k][i] += val
            rewards[i] = r

            self.last_actions[i] = actions[i]
            self.last_dof_vel[i] = dof_vel
            self.episode_steps[i] += 1
            self.command_steps[i] += 1
            self.push_steps[i] += 1

            fell = trunk or gravity[2] > -0.5 or d.qpos[2] < 0.12 or not np.all(np.isfinite(d.qpos))
            timeout = self.episode_steps[i] >= self.max_steps
            if fell or timeout:
                seconds = max(POLICY_DT, self.episode_steps[i] * POLICY_DT)
                self.finished.append({k: float(v[i]) / seconds for k, v in self.episode_sums.items()})
                for v in self.episode_sums.values():
                    v[i] = 0.0
                dones[i] = True
                timeouts[i] = timeout and not fell
                self._reset(i)
                continue
            if self.command_steps[i] * POLICY_DT >= cfg.command_seconds:
                self._sample_command(i)
            if self.push_steps[i] * POLICY_DT >= cfg.push_seconds:
                # A shove: what the mouse does in the browser.
                d.qvel[0:2] += self.rng.uniform(-cfg.push_speed, cfg.push_speed, 2)
                self.push_steps[i] = 0
            self.obs[i] = observe(d.qpos, d.qvel, cmd, self.last_actions[i])
        friction[:, 0] = self.default_friction[:, 0]
        return self.obs.copy(), rewards.astype(np.float32), dones, {"timeouts": timeouts}
