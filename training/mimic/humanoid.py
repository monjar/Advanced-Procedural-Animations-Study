"""
Build the study 21 humanoid from the CMU skeleton and retarget mocap clips onto it.

    uv run python mimic/humanoid.py        # reads mimic/takes.json, writes public/assets/mimic/{humanoid.xml,clips.json}

The humanoid's bodies sit where the CMU joints are in the rest pose (the database's rest frames are aligned
with the world, as in BVH), so retargeting needs no bone-length fitting: each body's local rotation is
inverse(parent world rotation) · own world rotation, split into hinge angles —

  - 3-DoF joints (torso, neck, shoulders, hips, ankles) as intrinsic Euler angles, in an order that keeps the
    large rotation off the middle axis (gimbal lock): flexion first for the legs and torso, the arm's drop
    from the T-pose first for the shoulders;
  - 1-DoF joints (elbows, knees) as the twist about an axis fitted to the data (the principal axis of the
    joint's rotation vectors), since the rest pose's knees and elbows are not aligned with any frame axis.

The CMU spine (LowerBack, Spine, Spine1) becomes one torso body, clavicles and toes are folded into their
neighbours: 28 actuated degrees of freedom, as in DeepMimic's humanoid.

Coordinates: the skeleton is y-up, facing +z, its left on +x. MuJoCo here is z-up and the character walks
along +x with its left on +y: (x, y, z)ᴹᴶ = (z, x, y)ˢᵏᵉˡ, a proper rotation, so quaternion vector parts permute
the same way.
"""

from __future__ import annotations

import json
from pathlib import Path

import mujoco
import numpy as np
from scipy.spatial.transform import Rotation as R

ROOT = Path(__file__).resolve().parents[2]
TAKES = Path(__file__).with_name("takes.json")
OUT = ROOT / "public" / "assets" / "mimic"

# body, CMU joint whose world rotation it follows, CMU joint it sits at, parent body, joint spec
#   spec: ("ball", euler order) or ("hinge", None) with the axis fitted from data
BODIES = [
    ("pelvis", "Hips", "Hips", None, ("free", None)),
    ("torso", "Spine1", "Hips", "pelvis", ("ball", "YXZ")),
    ("head", "Head", "Neck1", "torso", ("ball", "YXZ")),
    ("l_upper_arm", "LeftArm", "LeftArm", "torso", ("ball", "XZY")),
    ("l_forearm", "LeftForeArm", "LeftForeArm", "l_upper_arm", ("hinge", None)),
    ("r_upper_arm", "RightArm", "RightArm", "torso", ("ball", "XZY")),
    ("r_forearm", "RightForeArm", "RightForeArm", "r_upper_arm", ("hinge", None)),
    ("l_thigh", "LeftUpLeg", "LeftUpLeg", "pelvis", ("ball", "YXZ")),
    ("l_shin", "LeftLeg", "LeftLeg", "l_thigh", ("hinge", None)),
    ("l_foot", "LeftFoot", "LeftFoot", "l_shin", ("ball", "YXZ")),
    ("r_thigh", "RightUpLeg", "RightUpLeg", "pelvis", ("ball", "YXZ")),
    ("r_shin", "RightLeg", "RightLeg", "r_thigh", ("hinge", None)),
    ("r_foot", "RightFoot", "RightFoot", "r_shin", ("ball", "YXZ")),
]

# PD gains and torque limits per joint group (DeepMimic's humanoid uses similar ratios).
GAINS = {
    "torso": (600, 400),
    "head": (100, 60),
    "upper_arm": (250, 150),
    "forearm": (150, 100),
    "thigh": (500, 400),
    "shin": (500, 400),
    "foot": (300, 200),
}
END_EFFECTORS = ["l_forearm", "r_forearm", "l_foot", "r_foot"]

PERM = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], dtype=float)  # skeleton → MuJoCo


def to_mj_pos(p: np.ndarray) -> np.ndarray:
    return p @ PERM.T


def to_mj_quat(q: np.ndarray) -> np.ndarray:
    """xyzw quaternions, skeleton frame → MuJoCo frame (vector part permuted like positions)."""
    out = q.copy()
    out[..., 0:3] = q[..., 0:3] @ PERM.T
    return out


def group(body: str) -> str:
    return body.split("_", 1)[1] if body.startswith(("l_", "r_")) else body


