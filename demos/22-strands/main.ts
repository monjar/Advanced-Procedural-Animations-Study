import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createNoise2D } from '../../src/math/noise';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import { quatFromD3, Rods } from './rod';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '22',
  writeup,
  hint: 'Hair: drag the head · Octopus: click to make an arm reach · Twist: watch it coil · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 60, cameraPosition: [0.7, 1.7, 1.1], cameraTarget: [0, 1.45, 0] });
frame.attach(app);
app.camera.near = 0.01;
app.camera.updateProjectionMatrix();
const { noise } = createNoise2D(5);

type SceneName = 'hair' | 'octopus' | 'twist';
const asked = new URLSearchParams(location.search).get('scene') as SceneName | null;
const settings = {
  scene: (asked && ['hair', 'octopus', 'twist'].includes(asked) ? asked : 'hair') as SceneName,
  // hair
  curl: 0,
  stiffness: 0.4,
  wind: 0.3,
  shake: false,
  color: 'brown',
  // twist
  twistRate: 0.1,
  twistRatio: 1,
  twisting: true,
  substeps: 10,
  iterations: 2,
};
const readout = { info: '' };

// ---------------------------------------------------------------------------------------- tube along a rod

/** A tube mesh following one rod, its rings oriented by the rod's material frames, so twist shows. */
class RodTube {
  readonly mesh: THREE.Mesh;
  private readonly R = 10;
  constructor(
    private readonly rods: Rods,
    private readonly rod: number,
    private readonly radius: (u: number) => number,
    private readonly color: (u: number, around: number) => [number, number, number],
  ) {
    const rows = rods.np;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows * this.R * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rows * this.R * 3), 3));
    const idx: number[] = [];
    for (let r = 0; r < rows - 1; r++)
      for (let k = 0; k < this.R; k++) {
        const a = r * this.R + k;
        const b = r * this.R + ((k + 1) % this.R);
        idx.push(a, b, a + this.R, b, b + this.R, a + this.R);
      }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }

  update(): void {
    const { rods, rod, R } = this;
    const pos = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const d1 = [0, 0, 0];
    const d2 = [0, 0, 0];
    const n = rods.n;
    for (let i = 0; i <= n; i++) {
      const s = rod * n + Math.min(i, n - 1);
      rods.axis(s, 0, d1);
      rods.axis(s, 1, d2);
      const k = (rod * rods.np + i) * 3;
      const u = i / n;
      const r = this.radius(u);
      for (let j = 0; j < R; j++) {
        const a = (j / R) * Math.PI * 2;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        pos.setXYZ(i * R + j, rods.x[k] + r * (c * d1[0] + sn * d2[0]), rods.x[k + 1] + r * (c * d1[1] + sn * d2[1]), rods.x[k + 2] + r * (c * d1[2] + sn * d2[2]));
        const [cr, cg, cb] = this.color(u, a);
        col.setXYZ(i * R + j, cr, cg, cb);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }
}

// ---------------------------------------------------------------------------------------- scenes

interface Scene {
  group: THREE.Group;
  rods: Rods;
  step(dt: number, t: number): void;
  draw(): void;
  pick?(ray: THREE.Ray): void;
  drag?: boolean;
}

const HAIR_COLORS: Record<string, [number[], number[]]> = {
  brown: [
    [0.16, 0.09, 0.05],
    [0.42, 0.27, 0.15],
  ],
  blonde: [
    [0.5, 0.38, 0.2],
    [0.93, 0.8, 0.52],
  ],
  black: [
    [0.03, 0.03, 0.035],
    [0.16, 0.15, 0.16],
  ],
  red: [
    [0.35, 0.09, 0.03],
    [0.75, 0.3, 0.12],
  ],
};

function hairScene(): Scene {
  const group = new THREE.Group();
  const HEAD = new THREE.Vector3(0, 1.55, 0);
  const R = 0.095;
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a383, roughness: 0.6 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 28), skin);
  head.scale.set(1, 1.12, 1.05);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.16, 20), skin);
  const shoulders = new THREE.Mesh(new THREE.SphereGeometry(0.22, 32, 20), new THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.8 }));
  shoulders.scale.set(1, 0.5, 0.6);
  const body = new THREE.Group();
  body.add(neck, shoulders);
  neck.position.set(0, -0.15, -0.01);
  shoulders.position.set(0, -0.32, 0);
  const headPivot = new THREE.Group();
  headPivot.add(head);
  // Eyes and a nose so the head has a front.
  for (const x of [-0.033, 0.033]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 8), new THREE.MeshStandardMaterial({ color: 0x1a1a1a }));
    e.position.set(x, 0.01, R * 1.0);
    headPivot.add(e);
  }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.03, 10), skin);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, -0.015, R * 1.08);
  headPivot.add(nose);
  for (const m of [head, neck, shoulders]) m.castShadow = m.receiveShadow = true;
  const root = new THREE.Group();
  root.add(headPivot, body);
  group.add(root);

  // Hair roots on the scalp (not the face), Fibonacci-spread.
  const roots: THREE.Vector3[] = [];
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const th = i * Math.PI * (3 - Math.sqrt(5));
    const v = new THREE.Vector3(r * Math.cos(th), y, r * Math.sin(th));
    if (v.y < -0.15) continue;
    if (v.z > 0.2 && v.y < 0.8) continue; // face and forehead
    if (Math.abs(v.x) > 0.8 && v.y < 0.25 && v.z > -0.2) continue; // ears
    roots.push(v);
  }
  const SEG = 14;
  const rods = new Rods(roots.length, SEG, { bendCompliance: 0.02, twistCompliance: 0.02, stretchCompliance: 0, damping: 1.5, gravity: 9.81, mass: 0.0004 });
  const l = 0.024;
  const localDir: THREE.Vector3[] = [];
  const localQ: number[][] = [];
  roots.forEach((v, i) => {
    // Hair leaves the scalp along the normal, combed back and down a little.
    const dir = v.clone().add(new THREE.Vector3(0, -0.35, -0.25)).normalize();
    localDir.push(dir);
    localQ.push(quatFromD3([dir.x, dir.y, dir.z], [0, 0, 1]));
    rods.layOut(i, [HEAD.x + v.x * R, HEAD.y + v.y * R * 1.12, HEAD.z + v.z * R * 1.05], [dir.x, dir.y, dir.z], l, [0, 0, 1]);
    rods.w[i * rods.np] = 0;
    rods.w[i * rods.np + 1] = 0;
    rods.wq[i * SEG] = 0;
  });
  rods.setInertia(0.25);
  rods.iterations = 2;

  // Line segments, coloured root → tip.
  const lineGeo = new THREE.BufferGeometry();
  const segs = roots.length * SEG;
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs * 6), 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segs * 6), 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
  lines.frustumCulled = false;
  group.add(lines);

  const headQ = new THREE.Quaternion();
  const headPos = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tq = new THREE.Quaternion();
  const lq = new THREE.Quaternion();
  let dragTarget: THREE.Vector3 | null = null;
  const pose = (t: number) => {
    const yaw = settings.shake ? 0.7 * Math.sin(2 * Math.PI * 0.9 * t) : 0;
    const nod = settings.shake ? 0.12 * Math.sin(2 * Math.PI * 1.8 * t) : 0;
    headQ.setFromEuler(new THREE.Euler(nod, yaw, 0, 'YXZ'));
    headPos.copy(HEAD).add(offset);
  };
  const setRest = () => {
    // Curly hair: a helix — constant curvature about d₁ plus torsion about d₃ (Darboux vector, half-angles).
    const k = settings.curl * 60;
    for (let s = 0; s < rods.count * SEG; s++) {
      rods.rest[s * 3] = Math.sin((k * l) / 2);
      rods.rest[s * 3 + 1] = 0;
      rods.rest[s * 3 + 2] = Math.sin((0.35 * k * l) / 2);
    }
    // Stiffness as the length a strand can stand up under its own weight before it buckles over (Greenhill's
    // "tallest column", L³ = 7.84·EI/q): real hair, about 10 cm. Then α = l / (4·EI).
    const standUp = 0.04 * Math.pow(10, settings.stiffness);
    const q = (rods.params.mass / l) * rods.params.gravity;
    const EI = (q * standUp ** 3) / 7.84;
    rods.params.bendCompliance = l / (4 * EI);
    rods.params.twistCompliance = rods.params.bendCompliance;
  };
  setRest();

  return {
    group,
    rods,
    drag: true,
    step(h, t) {
      setRest();
      if (dragTarget) offset.lerp(dragTarget.clone().sub(HEAD), 1 - Math.exp(-h * 12));
      pose(t);
      root.position.copy(offset);
      headPivot.position.copy(HEAD);
      headPivot.quaternion.copy(headQ);
      body.position.copy(HEAD);
      // Roots follow the head.
      for (let i = 0; i < roots.length; i++) {
        const v = roots[i];
        tmp.set(v.x * R, v.y * R * 1.12, v.z * R * 1.05).applyQuaternion(headQ).add(headPos);
        const k0 = i * rods.np * 3;
        const d = localDir[i].clone().applyQuaternion(headQ);
        rods.x[k0] = rods.p[k0] = tmp.x;
        rods.x[k0 + 1] = rods.p[k0 + 1] = tmp.y;
        rods.x[k0 + 2] = rods.p[k0 + 2] = tmp.z;
        rods.x[k0 + 3] = rods.p[k0 + 3] = tmp.x + d.x * l;
        rods.x[k0 + 4] = rods.p[k0 + 4] = tmp.y + d.y * l;
        rods.x[k0 + 5] = rods.p[k0 + 5] = tmp.z + d.z * l;
        lq.fromArray(localQ[i]);
        tq.copy(headQ).multiply(lq);
        rods.q.set([tq.x, tq.y, tq.z, tq.w], i * SEG * 4);
      }
      // Collide with the head (scaled sphere ≈ sphere), neck and shoulders; wind as a gusty acceleration.
      rods.spheres = [
        [headPos.x, headPos.y + 0.004, headPos.z, R * 1.1],
        [headPos.x, headPos.y - 0.15, headPos.z - 0.01, 0.065],
        [headPos.x, headPos.y - 0.36, headPos.z, 0.13],
        [headPos.x + 0.12, headPos.y - 0.31, headPos.z, 0.1],
        [headPos.x - 0.12, headPos.y - 0.31, headPos.z, 0.1],
      ];
      const gust = settings.wind * (1 + noise(t * 0.4, 1)) * 2.5;
      for (let i = 0; i < rods.count * rods.np; i++) {
        rods.accel[i * 3] = gust * (0.8 + 0.4 * noise(t * 1.3, i * 0.37));
        rods.accel[i * 3 + 2] = gust * 0.5 * noise(t * 0.9, i * 0.21 + 50);
      }
      rods.substep(h);
    },
    draw() {
      const pos = lineGeo.getAttribute('position') as THREE.BufferAttribute;
      const col = lineGeo.getAttribute('color') as THREE.BufferAttribute;
      const [a, b] = HAIR_COLORS[settings.color];
      let k = 0;
      for (let r = 0; r < rods.count; r++) {
        const shade = 0.85 + 0.3 * ((r * 7919) % 100) / 100;
        for (let i = 0; i < SEG; i++) {
          for (const j of [i, i + 1]) {
            const p = (r * rods.np + j) * 3;
            pos.setXYZ(k, rods.x[p], rods.x[p + 1], rods.x[p + 2]);
            const u = j / SEG;
            col.setXYZ(k, (a[0] + (b[0] - a[0]) * u) * shade, (a[1] + (b[1] - a[1]) * u) * shade, (a[2] + (b[2] - a[2]) * u) * shade);
            k++;
          }
        }
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
    },
    pick(ray) {
      // Drag in the vertical plane through the head.
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1).applyQuaternion(app.camera.quaternion).setY(0).normalize(), 0);
      plane.setFromNormalAndCoplanarPoint(plane.normal, headPos);
      const p = new THREE.Vector3();
      if (ray.intersectPlane(plane, p)) dragTarget = p;
    },
  } satisfies Scene & { pick(ray: THREE.Ray): void };
}

