import * as THREE from 'three';
import { ParticleSystem, type CapsuleCollider } from '../../src/physics/xpbd';
import type { DebugDraw } from '../../src/core/debugDraw';
import { SegmentBatch } from '../../src/rig/segments';
import { applyAerodynamics, buildCloth, ClothMesh, type ClothGrid } from './cloth';
import { configure, drawSystem, type Material, type SolverSettings, type XpbdScene } from './types';

const W = 13;
const H = 17;

interface Part {
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
  collider: CapsuleCollider;
}

/** A mannequin walking a circle wearing a cape pinned across its shoulders. */
export class CapeScene implements XpbdScene {
  readonly root = new THREE.Group();
  readonly systems: ParticleSystem[];
  readonly walk = { speed: 2.2, radius: 2.4 };
  private readonly ps = new ParticleSystem(W * H, W * H * 8);
  private readonly grid: ClothGrid;
  private readonly cloth: ClothMesh;
  private readonly body = new THREE.Group();
  private readonly parts: Part[] = [];
  private readonly mannequin = new SegmentBatch(8, new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.55 }));
  private readonly pinLocal: THREE.Vector3[] = [];
  private angle = 0;
  private phase = 0;
  private windStrength = 0;
  private readonly wind = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor() {
    this.systems = [this.ps];
    this.root.add(this.body, this.mannequin);

    const addPart = (radius: number) => {
      const part: Part = { a: new THREE.Vector3(), b: new THREE.Vector3(), radius, collider: { a: new THREE.Vector3(), b: new THREE.Vector3(), radius } };
      this.parts.push(part);
      this.ps.capsules.push(part.collider);
      return part;
    };
    // torso, head, 2 legs, 2 arms
    for (const r of [0.17, 0.12, 0.075, 0.075, 0.055, 0.055]) addPart(r);

    this.placeBody(0);
    // Pins: across the shoulders, curving around the back.
    for (let i = 0; i < W; i++) {
      const x = THREE.MathUtils.lerp(-0.24, 0.24, i / (W - 1));
      const z = -0.2 * Math.sqrt(Math.max(0, 1 - (x / 0.3) ** 2)) - 0.02;
      this.pinLocal.push(new THREE.Vector3(x, 1.43, z));
    }
    this.body.updateMatrixWorld(true);
    const m = this.body.matrixWorld;
    this.grid = buildCloth(
      this.ps,
      W,
      H,
      (i, j) => {
        const t = j / (H - 1);
        const x = THREE.MathUtils.lerp(-0.24, 0.24, i / (W - 1)) * (1 + 0.6 * t);
        return new THREE.Vector3(x, 1.43 - t * 1.0, this.pinLocal[i].z - 0.04 - 0.1 * t).applyMatrix4(m);
      },
      0.002,
    );
    for (let i = 0; i < W; i++) this.ps.pin(this.grid.index(i, 0), this.tmp.copy(this.pinLocal[i]).applyMatrix4(m));
    this.ps.radius = 0.015;

    this.cloth = new ClothMesh(
      this.grid,
      new THREE.MeshStandardMaterial({ color: 0xc8402e, roughness: 0.85, side: THREE.DoubleSide }),
    );
    this.root.add(this.cloth);
  }

  /** Pose the kinematic mannequin for walk angle and stride phase. */
  private placeBody(dt: number): void {
    const { speed, radius } = this.walk;
    this.angle += (speed / radius) * dt;
    this.phase += speed * dt * 1.8;
    const a = this.angle;
    const bob = 0.035 * Math.abs(Math.sin(this.phase * Math.PI));
    this.body.position.set(Math.cos(a) * radius, bob, Math.sin(a) * radius);
    // Local +Z along the counter-clockwise tangent (−sin a, 0, cos a); the centre is on local −X.
    this.body.rotation.set(0, -a, 0);
    this.body.rotateZ(0.12 * Math.min(1, speed / 3)); // lean into the turn
    this.body.rotateX(0.08 * Math.min(1, speed / 3)); // lean forward when fast
    this.body.updateMatrixWorld(true);

    const s = Math.sin(this.phase * Math.PI);
    const stride = Math.min(0.32, 0.12 * speed);
    const local: [THREE.Vector3Tuple, THREE.Vector3Tuple][] = [
      [[0, 0.95, 0], [0, 1.42, 0]],
      [[0, 1.6, 0.01], [0, 1.66, 0.01]],
      [[-0.1, 0.9, 0], [-0.1, 0.08, stride * s]],
      [[0.1, 0.9, 0], [0.1, 0.08, -stride * s]],
      [[-0.24, 1.4, 0], [-0.28, 0.9, -stride * 0.7 * s]],
      [[0.24, 1.4, 0], [0.28, 0.9, stride * 0.7 * s]],
    ];
    const m = this.body.matrixWorld;
    this.parts.forEach((p, i) => {
      p.a.set(...local[i][0]).applyMatrix4(m);
      p.b.set(...local[i][1]).applyMatrix4(m);
      p.collider.a.copy(p.a);
      p.collider.b.copy(p.b);
    });
  }

  update(dt: number, time: number): void {
    this.placeBody(dt);
    const m = this.body.matrixWorld;
    for (let i = 0; i < W; i++) this.ps.pin(this.grid.index(i, 0), this.tmp.copy(this.pinLocal[i]).applyMatrix4(m));
    const gust = 0.6 + 0.4 * Math.sin(time * 1.3) * Math.sin(time * 0.37);
    this.wind.set(1, 0, 0.35).normalize().multiplyScalar(this.windStrength * gust);
    applyAerodynamics(this.ps, this.grid, this.wind, 0.7);
    this.ps.step(dt);
  }

  render(debug: DebugDraw, showParticles: boolean, showConstraints: boolean): void {
    this.mannequin.begin();
    for (const p of this.parts) {
      this.mannequin.segment(p.a, p.b, p.radius);
      this.mannequin.joint(p.a, p.radius);
      this.mannequin.joint(p.b, p.radius);
    }
    this.mannequin.commit();
    this.cloth.sync(this.ps);
    drawSystem(this.ps, debug, showParticles, showConstraints);
  }

  applyMaterial(m: Material): void {
    for (const k of this.grid.stretch) this.ps.setCompliance(k, 10 ** m.stretch);
    for (const k of this.grid.shear) this.ps.setCompliance(k, 10 ** m.shear);
    for (const k of this.grid.bend) this.ps.setCompliance(k, 10 ** m.bend);
  }

  applySolver(s: SolverSettings): void {
    configure(this.ps, s);
    this.windStrength = s.wind;
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }

  /** Mannequin position, for camera follow. */
  get focus(): THREE.Vector3 {
    return this.body.position;
  }
}
