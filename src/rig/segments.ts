import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Instanced capsule-ish segments (cylinder + joint spheres) for drawing many chains in two draw calls.
 * Call `segment`/`joint` each frame, then `commit`.
 */
export class SegmentBatch extends THREE.Group {
  private readonly cylinders: THREE.InstancedMesh;
  private readonly spheres: THREE.InstancedMesh;
  private nSeg = 0;
  private nJoint = 0;
  // Capacities: `count` is set to what was drawn on commit, so it cannot be the limit (an empty frame would
  // otherwise disable drawing for good).
  private readonly maxSeg: number;
  private readonly maxJoint: number;

  constructor(capacity: number, material: THREE.Material, jointMaterial: THREE.Material = material) {
    super();
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 14, 1).translate(0, 0.5, 0);
    this.cylinders = new THREE.InstancedMesh(cyl, material, capacity);
    this.spheres = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), jointMaterial, capacity + 8);
    this.maxSeg = capacity;
    this.maxJoint = capacity + 8;
    for (const m of [this.cylinders, this.spheres]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.add(m);
    }
  }

  begin(): void {
    this.nSeg = 0;
    this.nJoint = 0;
  }

  segment(a: THREE.Vector3, b: THREE.Vector3, radius: number, color?: THREE.ColorRepresentation): void {
    if (this.nSeg >= this.maxSeg) return;
    _d.subVectors(b, a);
    const len = _d.length();
    _q.setFromUnitVectors(UP, len > 1e-9 ? _d.divideScalar(len) : UP);
    _s.set(radius, len, radius);
    _m.compose(a, _q, _s);
    this.cylinders.setMatrixAt(this.nSeg, _m);
    if (color !== undefined) this.cylinders.setColorAt(this.nSeg, _c.set(color));
    this.nSeg++;
  }

  joint(p: THREE.Vector3, radius: number, color?: THREE.ColorRepresentation): void {
    if (this.nJoint >= this.maxJoint) return;
    _m.compose(p, _q.identity(), _s.setScalar(radius));
    this.spheres.setMatrixAt(this.nJoint, _m);
    if (color !== undefined) this.spheres.setColorAt(this.nJoint, _c.set(color));
    this.nJoint++;
  }

  /** Segments along a polyline with joints at every vertex. Radii taper linearly from r0 to r1. */
  chain(points: readonly THREE.Vector3[], r0: number, r1 = r0, color?: THREE.ColorRepresentation): void {
    const n = points.length - 1;
    for (let i = 0; i < n; i++) {
      const r = THREE.MathUtils.lerp(r0, r1, n > 1 ? i / (n - 1) : 0);
      this.segment(points[i], points[i + 1], r, color);
      this.joint(points[i], r * 1.25, color);
    }
    if (n >= 0) this.joint(points[n], r1 * 1.1, color);
  }

  commit(): void {
    this.cylinders.count = this.nSeg;
    this.spheres.count = this.nJoint;
    this.cylinders.instanceMatrix.needsUpdate = true;
    this.spheres.instanceMatrix.needsUpdate = true;
    if (this.cylinders.instanceColor) this.cylinders.instanceColor.needsUpdate = true;
    if (this.spheres.instanceColor) this.spheres.instanceColor.needsUpdate = true;
  }
}