def fmt(v) -> str:
    return " ".join(f"{x:.5f}" for x in np.atleast_1d(v))


def load():
    data = json.loads(TAKES.read_text())
    names = data["names"]
    idx = {n: i for i, n in enumerate(names)}
    rest = to_mj_pos(np.array(data["rest"], dtype=float).reshape(-1, 3))
    takes = {}
    for k, t in data["takes"].items():
        P = to_mj_pos(np.array(t["positions"], dtype=float).reshape(t["frames"], -1, 3))
        Q = to_mj_quat(np.array(t["rotations"], dtype=float).reshape(t["frames"], -1, 4))
        takes[k] = (P, Q)
    return data, idx, rest, takes


def local_rotations(idx, Q: np.ndarray) -> dict[str, R]:
    """Each body's rotation relative to its parent body, per frame."""
    world = {b: R.from_quat(Q[:, idx[src]]) for b, src, *_ in BODIES}
    out = {}
    for b, _src, _at, parent, _spec in BODIES:
        out[b] = world[b] if parent is None else world[parent].inv() * world[b]
    return out


def fit_hinge_axis(rots: list[R]) -> np.ndarray:
    """Principal axis of the rotation vectors (sign: positive mean angle)."""
    v = np.concatenate([r.as_rotvec() for r in rots])
    _, _, vt = np.linalg.svd(v - 0 * v.mean(0), full_matrices=False)
    axis = vt[0]
    if (v @ axis).mean() < 0:
        axis = -axis
    return axis / np.linalg.norm(axis)


def twist_angle(r: R, axis: np.ndarray) -> np.ndarray:
    q = r.as_quat()  # xyzw
    return 2 * np.arctan2(q[:, 0:3] @ axis, q[:, 3])


def joint_list(axes: dict[str, np.ndarray]):
    """(body, joint name, axis) in qpos order."""
    out = []
    for b, _src, _at, _parent, (kind, order) in BODIES:
        if kind == "ball":
            for c in order:
                out.append((b, f"{b}_{c.lower()}", np.eye(3)["XYZ".index(c)]))
        elif kind == "hinge":
            out.append((b, f"{b}_flex", axes[b]))
    return out


def retarget(idx, P, Q, axes) -> np.ndarray:
    """qpos per frame: pelvis position and quaternion (wxyz), then the 28 hinge angles."""
    loc = local_rotations(idx, Q)
    cols = []
    for b, _src, _at, _parent, (kind, order) in BODIES:
        if kind == "ball":
            e = loc[b].as_euler(order)  # intrinsic: R = R_a1 · R_a2 · R_a3, as MuJoCo composes successive hinges
            cols.append(np.unwrap(e, axis=0))
        elif kind == "hinge":
            cols.append(np.unwrap(twist_angle(loc[b], axes[b]))[:, None])
    hip = Q[:, idx["Hips"]]
    root = np.concatenate([P[:, idx["Hips"]], hip[:, 3:4], hip[:, 0:3]], axis=1)
    # Keep the root quaternion continuous.
    for f in range(1, len(root)):
        if np.dot(root[f, 3:7], root[f - 1, 3:7]) < 0:
            root[f, 3:7] *= -1
    return np.concatenate([root, *cols], axis=1)


