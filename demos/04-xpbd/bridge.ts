import * as THREE from 'three';
import { ParticleSystem, type SphereCollider } from '../../src/physics/xpbd';
import type { DebugDraw } from '../../src/core/debugDraw';
import { SegmentBatch } from '../../src/rig/segments';
import { configure, drawSystem, type Material, type SolverSettings, type XpbdScene } from './types';

const N = 24;
const HALF = 2.6;
const DECK_Y = 1.2;
const HAND_Y = 2.1;

/** Rope bridge: two deck ropes carrying planks, two hand ropes, suspenders, and a boulder to push through it. */
export class BridgeScene implements XpbdScene {
  readonly root = new THREE.Group();
  readonly systems: ParticleSystem[];
  readonly handle: THREE.Mesh;
  private readonly ps = new ParticleSystem(4 * (N + 1), 2000);
  private readonly rows: number[][] = [];
  private readonly stretch: number[] = [];
  private readonly shear: number[] = [];
  private readonly bend: number[] = [];
  private readonly ropes = new SegmentBatch(256, new THREE.MeshStandardMaterial({ color: 0xb59a6a, roughness: 0.9 }));
  private readonly planks: THREE.InstancedMesh;
  private readonly boulder: SphereCollider;
  private auto = true;

  constructor() {
    this.systems = [this.ps];
    const ps = this.ps;
    ps.radius = 0.03;
    const specs = [
      { y: DECK_Y, z: -0.45, mass: 0.6, slack: 1.035 },
      { y: DECK_Y, z: 0.45, mass: 0.6, slack: 1.035 },
      { y: HAND_Y, z: -0.55, mass: 0.05, slack: 1.02 },
      { y: HAND_Y, z: 0.55, mass: 0.05, slack: 1.02 },
    ];
    for (const s of specs) {
      const row: number[] = [];
      for (let i = 0; i <= N; i++) row.push(ps.addParticle(new THREE.Vector3(THREE.MathUtils.lerp(-HALF, HALF, i / N), s.y, s.z), s.mass));
      for (let i = 0; i < N; i++) this.stretch.push(ps.addDistance(row[i], row[i + 1], 0, ps.distance(row[i], row[i + 1]) * s.slack));
      for (let i = 0; i + 2 <= N; i++) this.bend.push(ps.addDistance(row[i], row[i + 2], 0, ps.distance(row[i], row[i + 2]) * s.slack));
      for (const end of [0, N]) ps.pin(row[end], ps.get(row[end]));
      this.rows.push(row);
    }
    const [dl, dr, hl, hr] = this.rows;
    for (let i = 0; i <= N; i++) {
      this.stretch.push(ps.addDistance(dl[i], dr[i], 0));
      if (i < N) {
        this.shear.push(ps.addDistance(dl[i], dr[i + 1], 0));
        this.shear.push(ps.addDistance(dr[i], dl[i + 1], 0));
      }
      if (i % 2 === 0 && i > 0 && i < N) {
        this.stretch.push(ps.addDistance(hl[i], dl[i], 0));
        this.stretch.push(ps.addDistance(hr[i], dr[i], 0));
      }
    }

    this.planks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.035, 0.17),
      new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.85 }),
      N + 1,
    );
    this.planks.castShadow = this.planks.receiveShadow = true;
    this.planks.frustumCulled = false;
    this.root.add(this.planks, this.ropes);

    const postMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 });
    for (const x of [-HALF - 0.05, HALF + 0.05]) {
      for (const z of [-0.55, 0.55]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, HAND_Y + 0.15, 12), postMat);
        post.position.set(x, (HAND_Y + 0.15) / 2, z);
        post.castShadow = true;
        this.root.add(post);
      }
    }

    this.boulder = { centre: new THREE.Vector3(-1.5, 1.6, 0), radius: 0.35 };
    ps.spheres.push(this.boulder);
    this.handle = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.35, 2),
      new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.95, flatShading: true }),
    );
    this.handle.castShadow = true;
    this.handle.position.copy(this.boulder.centre);
    this.root.add(this.handle);
  }

  onHandleDrag(): void {
    this.auto = false;
  }

  update(dt: number, time: number): void {
    if (this.auto) {
      const x = 2.0 * Math.sin(time * 0.35);
      // Ride the deck's rest sag, pressing ~12 cm into it.
      const sag = 0.42 * (1 - (x / HALF) ** 2);
      this.handle.position.set(x, DECK_Y - sag + this.boulder.radius - 0.12, 0);
    }
    this.boulder.centre.copy(this.handle.position);
    this.ps.step(dt);
  }

  render(debug: DebugDraw, showParticles: boolean, showConstraints: boolean): void {
    const ps = this.ps;
    const [dl, dr, hl, hr] = this.rows;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    this.ropes.begin();
    for (const row of this.rows) {
      for (let i = 0; i < N; i++) this.ropes.segment(ps.get(row[i], a), ps.get(row[i + 1], b), 0.018);
    }
    for (let i = 2; i < N; i += 2) {
      this.ropes.segment(ps.get(dl[i], a), ps.get(hl[i], b), 0.01);
      this.ropes.segment(ps.get(dr[i], a), ps.get(hr[i], b), 0.01);
    }
    this.ropes.commit();

    const m = new THREE.Matrix4();
    const x = new THREE.Vector3();
    const y = new THREE.Vector3();
    const z = new THREE.Vector3();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      ps.get(dl[i], a);
      ps.get(dr[i], b);
      x.subVectors(b, a);
      const len = x.length();
      x.normalize();
      // Basis: X across the plank (rope to rope), Y up (⟂ deck), Z along the bridge.
      ps.get(dl[Math.min(N, i + 1)], z).sub(ps.get(dl[Math.max(0, i - 1)], p));
      y.crossVectors(x, z).normalize();
      z.crossVectors(x, y);
      m.makeBasis(x, y, z);
      q.setFromRotationMatrix(m);
      p.lerpVectors(a, b, 0.5).addScaledVector(y, 0.02);
      m.compose(p, q, s.set(len + 0.12, 1, 1));
      this.planks.setMatrixAt(i, m);
    }
    this.planks.instanceMatrix.needsUpdate = true;
    drawSystem(ps, debug, showParticles, showConstraints);
  }

  applyMaterial(m: Material): void {
    for (const k of this.stretch) this.ps.setCompliance(k, 10 ** m.stretch);
    for (const k of this.shear) this.ps.setCompliance(k, 10 ** m.shear);
    for (const k of this.bend) this.ps.setCompliance(k, 10 ** m.bend);
  }

  applySolver(s: SolverSettings): void {
    configure(this.ps, s);
    this.ps.wind.set(s.wind * 0.3, 0, s.wind);
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