function octopusScene(): Scene {
  const group = new THREE.Group();
  const C = new THREE.Vector3(0, 0.62, 0);
  const ARMS = 8;
  const SEG = 18;
  const L = 0.72;
  const l = L / SEG;
  const rods = new Rods(ARMS, SEG, { bendCompliance: 0.02, twistCompliance: 0.02, stretchCompliance: 0, damping: 2.5, gravity: 1.2, mass: 0.02 });
  rods.ground = 0.012;
  const skin = new THREE.MeshStandardMaterial({ color: 0xc8553d, roughness: 0.55 });
  const mantle = new THREE.Mesh(new THREE.SphereGeometry(0.16, 40, 28), skin);
  mantle.scale.set(1, 1.35, 1.05);
  mantle.position.copy(C).add(new THREE.Vector3(0, 0.1, -0.03));
  mantle.castShadow = true;
  group.add(mantle);
  for (const x of [-0.07, 0.07]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf2e6c9, roughness: 0.3 }));
    eye.position.copy(C).add(new THREE.Vector3(x, 0.02, 0.12));
    const pupil = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.008, 0.01), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    pupil.position.copy(eye.position).add(new THREE.Vector3(0, 0, 0.029));
    group.add(eye, pupil);
  }
  const baseQ: number[][] = [];
  const bases: THREE.Vector3[] = [];
  for (let a = 0; a < ARMS; a++) {
    const th = (a / ARMS) * Math.PI * 2 + Math.PI / ARMS;
    const base = C.clone().add(new THREE.Vector3(0.1 * Math.cos(th), -0.06, 0.1 * Math.sin(th)));
    const dir = new THREE.Vector3(Math.cos(th) * 0.75, -0.66, Math.sin(th) * 0.75).normalize();
    rods.layOut(a, [base.x, base.y, base.z], [dir.x, dir.y, dir.z], l);
    rods.w[a * rods.np] = 0;
    rods.w[a * rods.np + 1] = 0;
    rods.wq[a * SEG] = 0;
    baseQ.push(Array.from(rods.q.slice(a * SEG * 4, a * SEG * 4 + 4)));
    bases.push(base);
  }
  rods.setInertia(0.25);
  rods.iterations = 3;
  const tubes = Array.from({ length: ARMS }, (_, a) => {
    const t = new RodTube(
      rods,
      a,
      (u) => 0.03 * (1 - 0.85 * u) + 0.002,
      // Suckers: pale spots in a row along the d₁ side of the material frame, so twist shows.
      (u, ang) => (Math.cos(ang) > 0.75 && Math.sin(u * 90) > 0 ? [0.95, 0.82, 0.72] : [0.78 - 0.1 * u, 0.33, 0.24]),
    );
    group.add(t.mesh);
    return t;
  });

  // Reaching by bend propagation (Gutfreund et al. 1996): the arm, curled, is aimed at the target at its base;
  // a bend point then runs out to the tip, straightening the arm behind it; the tip curls to grasp.
  interface Reach {
    arm: number;
    target: THREE.Vector3;
    t: number;
  }
  let reach: Reach | null = null;
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x553300 }));
  marker.visible = false;
  group.add(marker);
  const tq = new THREE.Quaternion();
  const half = (angle: number) => Math.sin(angle / 2);

  return {
    group,
    rods,
    step(h, t) {
      for (let a = 0; a < ARMS; a++) {
        const phase = (a / ARMS) * Math.PI * 2;
        for (let j = 0; j < SEG - 1; j++) {
          const u = (j + 1) / SEG;
          const s = (a * SEG + j) * 3;
          // Idle: slow curling waves that grow toward the tip.
          const k1 = 7 * u * Math.sin(2 * Math.PI * 0.22 * t - 5 * u + phase);
          const k2 = 4 * u * Math.cos(2 * Math.PI * 0.15 * t - 3 * u + 1.7 * phase);
          rods.rest[s] = half(k1 * l);
          rods.rest[s + 1] = half(k2 * l);
          rods.rest[s + 2] = 0;
        }
      }
      if (reach) {
        reach.t += h;
        const a = reach.arm;
        // Aim: the direction to the target in the base segment's frame.
        tq.fromArray(baseQ[a]).invert();
        const u = reach.target.clone().sub(bases[a]).normalize().applyQuaternion(tq);
        const axis = new THREE.Vector3(0, 0, 1).cross(u);
        const phi = Math.acos(THREE.MathUtils.clamp(u.z, -1, 1));
        if (axis.lengthSq() < 1e-9) axis.set(1, 0, 0);
        axis.normalize();
        const T = reach.t;
        const extend = THREE.MathUtils.clamp((T - 0.3) / 1.1, 0, 1);
        const retract = THREE.MathUtils.clamp((T - 2.6) / 1.2, 0, 1);
        const front = (extend - retract) * (SEG - 1);
        for (let j = 0; j < SEG - 1; j++) {
          const s = (a * SEG + j) * 3;
          let ang = 0;
          if (j < 3) ang = phi / 3;
          else if (j > front) ang = 14 * l; // still curled beyond the bend point
          if (T > 1.4 && T < 2.8 && j >= SEG - 5) ang = 22 * l; // grasp
          rods.rest[s] = half(ang) * axis.x;
          rods.rest[s + 1] = half(ang) * axis.y;
          rods.rest[s + 2] = half(ang) * axis.z;
        }
        if (T > 4) {
          reach = null;
          marker.visible = false;
        }
      }
      rods.substep(h);
    },
    draw() {
      mantle.scale.set(1, 1.35 + 0.03 * Math.sin(performance.now() / 600), 1.05);
      for (const t of tubes) t.update();
    },
    pick(ray) {
      // Target: the point on the ray nearest the octopus, kept within reach.
      const p = ray.closestPointToPoint(C, new THREE.Vector3());
      const d = p.clone().sub(C);
      if (d.length() > L * 0.95) d.setLength(L * 0.95);
      p.copy(C).add(d);
      p.y = Math.max(0.05, p.y);
      // The arm whose base points most toward it.
      let best = 0;
      let bestDot = -Infinity;
      for (let a = 0; a < ARMS; a++) {
        const dir = bases[a].clone().sub(C).setY(0).normalize();
        const dd = dir.dot(p.clone().sub(C).setY(0).normalize());
        if (dd > bestDot) (bestDot = dd), (best = a);
      }
      reach = { arm: best, target: p, t: 0 };
      marker.position.copy(p);
      marker.visible = true;
    },
  };
}

