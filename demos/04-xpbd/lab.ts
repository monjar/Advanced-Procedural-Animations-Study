import * as THREE from 'three';
import { ParticleSystem } from '../../src/physics/xpbd';
import type { DebugDraw } from '../../src/core/debugDraw';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { SegmentBatch } from '../../src/rig/segments';
import { configure, drawSystem, type Material, type SolverSettings, type XpbdScene } from './types';

const SEGMENTS = 20;
const SEG_LEN = 0.06;
const TOP = 2.3;
const ROPES = [
  { compliance: 0, k: 1, color: 0x5fb3ff },
  { compliance: 1e-3, k: 0.3, color: 0x4fd18b },
  { compliance: 4e-3, k: 0.1, color: 0xffd166 },
  { compliance: 1.6e-2, k: 0.03, color: 0xff8a3d },
];

/**
 * Stiffness lab: four ropes with increasing compliance under the same solver. In XPBD mode their
 * stretch is a material property; in PBD mode it changes with substeps and iterations.
 */
export class LabScene implements XpbdScene {
  readonly root = new THREE.Group();
  readonly systems: ParticleSystem[] = [];
  readonly sway = { enabled: true };
  private readonly anchors: THREE.Vector3[] = [];
  private readonly batch = new SegmentBatch(128, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
  private readonly bar: THREE.Mesh;
  private mode: 'xpbd' | 'pbd' = 'xpbd';
  labels: CSS2DObject[] = [];
  private readonly labelAnchors: THREE.Object3D[] = [];

  constructor(label: (text: string, parent: THREE.Object3D) => CSS2DObject) {
    ROPES.forEach((r, i) => {
      const x = (i - 1.5) * 0.7;
      const ps = new ParticleSystem(SEGMENTS + 1);
      ps.groundY = 0;
      ps.radius = 0.02;
      let prev = ps.addParticle(new THREE.Vector3(x, TOP, 0), 0.02);
      for (let s = 1; s <= SEGMENTS; s++) {
        const p = ps.addParticle(new THREE.Vector3(x, TOP - s * SEG_LEN, 0), 0.02);
        ps.addDistance(prev, p, r.compliance, SEG_LEN);
        prev = p;
      }
      this.anchors.push(new THREE.Vector3(x, TOP, 0));
      ps.pin(0, this.anchors[i]);
      this.systems.push(ps);
      const anchor = new THREE.Object3D();
      this.root.add(anchor);
      this.labelAnchors.push(anchor);
      this.labels.push(label('', anchor));
    });
    this.bar = new THREE.Mesh(
      new THREE.BoxGeometry(2.8, 0.06, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.5 }),
    );
    this.bar.position.y = TOP + 0.03;
    this.bar.castShadow = true;
    this.root.add(this.bar, this.batch);
  }

  update(dt: number, time: number): void {
    const dx = this.sway.enabled ? 0.5 * Math.sin(time * 1.1) : 0;
    this.bar.position.x = dx;
    this.systems.forEach((ps, i) => {
      ps.pin(0, new THREE.Vector3(this.anchors[i].x + dx, TOP, 0));
      ps.step(dt);
    });
  }

  render(debug: DebugDraw, showParticles: boolean, showConstraints: boolean): void {
    this.batch.begin();
    const pts: THREE.Vector3[] = [];
    this.systems.forEach((ps, i) => {
      pts.length = 0;
      for (let k = 0; k < ps.count; k++) pts.push(ps.get(k));
      this.batch.chain(pts, 0.018, 0.012, ROPES[i].color);
      let length = 0;
      for (let k = 1; k < pts.length; k++) length += pts[k].distanceTo(pts[k - 1]);
      const stretch = (length / (SEGMENTS * SEG_LEN) - 1) * 100;
      const r = ROPES[i];
      const param = this.mode === 'xpbd' ? `α ${r.compliance === 0 ? '0' : r.compliance.toExponential(0)}` : `k ${r.k}`;
      this.labels[i].element.textContent = `${param} · +${stretch.toFixed(1)}%`;
      this.labelAnchors[i].position.copy(pts[pts.length - 1]).add(new THREE.Vector3(0, -0.15, 0));
      drawSystem(ps, debug, showParticles, showConstraints);
    });
    this.batch.commit();
  }

  applyMaterial(_m: Material): void {}

  applySolver(s: SolverSettings): void {
    this.mode = s.mode;
    this.systems.forEach((ps, i) => {
      configure(ps, s);
      ps.pbdStiffness = ROPES[i].k;
      ps.wind.set(s.wind, 0, 0);
    });
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
