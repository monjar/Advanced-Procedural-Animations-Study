import * as THREE from 'three';

/**
 * Graspable objects as signed distance functions (negative inside), in metres. An SDF gives everything grasping
 * needs from geometry: whether a finger link penetrates, how far a link is from the surface, the closest
 * surface point and its normal (the gradient). Each shape also knows its MuJoCo stand-in for the physical lift test.
 */

export type ShapeKind = 'sphere' | 'box' | 'cylinder' | 'capsule' | 'mug' | 'torus';

export interface Shape {
  name: string;
  kind: ShapeKind;
  /** Half extents / radii (meaning per kind). */
  size: number[];
  /** Resting on a table: position of the shape's local origin above the table (z up in shape space is y here). */
  mass: number;
  /** Signed distance at a point in the shape's local frame (y up, resting with its bottom at y = 0). */
  sdf(p: THREE.Vector3): number;
  /** Height of the top above the table. */
  height: number;
  /** Characteristic length for torque scaling in grasp quality (≈ radius of gyration). */
  scale: number;
}

const _q = new THREE.Vector3();

function sdBox(p: THREE.Vector3, h: number[], r = 0): number {
  const qx = Math.abs(p.x) - h[0] + r;
  const qy = Math.abs(p.y) - h[1] + r;
  const qz = Math.abs(p.z) - h[2] + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** Upright cylinder centred at the origin: radius r, half height h. */
function sdCylinder(p: THREE.Vector3, r: number, h: number): number {
  const dx = Math.hypot(p.x, p.z) - r;
  const dy = Math.abs(p.y) - h;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

/** Torus in the x–y plane (a mug handle): major radius R, minor r. */
function sdTorusXY(p: THREE.Vector3, R: number, r: number): number {
  const q = Math.hypot(p.x, p.y) - R;
  return Math.hypot(q, p.z) - r;
}

export const SHAPES: Shape[] = [
  {
    name: 'ball (8 cm)',
    kind: 'sphere',
    size: [0.04],
    mass: 0.15,
    height: 0.08,
    scale: 0.04,
    sdf: (p) => _q.set(p.x, p.y - 0.04, p.z).length() - 0.04,
  },
  {
    name: 'apple (5 cm)',
    kind: 'sphere',
    size: [0.025],
    mass: 0.06,
    height: 0.05,
    scale: 0.025,
    sdf: (p) => _q.set(p.x, p.y - 0.025, p.z).length() - 0.025,
  },
  {
    name: 'block',
    kind: 'box',
    size: [0.03, 0.05, 0.03],
    mass: 0.25,
    height: 0.1,
    scale: 0.04,
    sdf: (p) => sdBox(_q.set(p.x, p.y - 0.05, p.z), [0.03, 0.05, 0.03], 0.004),
  },
  {
    name: 'can',
    kind: 'cylinder',
    size: [0.033, 0.06],
    mass: 0.35,
    height: 0.12,
    scale: 0.045,
    sdf: (p) => sdCylinder(_q.set(p.x, p.y - 0.06, p.z), 0.033, 0.06),
  },
  {
    name: 'marker (lying)',
    kind: 'capsule',
    size: [0.011, 0.06],
    mass: 0.03,
    height: 0.022,
    scale: 0.04,
    sdf: (p) => {
      // Capsule along x, resting on the table.
      const x = Math.max(-0.06, Math.min(0.06, p.x));
      return Math.hypot(p.x - x, p.y - 0.011, p.z) - 0.011;
    },
  },
  {
    name: 'mug',
    kind: 'mug',
    size: [0.04, 0.05],
    mass: 0.3,
    height: 0.1,
    scale: 0.05,
    sdf: (p) => {
      // Closed cylinder body (the inside is not reachable from outside anyway) + handle on +x.
      const body = sdCylinder(_q.set(p.x, p.y - 0.05, p.z), 0.04, 0.05);
      const handle = sdTorusXY(_q.set(p.x - 0.045, p.y - 0.05, p.z), 0.025, 0.007);
      return Math.min(body, handle);
    },
  },
];

/** SDF gradient (outward normal) by central differences. */
export function sdfNormal(shape: Shape, p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 1e-4;
  const a = new THREE.Vector3();
  const f = (x: number, y: number, z: number) => shape.sdf(a.set(x, y, z));
  return out
    .set(f(p.x + e, p.y, p.z) - f(p.x - e, p.y, p.z), f(p.x, p.y + e, p.z) - f(p.x, p.y - e, p.z), f(p.x, p.y, p.z + e) - f(p.x, p.y, p.z - e))
    .normalize();
}

/** Closest surface point to p (one Newton step along the gradient is exact for these SDFs up to curvature). */
export function closestPoint(shape: Shape, p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  out.copy(p);
  for (let i = 0; i < 3; i++) {
    const d = shape.sdf(out);
    const n = sdfNormal(shape, out);
    out.addScaledVector(n, -d);
  }
  return out;
}

/** A three.js mesh for a shape (same frame as its SDF). */
export function shapeMesh(shape: Shape, material: THREE.Material): THREE.Object3D {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, y: number, rot?: THREE.Euler, x = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, 0);
    if (rot) m.rotation.copy(rot);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  };
  const s = shape.size;
  if (shape.kind === 'sphere') add(new THREE.SphereGeometry(s[0], 32, 20), s[0]);
  else if (shape.kind === 'box') add(new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]), s[1]);
  else if (shape.kind === 'cylinder') add(new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 32), s[1]);
  else if (shape.kind === 'capsule') add(new THREE.CapsuleGeometry(s[0], 2 * s[1], 8, 16), s[0], new THREE.Euler(0, 0, Math.PI / 2));
  else if (shape.kind === 'mug') {
    add(new THREE.CylinderGeometry(0.04, 0.04, 0.1, 32), 0.05);
    add(new THREE.TorusGeometry(0.025, 0.007, 12, 32), 0.05, undefined, 0.045);
  }
  return g;
}
