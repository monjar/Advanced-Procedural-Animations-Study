import * as THREE from 'three';

const STEP_RISE = 0.15;
const STEP_RUN = 0.3;
const STEPS = 8;

/** Obstacle course along +z: flat, ramp, stairs up, stairs down, slope, bumps. Height depends on z only. */
export const COURSE_LENGTH = 25;

export function courseHeight(z: number): number {
  if (z < 4) return 0;
  if (z < 8) return ((z - 4) / 4) * 0.6; // ramp up
  if (z < 10) return 0.6;
  if (z < 10 + STEPS * STEP_RUN) return 0.6 + STEP_RISE * (Math.floor((z - 10) / STEP_RUN) + 1); // stairs up
  const top = 0.6 + STEPS * STEP_RISE;
  if (z < 14.4) return top;
  if (z < 14.4 + STEPS * STEP_RUN) return top - STEP_RISE * (Math.floor((z - 14.4) / STEP_RUN) + 1); // stairs down
  if (z < 16.8 + 4) return 0.6 * (1 - (z - 16.8) / 4); // slope down
  if (z < COURSE_LENGTH) return 0.05 * Math.sin(((z - 20.8) / 1.1) * Math.PI * 2) ** 2; // bumps
  return 0;
}

/** Surface normal (zero on vertical step faces is avoided: treads are flat). */
export function courseNormal(z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 0.02;
  const a = courseHeight(z - e);
  const b = courseHeight(z + e);
  // Across a step edge the finite difference is meaningless: treat as flat.
  if (Math.abs(b - a) > 0.05) return out.set(0, 1, 0);
  return out.set(0, 2 * e, -(b - a)).normalize();
}

/** Profile points (z, y) including explicit vertical step faces. */
function profile(): [number, number][] {
  const pts: [number, number][] = [];
  const steps = new Set<number>();
  for (let k = 0; k <= STEPS; k++) {
    steps.add(+(10 + k * STEP_RUN).toFixed(4));
    steps.add(+(14.4 + k * STEP_RUN).toFixed(4));
  }
  for (let z = 0; z <= COURSE_LENGTH + 1e-9; z = +(z + 0.05).toFixed(4)) {
    if (steps.has(z)) {
      pts.push([z, courseHeight(z - 1e-6)]);
      pts.push([z, courseHeight(z + 1e-6)]);
    } else {
      pts.push([z, courseHeight(z)]);
    }
  }
  return pts;
}

/** Extruded course mesh (flat-shaded) with outline edges. */
export function courseMesh(width = 2.6): THREE.Group {
  const pts = profile();
  const pos: number[] = [];
  const half = width / 2;
  const quad = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i + 1 < pts.length; i++) {
    const [z0, y0] = pts[i];
    const [z1, y1] = pts[i + 1];
    quad([-half, y0, z0], [-half, y1, z1], [half, y1, z1], [half, y0, z0]); // top / risers
    quad([half, y0, z0], [half, y1, z1], [half, 0, z1], [half, 0, z0]); // right side
    quad([-half, 0, z0], [-half, 0, z1], [-half, y1, z1], [-half, y0, z0]); // left side
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3a404b, roughness: 0.9, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: 0x5a6170 }));
  const g = new THREE.Group();
  g.add(mesh, edges);
  return g;
}
