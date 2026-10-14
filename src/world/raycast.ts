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

const BOTH_SIDES = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

/** Raycasts against a fixed set of static meshes (BVH-accelerated, first hit only). */
export class StaticRaycaster {
  readonly meshes: THREE.Mesh[] = [];
  /** Double-sided proxies sharing the same geometry/BVH, for inside tests. */
  private readonly proxies: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly n = new THREE.Vector3();
  /** Number of rays cast since the last reset (for stats). */
  count = 0;

  constructor() {
    this.raycaster.firstHitOnly = true;
  }

  add(mesh: THREE.Mesh): void {
    mesh.updateMatrixWorld(true);
    mesh.geometry.computeBoundsTree();
    this.meshes.push(mesh);
    const proxy = new THREE.Mesh(mesh.geometry, BOTH_SIDES);
    proxy.matrixWorld.copy(mesh.matrixWorld);
    proxy.matrixAutoUpdate = false;
    this.proxies.push(proxy);
  }

  /**
   * True when a short ray from `p` along `dir` first meets the *back* of a face, i.e. `p` lies inside a
   * closed solid (or under the terrain). Used to reject footholds on faces buried inside other geometry.
   */
  insideAlong(p: THREE.Vector3, dir: THREE.Vector3, far: number): boolean {
    this.count++;
    this.raycaster.set(p, dir);
    this.raycaster.far = far;
    this.hits.length = 0;
    this.raycaster.intersectObjects(this.proxies, false, this.hits);
    const h = this.hits[0];
    if (!h || !h.face) return false;
    return this.n.copy(h.face.normal).transformDirection(h.object.matrixWorld).dot(dir) > 0;
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