def build_xml(rest: np.ndarray, idx, axes, ranges) -> str:
    pos = {b: rest[idx[at]] for b, _src, at, *_ in BODIES}
    parent_of = {b: p for b, _s, _a, p, _k in BODIES}
    children = {b: [c for c, p in parent_of.items() if p == b] for b in parent_of}
    jl = joint_list(axes)

    def geoms(b: str) -> str:
        r = lambda n: rest[idx[n]] - pos[b]  # noqa: E731
        g = []
        if b == "pelvis":
            g.append(f'<geom type="capsule" fromto="{fmt(r("LeftUpLeg"))} {fmt(r("RightUpLeg"))}" size="0.09"/>')
        elif b == "torso":
            top = r("Neck1")
            g.append(f'<geom type="capsule" fromto="0 0 0.1 {fmt(top * [1, 1, 0.75])}" size="0.11"/>')
            g.append(f'<geom type="capsule" fromto="{fmt(r("LeftArm") * [1, 0.85, 1])} {fmt(r("RightArm") * [1, 0.85, 1])}" size="0.06"/>')
        elif b == "head":
            g.append(f'<geom type="sphere" pos="{fmt(r("Head") + [0.02, 0, 0.05])}" size="0.1"/>')
        elif group(b) == "upper_arm":
            g.append(f'<geom type="capsule" fromto="0 0 0 {fmt(r(("Left" if b[0] == "l" else "Right") + "ForeArm"))}" size="0.045"/>')
        elif group(b) == "forearm":
            hand = r(("Left" if b[0] == "l" else "Right") + "Hand")
            g.append(f'<geom type="capsule" fromto="0 0 0 {fmt(hand)}" size="0.04"/>')
            g.append(f'<geom type="sphere" pos="{fmt(hand * 1.18)}" size="0.045"/>')
        elif group(b) == "thigh":
            g.append(f'<geom type="capsule" fromto="0 0 0 {fmt(r(("Left" if b[0] == "l" else "Right") + "Leg"))}" size="0.065"/>')
        elif group(b) == "shin":
            g.append(f'<geom type="capsule" fromto="0 0 0 {fmt(r(("Left" if b[0] == "l" else "Right") + "Foot"))}" size="0.05"/>')
        elif group(b) == "foot":
            toe = r(("Left" if b[0] == "l" else "Right") + "ToeBase")
            # A box from the heel to past the toe joint, its sole level with the ankle's lowest point.
            heel, tip = -0.06, toe[0] + 0.07
            g.append(f'<geom name="{b}" type="box" pos="{fmt([(heel + tip) / 2, toe[1] / 2, -0.045])}" size="{fmt([(tip - heel) / 2, 0.045, 0.03])}"/>')
        return "\n".join(g)

    def body(b: str, depth: int) -> str:
        pad = "  " * depth
        p = pos[b] - (pos[parent_of[b]] if parent_of[b] else 0)
        if parent_of[b] is None:
            p = np.array([0, 0, 1.0])
        lines = [f'{pad}<body name="{b}" pos="{fmt(p)}">']
        if b == "pelvis":
            lines.append(f'{pad}  <freejoint name="root"/>')
        for jb, jn, ax in jl:
            if jb == b:
                lo, hi = ranges[jn]
                lines.append(f'{pad}  <joint name="{jn}" axis="{fmt(ax)}" range="{lo:.3f} {hi:.3f}"/>')
        lines.append("\n".join(pad + "  " + s for s in geoms(b).split("\n")))
        for c in children[b]:
            lines.append(body(c, depth + 1))
        lines.append(f"{pad}</body>")
        return "\n".join(lines)

    acts = []
    for jb, jn, _ax in jl:
        kp, f = GAINS[group(jb)]
        lo, hi = ranges[jn]
        acts.append(f'<position name="{jn}" joint="{jn}" kp="{kp}" kv="{kp / 10:.1f}" ctrlrange="{lo:.3f} {hi:.3f}" forcerange="{-f} {f}"/>')
    return f"""<mujoco model="mimic humanoid">
  <!-- Generated by training/mimic/humanoid.py from the CMU subject 16 skeleton. -->
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.002" integrator="implicitfast"/>
  <default>
    <joint damping="1" armature="0.02" limited="true"/>
    <geom density="1000" friction="1 0.02 0.01" condim="3" contype="1" conaffinity="2" rgba="0.82 0.84 0.88 1"/>
  </default>
  <worldbody>
    <geom name="floor" type="plane" size="0 0 0.05" contype="2" conaffinity="1" rgba="0.2 0.22 0.26 1"/>
{body("pelvis", 2)}
  </worldbody>
  <actuator>
    {chr(10).join("    " + a for a in acts).strip()}
  </actuator>
</mujoco>
"""


def find_cycle(q: np.ndarray, lo: int, hi: int) -> tuple[int, int]:
    """Frames (i, j) whose poses and velocities match best, j − i in [lo, hi): a seamless loop."""
    joints = q[:, 7:]
    vel = np.gradient(joints, axis=0)
    zvel = np.gradient(q[:, 2])
    best, bi, bj = np.inf, 0, 0
    for i in range(0, len(q) - lo):
        for j in range(i + lo, min(len(q), i + hi)):
            c = np.sum((joints[i] - joints[j]) ** 2) + 4 * np.sum((vel[i] - vel[j]) ** 2) + 20 * (q[i, 2] - q[j, 2]) ** 2 + 20 * (zvel[i] - zvel[j]) ** 2
            if c < best:
                best, bi, bj = c, i, j
    return bi, bj


