import * as THREE from 'three';
import type { ParticleSystem } from '../../src/physics/xpbd';

export interface ClothGrid {
  width: number;
  height: number;
  /** Particle index of grid cell (i, j). */
  index: (i: number, j: number) => number;
  stretch: number[];
  shear: number[];
  bend: number[];
}

/**
 * Build a cloth patch in `ps`: particles at `position(i, j)`, structural, shear and bending
 * (skip-one) distance constraints, grouped so their compliance can be changed independently.
 */
export function buildCloth(
  ps: ParticleSystem,
  width: number,
  height: number,
  position: (i: number, j: number) => THREE.Vector3,
  particleMass: number,
): ClothGrid {
  const base = ps.count;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) ps.addParticle(position(i, j), particleMass);
  const index = (i: number, j: number) => base + j * width + i;
  const stretch: number[] = [];
  const shear: number[] = [];
  const bend: number[] = [];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (i + 1 < width) stretch.push(ps.addDistance(index(i, j), index(i + 1, j), 0));
      if (j + 1 < height) stretch.push(ps.addDistance(index(i, j), index(i, j + 1), 0));
      if (i + 1 < width && j + 1 < height) {
        shear.push(ps.addDistance(index(i, j), index(i + 1, j + 1), 0));
        shear.push(ps.addDistance(index(i + 1, j), index(i, j + 1), 0));
      }
      if (i + 2 < width) bend.push(ps.addDistance(index(i, j), index(i + 2, j), 0));
      if (j + 2 < height) bend.push(ps.addDistance(index(i, j), index(i, j + 2), 0));
    }
  }
  return { width, height, index, stretch, shear, bend };
}

/** Indexed triangle mesh mirroring a cloth grid; call `sync` every frame. */
export class ClothMesh extends THREE.Mesh {
  private readonly positions: Float32Array;

  constructor(
    private readonly grid: ClothGrid,
    material: THREE.Material,
  ) {
    const geo = new THREE.BufferGeometry();
    const n = grid.width * grid.height;
    const positions = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    const indices: number[] = [];
    for (let j = 0; j < grid.height; j++) {
      for (let i = 0; i < grid.width; i++) {
        const k = j * grid.width + i;
        uvs[2 * k] = i / (grid.width - 1);
        uvs[2 * k + 1] = 1 - j / (grid.height - 1);
        if (i + 1 < grid.width && j + 1 < grid.height) {
          const a = k;
          const b = k + 1;
          const c = k + grid.width;
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    super(geo, material);
    this.positions = positions;
    this.castShadow = true;
    this.receiveShadow = true;
    this.frustumCulled = false;
  }

  sync(ps: ParticleSystem): void {
    const { width, height, index } = this.grid;
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const p = index(i, j);
        const k = 3 * (j * width + i);
        this.positions[k] = ps.x[3 * p];
        this.positions[k + 1] = ps.x[3 * p + 1];
        this.positions[k + 2] = ps.x[3 * p + 2];
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();

/**
 * Pressure drag per triangle: the normal component of the relative wind pushes the triangle along its
 * normal, F = ½ρC_d · v_n|v_n| · A (`coefficient` = ½ρC_d ≈ 0.7 for air). Writes per-particle
 * accelerations into `ps.acc`.
 */
export function applyAerodynamics(ps: ParticleSystem, grid: ClothGrid, wind: THREE.Vector3, coefficient: number): void {
  const { width, height, index } = grid;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const p = 3 * index(i, j);
    ps.acc[p] = ps.acc[p + 1] = ps.acc[p + 2] = 0;
  }
  if (coefficient === 0) return;
  const tri = (ia: number, ib: number, ic: number) => {
    ps.get(ia, _a);
    ps.get(ib, _b);
    ps.get(ic, _c);
    _n.subVectors(_b, _a).cross(_c.sub(_a)); // |n| = 2·area
    const area2 = _n.length();
    if (area2 < 1e-12) return;
    _n.divideScalar(area2);
    // Mean particle velocity of the triangle.
    _v.set(
      (ps.v[3 * ia] + ps.v[3 * ib] + ps.v[3 * ic]) / 3,
      (ps.v[3 * ia + 1] + ps.v[3 * ib + 1] + ps.v[3 * ic + 1]) / 3,
      (ps.v[3 * ia + 2] + ps.v[3 * ib + 2] + ps.v[3 * ic + 2]) / 3,
    );
    _v.subVectors(wind, _v);
    const vn = _v.dot(_n);
    const f = coefficient * vn * Math.abs(vn) * area2 * 0.5;
    for (const k of [ia, ib, ic]) {
      const w = ps.w[k];
      ps.acc[3 * k] += (f * _n.x * w) / 3;
      ps.acc[3 * k + 1] += (f * _n.y * w) / 3;
      ps.acc[3 * k + 2] += (f * _n.z * w) / 3;
    }
  };
  for (let j = 0; j + 1 < height; j++) {
    for (let i = 0; i + 1 < width; i++) {
      tri(index(i, j), index(i, j + 1), index(i + 1, j));
      tri(index(i + 1, j), index(i, j + 1), index(i + 1, j + 1));
    }
  }
}
