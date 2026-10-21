import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { Rng } from '../../src/math/random';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { GaitChart } from '../../src/ui/gaitChart';
import { hills, terrainGrid, terrainMesh } from '../../src/world/terrain';
import { Creature, type CreatureSpec } from './creature';
import { PRESETS } from './presets';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '24',
  writeup,
  hint: 'Pick or randomise a creature, reshape it with the sliders · click the ground to send it somewhere · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 60, ground: false, cameraPosition: [2.4, 1.8, 3.0], cameraTarget: [0, 0.4, 0] });
frame.attach(app);

const terrain = hills({ seed: 11, amplitude: 0.35, scale: 5, flatRadius: 2.5 });
app.scene.add(terrainMesh(terrain, 80, 240, new THREE.MeshStandardMaterial({ color: 0x3b4a3a, roughness: 0.95 })));
app.scene.add(terrainGrid(terrain, 80, 1, 0x4a5a48));

// The spec being edited; presets copy into it.
const spec: CreatureSpec = structuredClone(PRESETS[0]);
const edit = { preset: 0, pairs: spec.legs.length, legLength: spec.legs[0].length, legSegments: 3 as 2 | 3, spread: 0, legsFrom: 0.1, legsTo: 0.88, froude: 0.25 };

let creature: Creature;
let view: CreatureView;
let gaitChart: GaitChart | null = null;
const gaitBody = frame.addPanel('Footfalls (rows: legs tail → head; filled = stance)');

// ---------------------------------------------------------------------------------------- the mesh

const capsule = (r: number, len: number, mat: THREE.Material) => {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(1e-3, len), 4, 10), mat);
  m.castShadow = true;
  return m;
};
const Y = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
function place(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  m.position.lerpVectors(a, b, 0.5);
  _d.subVectors(b, a);
  if (_d.lengthSq() > 1e-12) m.quaternion.setFromUnitVectors(Y, _d.normalize());
}

class CreatureView {
  readonly group = new THREE.Group();
  private readonly spine: THREE.Mesh[] = [];
  private readonly legs: THREE.Mesh[][] = [];
  private readonly tail: THREE.Mesh[] = [];
  private readonly head: THREE.Mesh;
  private readonly neck: THREE.Mesh;
  private readonly eyes: THREE.Mesh[];

  constructor(private readonly c: Creature) {
    const s = c.spec;
    const body = new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.6 });
    const limb = new THREE.MeshStandardMaterial({ color: new THREE.Color(s.color).multiplyScalar(0.7), roughness: 0.6 });
    const seg = s.spineLength / s.spineSegments;
    for (let i = 0; i < s.spineSegments; i++) {
      const u = (i + 0.5) / s.spineSegments;
      const m = capsule(c.radiusAt(u), seg, body);
      this.spine.push(m);
      this.group.add(m);
    }
    for (const leg of c.legs) {
      const L = leg.spec.length;
      const r = Math.max(0.012, 0.05 * L);
      const parts = leg.spec.segments === 3 ? [L * 0.42, L * 0.4, L * 0.18] : [L * 0.5, L * 0.5];
      const ms = parts.map((len, k) => capsule(r * (1 - 0.25 * k), len, limb));
      ms.forEach((m) => this.group.add(m));
      this.legs.push(ms);
    }
    if (c.tail) {
      const n = c.tail.points.length - 1;
      for (let i = 0; i < n; i++) {
        const m = capsule(c.radiusAt(0) * (1 - (0.85 * i) / n), s.tailLength / n, body);
        this.tail.push(m);
        this.group.add(m);
      }
    }
    this.neck = capsule(Math.max(0.02, s.headSize * 0.4), Math.max(0.01, s.neck), body);
    this.head = new THREE.Mesh(new THREE.SphereGeometry(s.headSize, 24, 16), body);
    this.head.castShadow = true;
    this.group.add(this.neck, this.head);
    const white = new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.3 });
    const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 });
    this.eyes = [-1, 1].flatMap(() => {
      const w = new THREE.Mesh(new THREE.SphereGeometry(s.headSize * 0.32, 12, 10), white);
      const p = new THREE.Mesh(new THREE.SphereGeometry(s.headSize * 0.17, 10, 8), black);
      this.group.add(w, p);
      return [w, p];
    });
  }

  update(): void {
    const c = this.c;
    for (let i = 0; i < this.spine.length; i++) place(this.spine[i], c.spine[i], c.spine[i + 1]);
    c.legs.forEach((leg, k) => {
      const ms = this.legs[k];
      place(ms[0], leg.hip, leg.knee);
      place(ms[1], leg.knee, leg.ankle);
      if (ms[2]) place(ms[2], leg.ankle, leg.foot);
    });
    if (c.tail) this.tail.forEach((m, i) => place(m, c.tail!.points[i], c.tail!.points[i + 1]));
    const tip = c.spine[c.spine.length - 1];
    place(this.neck, tip, c.headPos);
    this.head.position.copy(c.headPos);
    const d = c.headDir;
    const side = new THREE.Vector3(-d.z, 0, d.x).normalize();
    const r = c.spec.headSize;
    for (let e = 0; e < 2; e++) {
      const sgn = e === 0 ? -1 : 1;
      const w = this.eyes[e * 2];
      const p = this.eyes[e * 2 + 1];
      w.position.copy(c.headPos).addScaledVector(d, r * 0.72).addScaledVector(side, sgn * r * 0.45).add(new THREE.Vector3(0, r * 0.35, 0));
      p.position.copy(w.position).addScaledVector(d, r * 0.2);
    }
  }
}

