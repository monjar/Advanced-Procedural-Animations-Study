import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

// BVH-accelerated raycasting for any mesh whose geometry has a bounds tree.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface Hit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

/** Raycasts against a fixed set of static meshes (BVH-accelerated, first hit only). */
export class StaticRaycaster {
  readonly meshes: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  /** Number of rays cast since the last reset (for stats). */
  count = 0;

  constructor() {
    this.raycaster.firstHitOnly = true;
  }

  add(mesh: THREE.Mesh): void {
    mesh.updateMatrixWorld(true);
    mesh.geometry.computeBoundsTree();
    this.meshes.push(mesh);
  }

  cast(origin: THREE.Vector3, direction: THREE.Vector3, far: number, out?: Hit): Hit | null {
    this.count++;
    this.raycaster.set(origin, direction);
    this.raycaster.far = far;
    this.hits.length = 0;
    this.raycaster.intersectObjects(this.meshes, false, this.hits);
    const h = this.hits[0];
    if (!h || !h.face) return null;
    const hit = out ?? { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0 };
    hit.point.copy(h.point);
    hit.normal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    hit.distance = h.distance;
    return hit;
  }
}
