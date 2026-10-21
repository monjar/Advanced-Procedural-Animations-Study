import * as THREE from 'three';

/**
 * A right hand: palm, four fingers (abduction + three flexion joints each) and an opposable thumb (opposition,
 * abduction, flexion at the base, then MCP and IP flexion) — 21 joints, adult proportions.
 *
 * Hand frame: +y along the fingers, +z out of the palm (toward what is grasped), +x toward the thumb. A finger's
 * flexion rotates it about +x, curling its tip toward +z. The same layout and joint order are written out as MJCF
 * by `handMjcf`, so the grasp search and the physics check move identical bodies.
 */

export interface FingerDef {
  name: string;
  /** MCP joint position in the hand frame. */
  base: [number, number, number];
  lengths: [number, number, number];
  radius: [number, number, number];
}

export const PALM = { halfWidth: 0.042, length: 0.09, halfThickness: 0.013 };

export const FINGERS: FingerDef[] = [
  { name: 'index', base: [0.027, 0.09, 0], lengths: [0.044, 0.025, 0.02], radius: [0.0095, 0.0088, 0.008] },
  { name: 'middle', base: [0.008, 0.093, 0], lengths: [0.049, 0.03, 0.022], radius: [0.0098, 0.009, 0.008] },
  { name: 'ring', base: [-0.011, 0.09, 0], lengths: [0.046, 0.028, 0.02], radius: [0.0092, 0.0085, 0.0078] },
  { name: 'little', base: [-0.029, 0.083, 0], lengths: [0.036, 0.021, 0.018], radius: [0.0082, 0.0076, 0.007] },
];
export const THUMB = { base: [0.024, 0.016, 0.006] as [number, number, number], lengths: [0.045, 0.033, 0.028] as [number, number, number], radius: [0.013, 0.0105, 0.0092] as [number, number, number], rest: -Math.PI / 4 };

/** Joint order: per finger [abd, mcp, pip, dip] ×4, then thumb [opp, abd, flex, mcp, ip]. */
export const JOINTS = 21;
export const thumbJoint = (k: number) => 16 + k;
export const fingerJoint = (f: number, k: number) => f * 4 + k;

export const LIMITS: [number, number][] = [
  ...FINGERS.flatMap((): [number, number][] => [
    [-0.35, 0.35],
    [-0.2, 1.6],
    [0, 1.9],
    [0, 1.4],
  ]),
  [0, 1.6], // opposition
  [-0.6, 0.6], // thumb abduction
  [-0.3, 1.0], // thumb base flexion
  [-0.2, 1.1], // thumb MCP
  [-0.3, 1.3], // thumb IP
];

export interface Link {
  /** Finger index 0–3, or 4 for the thumb. */
  digit: number;
  /** 0 proximal … 2 distal. */
  segment: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Finger and thumb link capsules for a pose, in the frame given by `wrist` (hand frame → world). */
export function handLinks(pose: ArrayLike<number>, wrist: THREE.Matrix4, out: Link[] = []): Link[] {
  out.length = 0;
  const toWorld = (p: THREE.Vector3) => p.applyMatrix4(wrist);
  FINGERS.forEach((f, i) => {
    const p = new THREE.Vector3(...f.base);
    _q.setFromAxisAngle(Z, pose[fingerJoint(i, 0)]).multiply(_r.setFromAxisAngle(X, pose[fingerJoint(i, 1)]));
    for (let s = 0; s < 3; s++) {
      if (s > 0) _q.multiply(_r.setFromAxisAngle(X, pose[fingerJoint(i, s + 1)]));
      const a = p.clone();
      p.add(_v.copy(Y).multiplyScalar(f.lengths[s]).applyQuaternion(_q));
      out.push({ digit: i, segment: s, a: toWorld(a), b: toWorld(p.clone()), radius: f.radius[s] });
    }
  });
  // Thumb: opposition about −y, then its rest angle and abduction about z, then flexions about x.
  const p = new THREE.Vector3(...THUMB.base);
  _q.setFromAxisAngle(Y, -pose[thumbJoint(0)])
    .multiply(_r.setFromAxisAngle(Z, THUMB.rest))
    .multiply(_r.setFromAxisAngle(Z, pose[thumbJoint(1)]))
    .multiply(_r.setFromAxisAngle(X, pose[thumbJoint(2)]));
  for (let s = 0; s < 3; s++) {
    if (s > 0) _q.multiply(_r.setFromAxisAngle(X, pose[thumbJoint(s + 2)]));
    const a = p.clone();
    p.add(_v.copy(Y).multiplyScalar(THUMB.lengths[s]).applyQuaternion(_q));
    out.push({ digit: 4, segment: s, a: toWorld(a), b: toWorld(p.clone()), radius: THUMB.radius[s] });
  }
  return out;
}

/**
 * Points covering the palm box's front face to its edges (hand frame), for palm contact and penetration. Sampling
 * only the middle let the box's edges sink into objects in the physics check.
 */
export const PALM_POINTS: THREE.Vector3[] = [];
for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) PALM_POINTS.push(new THREE.Vector3(-PALM.halfWidth + (2 * PALM.halfWidth * i) / 4, (PALM.length * j) / 4, PALM.halfThickness));

