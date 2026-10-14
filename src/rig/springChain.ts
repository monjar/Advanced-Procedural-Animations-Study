import * as THREE from 'three';
import { SecondOrderVec3, type SecondOrderParams } from '../math/secondOrder';

const _desired = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Secondary-motion chain (study 01): every joint chases its rest position, expressed in a moving
 * frame, through its own second-order system, then is projected back to a fixed segment length.
 */
export class SpringChain {
  readonly points: THREE.Vector3[] = [];
  private readonly joints: SecondOrderVec3[] = [];

  constructor(
    private readonly restDirs: THREE.Vector3[],
    private readonly length: number,
    anchor: THREE.Vector3,
    frame: THREE.Quaternion,
    params: SecondOrderParams,
  ) {
    this.points.push(anchor.clone());
    for (let i = 0; i < restDirs.length; i++) {
      const p = this.points[i].clone().addScaledVector(_dir.copy(restDirs[i]).applyQuaternion(frame), length);
      this.points.push(p);
      this.joints.push(new SecondOrderVec3(params, p));
    }
  }

  setParams(p: SecondOrderParams): void {
    for (const j of this.joints) j.core.setParams(p);
  }

  update(dt: number, anchor: THREE.Vector3, frame: THREE.Quaternion, sag = 0): void {
    this.points[0].copy(anchor);
    for (let i = 0; i < this.joints.length; i++) {
      const parent = this.points[i];
      _desired.copy(this.restDirs[i]).applyQuaternion(frame).multiplyScalar(this.length).add(parent);
      _desired.y -= sag * this.length * (i + 1);
      const y = this.joints[i].update(dt, _desired);
      _dir.subVectors(y, parent);
      const len = _dir.length();
      if (!Number.isFinite(len) || len < 1e-6) _dir.subVectors(_desired, parent).normalize();
      else _dir.divideScalar(len);
      this.points[i + 1].copy(parent).addScaledVector(_dir, this.length);
      this.joints[i].setOutput(this.points[i + 1]);
    }
  }
}
