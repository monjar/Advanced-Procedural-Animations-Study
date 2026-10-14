import * as THREE from 'three';
import { hills, terrainMesh, type HeightFn } from '../../src/world/terrain';
import { StaticRaycaster } from '../../src/world/raycast';

export type WorldKind = 'playground' | 'flat' | 'wall';

/** Static level geometry plus a raycaster over it. */
export class World {
  readonly group = new THREE.Group();
  readonly rays = new StaticRaycaster();
  readonly height: HeightFn;

  constructor(kind: WorldKind = 'playground') {
    this.height = kind === 'playground' ? hills({ seed: 5, amplitude: 0.7, scale: 7, flatRadius: 3 }) : () => 0;
    const ground = terrainMesh(
      this.height,
      kind === 'playground' ? 44 : 30,
      kind === 'playground' ? 176 : 8,
      new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.95 }),
    );
    this.addMesh(ground);

    const crate = new THREE.MeshStandardMaterial({ color: 0x4a505c, roughness: 0.8 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x3d4f66, roughness: 0.7 });
    if (kind === 'wall') {
      this.box(0, 0, -3, 6, 3, 0.6, crate);
    } else if (kind === 'playground') {
      this.box(3.5, 0, -2.5, 1.6, 1.0, 1.6, crate);
      this.box(-4.5, 0, 2.5, 2.2, 1.4, 2.2, crate);
      this.box(5.5, 0, 4.5, 1.2, 0.7, 1.2, crate);
      this.box(-1, 0, -7, 7, 2.6, 0.8, accent); // climbing wall
      // Ramp up to a platform.
      this.box(-7, 0, -3, 2.4, 1.2, 2.4, crate);
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.2, 3.2), crate);
      const base = this.height(-7, -0.5);
      ramp.position.set(-7, base + 0.55, -0.4);
      ramp.rotation.x = Math.atan2(1.2, 3.0); // high end toward the platform (−z)
      this.addMesh(ramp);
    }
  }

  private box(x: number, _y: number, z: number, w: number, h: number, d: number, m: THREE.Material): void {
    const base = Math.min(
      this.height(x - w / 2, z - d / 2),
      this.height(x + w / 2, z - d / 2),
      this.height(x - w / 2, z + d / 2),
      this.height(x + w / 2, z + d / 2),
    );
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h + 0.4, d), m);
    mesh.position.set(x, base - 0.4 + (h + 0.4) / 2, z);
    this.addMesh(mesh);
  }

  private addMesh(mesh: THREE.Mesh): void {
    mesh.castShadow = mesh.name !== 'terrain';
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.rays.add(mesh);
  }
}
