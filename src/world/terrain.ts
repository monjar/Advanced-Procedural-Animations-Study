import * as THREE from 'three';
import { createNoise2D } from '../math/noise';

export type HeightFn = (x: number, z: number) => number;

export interface HillsOptions {
  seed?: number;
  amplitude?: number;
  /** Feature size in metres. */
  scale?: number;
  /** Radius around the origin kept flatter (0 disables). */
  flatRadius?: number;
}

/** Smooth fractal hills. */
export function hills({ seed = 3, amplitude = 0.6, scale = 9, flatRadius = 0 }: HillsOptions = {}): HeightFn {
  const { fbm } = createNoise2D(seed);
  return (x, z) => {
    let h = fbm(x / scale, z / scale, 4) * amplitude;
    if (flatRadius > 0) {
      const r = Math.hypot(x, z) / flatRadius;
      h *= THREE.MathUtils.smoothstep(r, 0.3, 1);
    }
    return h;
  };
}

/** Surface normal of a height field by central differences. */
export function heightNormal(h: HeightFn, x: number, z: number, out = new THREE.Vector3(), eps = 0.05): THREE.Vector3 {
  const dx = h(x + eps, z) - h(x - eps, z);
  const dz = h(x, z + eps) - h(x, z - eps);
  return out.set(-dx, 2 * eps, -dz).normalize();
}

/** Square height-field mesh centred on the origin. */
export function terrainMesh(
  h: HeightFn,
  size: number,
  segments: number,
  material: THREE.Material = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.95, flatShading: false }),
): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/** Grid lines draped over a height field (cheap visual scale reference). */
export function terrainGrid(h: HeightFn, size: number, step: number, color = 0x353b46): THREE.LineSegments {
  const pts: number[] = [];
  const half = size / 2;
  const res = step / 4;
  for (let a = -half; a <= half + 1e-6; a += step) {
    for (let b = -half; b < half - 1e-6; b += res) {
      pts.push(a, h(a, b) + 0.01, b, a, h(a, b + res) + 0.01, b + res);
      pts.push(b, h(b, a) + 0.01, a, b + res, h(b + res, a) + 0.01, a);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }));
}