function rebuild(keepPlace = true): void {
  const start = keepPlace && creature ? creature.spine[creature.spine.length - 1].clone().setY(0) : new THREE.Vector3(0, 0, 0);
  const heading = keepPlace && creature ? creature.heading : 0;
  if (view) app.scene.remove(view.group);
  creature = new Creature(structuredClone(spec), terrain, start);
  creature.heading = heading;
  creature.froude = edit.froude;
  view = new CreatureView(creature);
  app.scene.add(view.group);
  gaitChart?.canvas.remove();
  gaitChart = new GaitChart(
    gaitBody,
    creature.legs.map((l) => `${l.side < 0 ? 'L' : 'R'}${l.pair + 1}`),
    240,
    creature.legs.map((l) => (l.side < 0 ? '#ff8a3d' : '#5fb3ff')),
  );
}

/** Lay the leg pairs out evenly between legsFrom and legsTo. */
function applyLegs(): void {
  const n = edit.pairs;
  spec.legs = Array.from({ length: n }, (_, i) => ({
    at: n === 1 ? edit.legsFrom : edit.legsFrom + ((edit.legsTo - edit.legsFrom) * i) / (n - 1),
    length: edit.legLength,
    segments: edit.legSegments,
    spread: edit.spread,
  }));
}

function loadPreset(i: number): void {
  Object.assign(spec, structuredClone(PRESETS[i]));
  edit.pairs = spec.legs.length;
  edit.legLength = spec.legs[0]?.length ?? 0.5;
  edit.legSegments = spec.legs[0]?.segments ?? 2;
  edit.spread = spec.legs[0]?.spread ?? 0;
  edit.legsFrom = spec.legs[0]?.at ?? 0.1;
  edit.legsTo = spec.legs[spec.legs.length - 1]?.at ?? 0.9;
  pane.refresh();
  rebuild();
}

const rng = new Rng(Date.now() % 100000);
function randomise(): void {
  const pairsN = rng.pick([1, 2, 2, 3, 4, 5, 6]);
  spec.name = 'random';
  spec.spineLength = rng.range(0.3, 0.4 + pairsN * 0.2);
  spec.spineSegments = Math.max(3, Math.round(spec.spineLength * 9));
  spec.radius = [rng.range(0.05, 0.18), rng.range(0.06, 0.18), rng.range(0.05, 0.15)];
  spec.headSize = rng.range(0.05, 0.16);
  spec.neck = rng.range(0.02, pairsN <= 2 ? 0.6 : 0.1);
  spec.tailLength = rng.chance(0.6) ? rng.range(0.1, 0.8) : 0;
  spec.upright = pairsN === 1;
  spec.color = new THREE.Color().setHSL(rng.next(), rng.range(0.4, 0.75), rng.range(0.4, 0.6)).getHex();
  edit.pairs = pairsN;
  edit.legLength = rng.range(0.2, pairsN <= 2 ? 1.1 : 0.7);
  edit.legSegments = rng.chance(0.5) ? 3 : 2;
  edit.spread = pairsN >= 3 ? rng.range(0.2, 0.6) : rng.range(0, 0.15);
  edit.legsFrom = pairsN === 1 ? rng.range(0.05, 0.3) : rng.range(0.05, 0.4);
  edit.legsTo = rng.range(Math.max(edit.legsFrom + 0.2, 0.6), 0.95);
  applyLegs();
  pane.refresh();
  rebuild();
}

// ---------------------------------------------------------------------------------------- steering & loop

let target: THREE.Vector3 | null = null;
const marker = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.17, 32), new THREE.MeshBasicMaterial({ color: 0xffd166, side: THREE.DoubleSide }));
marker.rotation.x = -Math.PI / 2;
marker.visible = false;
app.scene.add(marker);
let wander = 0;
let wanderGoal: THREE.Vector3 | null = null;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt = { x: 0, y: 0 };
app.renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
app.renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const r = app.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, app.camera);
  // March the ray to the terrain.
  const ray = raycaster.ray;
  for (let s = 0; s < 80; s += 0.05) {
    const p = ray.at(s, new THREE.Vector3());
    if (p.y <= terrain(p.x, p.z)) {
      target = p;
      marker.position.set(p.x, terrain(p.x, p.z) + 0.02, p.z);
      marker.visible = true;
      break;
    }
  }
});

