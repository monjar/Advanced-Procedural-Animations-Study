import * as THREE from 'three';
import type { MjData, MjModel } from '@mujoco/mujoco';

/**
 * Three.js meshes for a MuJoCo model's geoms (boxes, spheres, capsules, cylinders; planes are left to the
 * scene's own ground), placed from `data.geom_xpos / geom_xmat` and interpolated between two snapshots so a
 * simulation stepped at its own rate renders smoothly at any display rate. MuJoCo is z-up; the meshes live in
 * a group rotated so z becomes three's y.
 */
export class MujocoView {
  readonly group = new THREE.Group();
  readonly meshes: { geom: number; mesh: THREE.Mesh }[] = [];
  private readonly prevPos: Float64Array;
  private readonly prevMat: Float64Array;
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();
  private readonly pa = new THREE.Vector3();
  private readonly pb = new THREE.Vector3();
  private readonly m4 = new THREE.Matrix4();

  constructor(
    readonly model: MjModel,
    readonly data: MjData,
    material: (geom: number, type: number) => THREE.Material,
  ) {
    this.group.rotation.x = -Math.PI / 2;
    const types = model.geom_type as Int32Array;
    const sizes = model.geom_size as Float64Array;
    for (let g = 0; g < model.ngeom; g++) {
      const t = types[g];
      const [s0, s1, s2] = [sizes[g * 3], sizes[g * 3 + 1], sizes[g * 3 + 2]];
      let geo: THREE.BufferGeometry | null = null;
      if (t === 6) geo = new THREE.BoxGeometry(2 * s0, 2 * s1, 2 * s2);
      else if (t === 2) geo = new THREE.SphereGeometry(s0, 20, 14);
      else if (t === 3) geo = new THREE.CapsuleGeometry(s0, 2 * s1, 6, 14).rotateX(Math.PI / 2);
      else if (t === 5) geo = new THREE.CylinderGeometry(s0, s0, 2 * s1, 20).rotateX(Math.PI / 2);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, material(g, t));
      mesh.castShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.meshes.push({ geom: g, mesh });
    }
    this.prevPos = new Float64Array(model.ngeom * 3);
    this.prevMat = new Float64Array(model.ngeom * 9);
    this.snapshot();
  }

  /** Remember the current state as the start of the next interpolation interval. */
  snapshot(): void {
    this.prevPos.set(this.data.geom_xpos as Float64Array);
    this.prevMat.set(this.data.geom_xmat as Float64Array);
  }

  private quat(m: ArrayLike<number>, o: number, q: THREE.Quaternion): THREE.Quaternion {
    return q.setFromRotationMatrix(this.m4.set(m[o], m[o + 1], m[o + 2], 0, m[o + 3], m[o + 4], m[o + 5], 0, m[o + 6], m[o + 7], m[o + 8], 0, 0, 0, 0, 1));
  }

  /** Place the meshes `alpha` of the way from the snapshot to the current state. */
  update(alpha = 1): void {
    const pos = this.data.geom_xpos as Float64Array;
    const mat = this.data.geom_xmat as Float64Array;
    for (const { geom: g, mesh } of this.meshes) {
      this.pa.set(this.prevPos[g * 3], this.prevPos[g * 3 + 1], this.prevPos[g * 3 + 2]);
      this.pb.set(pos[g * 3], pos[g * 3 + 1], pos[g * 3 + 2]);
      this.quat(this.prevMat, g * 9, this.qa);
      this.quat(mat, g * 9, this.qb);
      mesh.matrix.compose(this.pa.lerp(this.pb, alpha), this.qa.slerp(this.qb, alpha), mesh.scale);
    }
  }
}

/** MuJoCo world point (z-up) → three.js (y-up). */
export function mjToThree(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y);
}