function twistScene(): Scene {
  const group = new THREE.Group();
  const SEG = 20;
  const L = 1;
  const l = L / SEG;
  const alphaB = 0.004;
  const alphaT = alphaB * settings.twistRatio;
  const rods = new Rods(1, SEG, { bendCompliance: alphaB, twistCompliance: alphaT, stretchCompliance: 0, damping: 2, gravity: 0, mass: 0.01 });
  const y = 0.6;
  rods.layOut(0, [-L / 2, y, 0], [1, 0, 0], l);
  rods.setInertia(0.25);
  // Converged: with fewer passes the twist does not spread evenly before the rod buckles.
  rods.iterations = 40;
  rods.selfRadius = 0.02;
  rods.w[0] = rods.w[1] = 0;
  rods.wq[0] = 0;
  rods.wq[SEG - 1] = 0;
  // Left end clamped; right end clamped in angle but free to slide along the axis (no tension), as in Greenhill.
  rods.sleeve = [SEG - 1, SEG];
  rods.sleeveAt = [0, y, 0];
  rods.sleeveDir = [1, 0, 0];
  for (let i = 2; i < SEG - 1; i++) rods.x[i * 3 + 2] += 1e-4 * Math.sin((i / SEG) * Math.PI);
  const base = Array.from(rods.q.slice((SEG - 1) * 4, SEG * 4));
  const tube = new RodTube(
    rods,
    0,
    () => 0.02,
    // A stripe along d₁: straight when untwisted, a helix when twisted.
    (_u, ang) => (Math.cos(ang) > 0.6 ? [0.98, 0.82, 0.3] : [0.25, 0.45, 0.85]),
  );
  group.add(tube.mesh);
  const clampMat = new THREE.MeshStandardMaterial({ color: 0x59606e });
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.12), clampMat);
  left.position.set(-L / 2 - 0.02, y, 0);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.1, 20).rotateZ(Math.PI / 2), clampMat);
  group.add(left, sleeve);
  let turns = 0;
  let buckledAt = -1;
  // Greenhill (1883): a rod clamped at both ends buckles under the twisting moment M = 2.86π·EI/L. With
  // M = GJ·2πn/L and EI, GJ = l/(4α), the twist at buckling is n = 1.43·α_twist/α_bend turns.
  const predicted = 1.43 * (alphaT / alphaB);
  return {
    group,
    rods,
    step(h) {
      if (settings.twisting && buckledAt < 0) turns += settings.twistRate * h;
      rods.twistSegment(SEG - 1, 2 * Math.PI * turns, base);
      rods.substep(h);
      sleeve.position.set(rods.x[SEG * 3] + 0.03, y, 0);
      let off = 0;
      for (let i = 0; i <= SEG; i++) off = Math.max(off, Math.hypot(rods.x[i * 3 + 1] - y, rods.x[i * 3 + 2]));
      if (off > 0.03 && buckledAt < 0) buckledAt = turns;
      readout.info =
        buckledAt < 0
          ? `${turns.toFixed(2)} turns · Greenhill: buckles at ${predicted.toFixed(2)}`
          : `buckled at ${buckledAt.toFixed(2)} turns · Greenhill ${predicted.toFixed(2)}`;
      if (twistTrace.length < 600 && Math.floor(turns * 60) > twistTrace.length) twistTrace.push(off * 100);
    },
    draw() {
      tube.update();
    },
  };
}
const twistTrace: number[] = [];