/** The open, relaxed pose: fingers slightly curled, thumb out to the side. */
export function openPose(): Float64Array {
  const p = new Float64Array(JOINTS);
  for (let i = 0; i < 4; i++) {
    p[fingerJoint(i, 0)] = [0.08, 0.02, -0.04, -0.1][i];
    p[fingerJoint(i, 1)] = 0.1;
    p[fingerJoint(i, 2)] = 0.15;
    p[fingerJoint(i, 3)] = 0.1;
  }
  p[thumbJoint(0)] = 0.5;
  p[thumbJoint(1)] = 0.2;
  p[thumbJoint(2)] = 0;
  p[thumbJoint(3)] = 0.1;
  p[thumbJoint(4)] = 0.1;
  return p;
}

const f = (n: number) => n.toFixed(5);
const fv = (v: ArrayLike<number>) => Array.from(v, (x) => f(x)).join(' ');

/**
 * MJCF for the hand: a free body welded to a mocap target (posed through data.mocap_pos / mocap_quat), with
 * position-servo fingers — the bodies for the worldbody, the weld and the `<position>` actuators. Joint names
 * are j0…j20 in the order above.
 *
 * Why a weld and not a mocap hand: a mocap body is teleported each step and has no velocity, so contacts on it
 * produce no friction drag. With the hand parented to the mocap, even a two-jaw gripper squeezing a can slid
 * off it when lifted; welded, it lifted the can 19.7 of 20 cm.
 */
export function handMjcf(kp = 6): { body: string; equality: string; actuators: string } {
  const fingers = FINGERS.map((fd, i) => {
    let xml = `<body name="${fd.name}0" pos="${fv(fd.base)}">
      <joint name="j${fingerJoint(i, 0)}" axis="0 0 1" range="${LIMITS[fingerJoint(i, 0)].join(' ')}"/>
      <joint name="j${fingerJoint(i, 1)}" axis="1 0 0" range="${LIMITS[fingerJoint(i, 1)].join(' ')}"/>
      <geom contype="2" conaffinity="1" type="capsule" fromto="0 0 0 0 ${f(fd.lengths[0])} 0" size="${f(fd.radius[0])}"/>
      <body name="${fd.name}1" pos="0 ${f(fd.lengths[0])} 0">
        <joint name="j${fingerJoint(i, 2)}" axis="1 0 0" range="${LIMITS[fingerJoint(i, 2)].join(' ')}"/>
        <geom contype="2" conaffinity="1" type="capsule" fromto="0 0 0 0 ${f(fd.lengths[1])} 0" size="${f(fd.radius[1])}"/>
        <body name="${fd.name}2" pos="0 ${f(fd.lengths[1])} 0">
          <joint name="j${fingerJoint(i, 3)}" axis="1 0 0" range="${LIMITS[fingerJoint(i, 3)].join(' ')}"/>
          <geom contype="2" conaffinity="1" type="capsule" fromto="0 0 0 0 ${f(fd.lengths[2])} 0" size="${f(fd.radius[2])}"/>
        </body>
      </body>
    </body>`;
    return xml;
  }).join('\n');
  const rz = THUMB.rest / 2;
  const thumb = `<body name="thumb_base" pos="${fv(THUMB.base)}">
      <joint name="j${thumbJoint(0)}" axis="0 -1 0" range="${LIMITS[thumbJoint(0)].join(' ')}"/>
      <inertial pos="0 0 0" mass="0.01" diaginertia="1e-6 1e-6 1e-6"/>
      <body name="thumb0" quat="${f(Math.cos(rz))} 0 0 ${f(Math.sin(rz))}">
        <joint name="j${thumbJoint(1)}" axis="0 0 1" range="${LIMITS[thumbJoint(1)].join(' ')}"/>
        <joint name="j${thumbJoint(2)}" axis="1 0 0" range="${LIMITS[thumbJoint(2)].join(' ')}"/>
        <geom contype="2" conaffinity="1" type="capsule" fromto="0 0 0 0 ${f(THUMB.lengths[0])} 0" size="${f(THUMB.radius[0])}"/>
        <body name="thumb1" pos="0 ${f(THUMB.lengths[0])} 0">
          <joint name="j${thumbJoint(3)}" axis="1 0 0" range="${LIMITS[thumbJoint(3)].join(' ')}"/>
          <geom contype="2" conaffinity="1" type="capsule" fromto="0 0 0 0 ${f(THUMB.lengths[1])} 0" size="${f(THUMB.radius[1])}"/>
          <body name="thumb2" pos="0 ${f(THUMB.lengths[1])} 0">
            <joint name="j${thumbJoint(4)}" axis="1 0 0" range="${LIMITS[thumbJoint(4)].join(' ')}"/>
            <geom contype="2" conaffinity="1" type="capsule" fromto="0 0 0 0 ${f(THUMB.lengths[2])} 0" size="${f(THUMB.radius[2])}"/>
          </body>
        </body>
      </body>
    </body>`;
  const actuators = Array.from({ length: JOINTS }, (_, j) => `<position joint="j${j}" kp="${kp}" kv="${(kp / 20).toFixed(3)}" ctrlrange="${LIMITS[j].join(' ')}" forcerange="-3 3"/>`).join('\n    ');
  return {
    equality: `<weld body1="target" body2="hand" solref="0.01 1"/>`,
    body: `<body name="target" mocap="true"/>
    <body name="hand">
      <freejoint name="hand"/>
      <inertial pos="0 0.045 0" mass="0.4" diaginertia="0.0005 0.0003 0.0006"/>
      <geom contype="2" conaffinity="1" name="palm" type="box" pos="0 ${f(PALM.length / 2)} 0" size="${f(PALM.halfWidth)} ${f(PALM.length / 2)} ${f(PALM.halfThickness)}"/>
      ${fingers}
      ${thumb}
    </body>`,
    actuators,
  };
}
