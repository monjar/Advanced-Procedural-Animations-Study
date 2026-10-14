import * as THREE from 'three';

export interface TreeNodeSpec {
  /** Index of the parent node, -1 for the root (node 0). Parents must precede children. */
  parent: number;
  /** Rest position (world); bone lengths are taken from it. */
  position: THREE.Vector3;
}

/**
 * Multi-end-effector FABRIK on a tree (positions only). In the backward pass every node whose subtree
 * contains a target becomes a sub-base positioned at the centroid of its children's proposals; the
 * forward pass then re-extends every branch from the root.
 */
export class FabrikTree {
  readonly positions: THREE.Vector3[];
  readonly parent: number[];
  readonly length: number[];
  private readonly next: THREE.Vector3[];
  private readonly children: number[][];
  private readonly active: boolean[];

  constructor(nodes: TreeNodeSpec[]) {
    this.positions = nodes.map((n) => n.position.clone());
    this.parent = nodes.map((n) => n.parent);
    this.length = nodes.map((n) => (n.parent < 0 ? 0 : n.position.distanceTo(nodes[n.parent].position)));
    this.next = nodes.map(() => new THREE.Vector3());
    this.children = nodes.map(() => []);
    this.active = nodes.map(() => false);
    nodes.forEach((n, i) => {
      if (n.parent >= 0) {
        if (n.parent >= i) throw new Error('FabrikTree: parents must precede children');
        this.children[n.parent].push(i);
      }
    });
  }

  /** Solve for `targets` (node index → world position) with the root pinned at `root`. Returns max effector error. */
  solve(targets: Map<number, THREE.Vector3>, root: THREE.Vector3, iterations: number, tolerance: number, errors?: number[]) {
    const n = this.positions.length;
    // Which nodes have a target somewhere in their subtree.
    for (let i = n - 1; i >= 0; i--) {
      this.active[i] = targets.has(i) || this.children[i].some((c) => this.active[c]);
    }
    let error = this.maxError(targets);
    let it = 0;
    const dir = new THREE.Vector3();
    for (; it < iterations && error > tolerance; it++) {
      // Backward (children before parents).
      for (let i = n - 1; i >= 0; i--) {
        const t = targets.get(i);
        if (t) {
          this.next[i].copy(t);
          continue;
        }
        let count = 0;
        this.next[i].set(0, 0, 0);
        for (const c of this.children[i]) {
          if (!this.active[c]) continue;
          dir.subVectors(this.positions[i], this.next[c]);
          if (dir.lengthSq() < 1e-14) dir.subVectors(this.positions[i], this.positions[c]);
          this.next[i].add(dir.normalize().multiplyScalar(this.length[c]).add(this.next[c]));
          count++;
        }
        if (count > 0) this.next[i].divideScalar(count);
        else this.next[i].copy(this.positions[i]);
      }
      // Forward (parents before children).
      this.positions[0].copy(root);
      for (let i = 1; i < n; i++) {
        const p = this.positions[this.parent[i]];
        dir.subVectors(this.next[i], p);
        if (dir.lengthSq() < 1e-14) dir.subVectors(this.positions[i], p);
        this.positions[i].copy(p).addScaledVector(dir.normalize(), this.length[i]);
      }
      error = this.maxError(targets);
      errors?.push(error);
    }
    return { iterations: it, error };
  }

  private maxError(targets: Map<number, THREE.Vector3>): number {
    let e = 0;
    for (const [i, t] of targets) e = Math.max(e, this.positions[i].distanceTo(t));
    return e;
  }
}