app.onFixedUpdate((dt) => {
  creature.froude = edit.froude;
  const head = creature.spine[creature.spine.length - 1];
  if (target && Math.hypot(target.x - head.x, target.z - head.z) < 0.4) {
    target = null;
    marker.visible = false;
  }
  // Without a target it wanders: a new goal a few metres away every few seconds.
  wander -= dt;
  if (wander <= 0 || !wanderGoal) {
    wander = 6 + rng.range(0, 4);
    const a = creature.heading + rng.range(-1, 1);
    const d = 3 + 4 * creature.spec.spineLength;
    wanderGoal = new THREE.Vector3(head.x + Math.cos(a) * d, 0, head.z + Math.sin(a) * d);
  }
  const ahead = target ?? wanderGoal;
  creature.update(dt, ahead);
  gaitChart?.sample(
    creature.legs.map((l) => l.stance),
    dt,
  );
});

const follow = createFollow(app, 0.5);
const centre = new THREE.Vector3();
app.onFrame((_a, frameDt) => {
  view.update();
  creature.spineAt(0.5, centre);
  follow.update(centre, frameDt);
  app.focusShadow(centre);
  const s = creature.stats;
  const gait = spec.legs.length === 1 ? 'biped alternation' : spec.legs.length === 2 ? (edit.froude < 0.35 ? 'walk' : edit.froude > 0.7 ? 'trot' : 'walk → trot') : spec.legs.length === 3 ? 'tripod' : 'metachronal wave';
  readout.gait = `${gait} · duty ${creature.duty.toFixed(2)}`;
  readout.stride = `${creature.stride.toFixed(2)} m at ${creature.frequency.toFixed(2)} Hz → ${creature.speed.toFixed(2)} m/s`;
  readout.stable = s.sampledTime > 0 ? `${((100 * s.stableTime) / s.sampledTime).toFixed(0)}% of the time` : '';
  readout.reach = s.stanceTime > 0 ? `${((100 * s.reachMissTime) / s.stanceTime).toFixed(1)}% of stance` : '';
  gaitChart?.draw();
  simHooks.end();
  simHooks.begin();
});

// ---------------------------------------------------------------------------------------- controls

const readout = { gait: '', stride: '', stable: '', reach: '' };
const pane = createPane(frame.controls);
pane.addBinding(edit, 'preset', { options: Object.fromEntries(PRESETS.map((p, i) => [p.name, i])) }).on('change', (ev) => loadPreset(ev.value));
pane.addButton({ title: 'Randomise a creature' }).on('click', randomise);
pane.addBinding(edit, 'froude', { min: 0.05, max: 1, step: 0.01, label: 'speed (Froude)' });
const body = pane.addFolder({ title: 'Body', expanded: false });
body.addBinding(spec, 'spineLength', { min: 0.2, max: 2.5, step: 0.05, label: 'length' }).on('change', () => rebuild());
body.addBinding(spec, 'spineSegments', { min: 2, max: 24, step: 1, label: 'segments' }).on('change', () => rebuild());
body.addBinding(spec.radius, '0', { min: 0.03, max: 0.25, step: 0.01, label: 'girth (tail end)' }).on('change', () => rebuild());
body.addBinding(spec.radius, '1', { min: 0.03, max: 0.25, step: 0.01, label: 'girth (middle)' }).on('change', () => rebuild());
body.addBinding(spec.radius, '2', { min: 0.03, max: 0.25, step: 0.01, label: 'girth (head end)' }).on('change', () => rebuild());
body.addBinding(spec, 'headSize', { min: 0.03, max: 0.25, step: 0.01, label: 'head' }).on('change', () => rebuild());
body.addBinding(spec, 'neck', { min: 0, max: 1, step: 0.02 }).on('change', () => rebuild());
body.addBinding(spec, 'tailLength', { min: 0, max: 1.2, step: 0.05, label: 'tail' }).on('change', () => rebuild());
const legs = pane.addFolder({ title: 'Legs', expanded: false });
const legChange = () => {
  applyLegs();
  rebuild();
};
legs.addBinding(edit, 'pairs', { min: 0, max: 12, step: 1, label: 'pairs' }).on('change', legChange);
legs.addBinding(edit, 'legLength', { min: 0.1, max: 1.5, step: 0.02, label: 'length' }).on('change', legChange);
legs.addBinding(edit, 'legSegments', { options: { 'two (plantigrade)': 2, 'three (digitigrade)': 3 }, label: 'segments' }).on('change', legChange);
legs.addBinding(edit, 'spread', { min: 0, max: 0.8, step: 0.02 }).on('change', legChange);
legs.addBinding(edit, 'legsFrom', { min: 0, max: 1, step: 0.01, label: 'first pair at' }).on('change', legChange);
legs.addBinding(edit, 'legsTo', { min: 0, max: 1, step: 0.01, label: 'last pair at' }).on('change', legChange);
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'gait', { readonly: true });
info.addBinding(readout, 'stride', { readonly: true });
info.addBinding(readout, 'stable', { readonly: true, label: 'statically stable' });
info.addBinding(readout, 'reach', { readonly: true, label: 'feet out of reach' });
const simHooks = addSimulationFolder(pane, app.loop);

rebuild(false);
app.start();