// ---------------------------------------------------------------------------------------- scene switching

const sand = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0xb59a73, roughness: 1 }));
sand.rotation.x = -Math.PI / 2;
sand.position.y = 0.002;
sand.receiveShadow = true;
let scene: Scene;
const CAMERAS: Record<SceneName, { pos: THREE.Vector3Tuple; target: THREE.Vector3Tuple }> = {
  hair: { pos: [0.75, 1.7, 1.0], target: [0, 1.42, 0] },
  octopus: { pos: [1.3, 1.0, 1.5], target: [0, 0.35, 0] },
  twist: { pos: [0.5, 1.0, 1.4], target: [0.15, 0.6, 0] },
};
function setScene(name: SceneName): void {
  if (scene) app.scene.remove(scene.group);
  scene = name === 'hair' ? hairScene() : name === 'octopus' ? octopusScene() : twistScene();
  app.scene.add(scene.group);
  const c = CAMERAS[name];
  app.camera.position.set(...c.pos);
  app.controls.target.set(...c.target);
  // Under water for the octopus.
  const water = name === 'octopus';
  (app.scene.background as THREE.Color).set(water ? 0x0d3a4d : 0x15171c);
  (app.scene.fog as THREE.Fog).color.set(water ? 0x0d3a4d : 0x15171c);
  (app.scene.fog as THREE.Fog).near = water ? 1.5 : 18;
  (app.scene.fog as THREE.Fog).far = water ? 6 : 45;
  if (water) app.scene.add(sand);
  else app.scene.remove(sand);
  twistTrace.length = 0;
  // The twisted rod runs in its validated configuration (see the write-up); the others at interactive cost.
  if (name === 'twist') settings.twistRate = 0.05;
  rebuildFolder();
}