def yaw_of(wxyz: np.ndarray) -> float:
    w, x, y, z = wxyz
    return float(np.arctan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)))


def main() -> None:
    data, idx, rest, takes = load()
    # Hinge axes from all takes together.
    allQ = np.concatenate([Q for _, Q in takes.values()])
    loc = local_rotations(idx, allQ)
    axes = {b: fit_hinge_axis([loc[b]]) for b, *_r, (kind, _o) in BODIES if kind == "hinge"}
    qs = {k: retarget(idx, P, Q, axes) for k, (P, Q) in takes.items()}
    jl = joint_list(axes)
    allq = np.concatenate(list(qs.values()))
    ranges = {}
    for c, (_b, jn, _ax) in enumerate(jl):
        v = allq[:, 7 + c]
        ranges[jn] = (max(-np.pi, v.min() - 0.6), min(np.pi, v.max() + 0.6))
    xml = build_xml(rest, idx, axes, ranges)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "humanoid.xml").write_text(xml)
    model = mujoco.MjModel.from_xml_string(xml)
    d = mujoco.MjData(model)
    print(f"humanoid: {model.nq} qpos, {model.nu} actuators, mass {model.body_subtreemass[1]:.1f} kg")
    foot_geoms = [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, n) for n in ("l_foot", "r_foot")]

    clips = {}
    windows = {"walk": (55, 90), "run": (34, 52)}
    for name, q in qs.items():
        i, j = find_cycle(q, *windows[name])
        clip = q[i : j + 1].copy()
        # Start at the origin heading +x.
        yaw0 = yaw_of(clip[0, 3:7])
        heading = np.arctan2(*(clip[-1, 0:2] - clip[0, 0:2])[::-1])
        rot = R.from_euler("z", -heading)
        clip[:, 0:3] = rot.apply(clip[:, 0:3] - clip[0, 0:3] * [1, 1, 0])
        root_rot = rot * R.from_quat(clip[:, [4, 5, 6, 3]])
        xyzw = root_rot.as_quat()
        clip[:, 3:7] = np.concatenate([xyzw[:, 3:4], xyzw[:, 0:3]], axis=1)
        # Feet on the floor: the lowest foot-box corner over the clip's 5th percentile of per-frame minima → 0.
        lows = []
        for f in range(len(clip)):
            d.qpos[:] = clip[f]
            mujoco.mj_kinematics(model, d)
            low = np.inf
            for g in foot_geoms:
                c, m, s = d.geom_xpos[g], d.geom_xmat[g].reshape(3, 3), model.geom_size[g]
                for sx in (-1, 1):
                    for sy in (-1, 1):
                        for sz in (-1, 1):
                            low = min(low, (c + m @ (s * [sx, sy, sz]))[2])
            lows.append(low)
        clip[:, 2] -= np.percentile(lows, 5)
        last = clip[-1]
        cycle = {
            "dx": float(last[0] - clip[0, 0]),
            "dy": float(last[1] - clip[0, 1]),
            "dyaw": yaw_of(last[3:7]) - yaw_of(clip[0, 3:7]),
        }
        frames = clip[:-1]  # the last frame is the first of the next cycle
        clips[name] = {"take": data["takes"][name]["id"], "from": int(i), "frames": len(frames), "cycle": cycle, "qpos": np.round(frames, 5).tolist()}
        speed = np.hypot(cycle["dx"], cycle["dy"]) / (len(frames) / data["fps"])
        print(f"{name}: take {data['takes'][name]['id']} frames {i}-{j} ({len(frames)} = {len(frames) / data['fps']:.2f} s), {speed:.2f} m/s, yaw drift {np.degrees(cycle['dyaw']):.1f}°, start yaw {np.degrees(yaw0):.0f}°")
    (OUT / "clips.json").write_text(
        json.dumps(
            {
                "fps": data["fps"],
                "source": data["source"],
                "attribution": data["attribution"],
                "joints": [jn for _b, jn, _a in jl],
                "endEffectors": END_EFFECTORS,
                "clips": clips,
            }
        )
    )
    print(f"wrote {OUT / 'humanoid.xml'} and {OUT / 'clips.json'}")


if __name__ == "__main__":
    main()