let time = 0;
let cost = 0;
app.onFixedUpdate((dt) => {
  // The twisted rod keeps a fixed 1/1200 s substep (its validated setting) whatever the frame timing.
  const sub = settings.scene === 'twist' ? Math.max(1, Math.round(dt * 1200)) : settings.substeps;
  const t0 = performance.now();
  if (settings.scene !== 'twist') scene.rods.iterations = settings.iterations;
  for (let k = 0; k < sub; k++) {
    time += dt / sub;
    scene.step(dt / sub, time);
  }
  cost += (performance.now() - t0 - cost) * 0.05;
});

// ---------------------------------------------------------------------------------------- input

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let dragging = false;
const setRay = (e: PointerEvent) => {
  const r = app.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, app.camera);
};
app.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !scene.pick) return;
  setRay(e);
  if (scene.drag) {
    dragging = true;
    app.controls.enabled = false;
  }
  scene.pick(raycaster.ray);
});
app.renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging || !scene.pick) return;
  setRay(e);
  scene.pick(raycaster.ray);
});
window.addEventListener('pointerup', () => {
  dragging = false;
  app.controls.enabled = true;
});

// ---------------------------------------------------------------------------------------- frame & controls

const plot = new LinePlot(frame.addPanel('Twisted rod: bulge (cm) vs turns'), { height: 90, yMin: 0, yMax: 10, yTicks: [0, 5, 10], xTickStep: 1, formatX: (x) => `${x.toFixed(0)}` });
app.onFrame(() => {
  scene.draw();
  if (settings.scene !== 'twist') readout.info = `${scene.rods.count} rods × ${scene.rods.n} segments · ${cost.toFixed(1)} ms per frame`;
  plot.draw([{ values: twistTrace, dx: 1 / 60, color: '#ffd166' }], 4);
  simHooks.end();
  simHooks.begin();
});

const pane = createPane(frame.controls);
pane.addBinding(settings, 'scene', { options: { 'hair (≈450 strands)': 'hair', 'octopus arms': 'octopus', 'twisted rod (Greenhill buckling)': 'twist' } }).on('change', (ev) => setScene(ev.value));
let folder = pane.addFolder({ title: 'Scene' });
function rebuildFolder(): void {
  folder.dispose();
  folder = pane.addFolder({ title: 'Scene', index: 1 } as never);
  if (settings.scene === 'hair') {
    folder.addBinding(settings, 'curl', { min: 0, max: 1, step: 0.05, label: 'curl (rest Darboux)' });
    folder.addBinding(settings, 'stiffness', { min: 0, max: 1, step: 0.05, format: (v: number) => `${(4 * Math.pow(10, v)).toFixed(0)} cm` , label: 'stands up to' } as never);
    folder.addBinding(settings, 'wind', { min: 0, max: 1, step: 0.05 });
    folder.addBinding(settings, 'shake', { label: 'shake the head' });
    folder.addBinding(settings, 'color', { options: { brown: 'brown', blonde: 'blonde', black: 'black', red: 'red' } });
  } else if (settings.scene === 'twist') {
    folder.addBinding(settings, 'twistRatio', { options: { 'twist ½ as stiff as bend': 2, 'equal': 1, 'twist 2× as stiff': 0.5 }, label: 'α twist / α bend' }).on('change', () => setScene('twist'));
    folder.addBinding(settings, 'twistRate', { min: 0, max: 0.3, step: 0.01, label: 'turns per second' });
    folder.addBinding(settings, 'twisting', { label: 'twist the right end' });
    folder.addButton({ title: 'Reset' }).on('click', () => setScene('twist'));
  } else {
    folder.addButton({ title: 'Reset' }).on('click', () => setScene('octopus'));
  }
  if (settings.scene !== 'twist') {
    folder.addBinding(settings, 'substeps', { min: 1, max: 30, step: 1 });
    folder.addBinding(settings, 'iterations', { min: 1, max: 12, step: 1, label: 'iterations / substep' });
  }
}
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'info', { readonly: true, label: '' });
const simHooks = addSimulationFolder(pane, app.loop);
setScene(settings.scene);
app.start();
