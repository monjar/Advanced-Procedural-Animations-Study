import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { Keyboard } from '../../src/input/keyboard';
import { SegmentBatch } from '../../src/rig/segments';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { GaitChart } from '../../src/ui/gaitChart';
import { hills, terrainGrid, terrainMesh } from '../../src/world/terrain';
import { Dog } from './dog';
import { GAITS, type GaitName } from './gait';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '06',
  writeup,
  hint: 'Manual mode: W / S faster / slower · A / D turn · Orbit: drag (free camera)',
});

const app = createApp(frame.viewport, { rate: 60, ground: false, cameraPosition: [3, 1.4, 4], cameraTarget: [0, 0.4, 0] });
frame.attach(app);

const height = hills({ seed: 2, amplitude: 0.35, scale: 10 });
app.scene.add(terrainMesh(height, 70, 210, new THREE.MeshStandardMaterial({ color: 0x30353f, roughness: 0.95 })));
app.scene.add(terrainGrid(height, 70, 1, 0x3f4552));

const settings = {
  mode: 'auto' as 'auto' | 'manual',
  camera: 'side' as 'side' | 'chase' | 'free',
  targetSpeed: 0,
  showFeet: false,
  showSupport: false,
};

const dog = new Dog(height, new THREE.Vector3(9, 0, 0));
dog.yaw = 0;

// ---------------------------------------------------------------------------
// Visuals

const fur = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
const body = new SegmentBatch(64, fur);
app.scene.add(body);
const FUR = 0xc98a4e;
const DARK = 0x6b4a2f;

const headGroup = new THREE.Group();
{
  const furMat = new THREE.MeshStandardMaterial({ color: FUR, roughness: 0.7 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.3 });
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.095, 24, 16), furMat);
  const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.13, 16), furMat);
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, -0.02, 0.1);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), darkMat);
  nose.position.set(0, -0.005, 0.17);
  headGroup.add(skull, snout, nose);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.09, 12), new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.8 }));
    ear.position.set(side * 0.055, 0.09, -0.02);
    ear.rotation.z = -side * 0.35;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), darkMat);
    eye.position.set(side * 0.042, 0.03, 0.075);
    headGroup.add(ear, eye);
  }
  headGroup.traverse((o) => (o.castShadow = true));
}
app.scene.add(headGroup);

// ---------------------------------------------------------------------------
// Control

const keys = new Keyboard();
// Auto: a speed programme that visits every gait, on a circuit around the origin.
const PROGRAM: [number, number][] = [
  [4, 0],
  [7, 0.9],
  [7, 2.5],
  [6, 4.6],
  [6, 7.2],
  [5, 2.2],
  [5, 0.9],
];
const PROGRAM_LENGTH = PROGRAM.reduce((s, [d]) => s + d, 0);
function programSpeed(t: number): number {
  let u = t % PROGRAM_LENGTH;
  for (const [d, v] of PROGRAM) {
    if (u < d) return v;
    u -= d;
  }
  return 0;
}

const RADIUS = 9;
/** Turn rate that follows a circle around the origin: tangent direction plus a pull toward the radius. */
function circleSteer(p: THREE.Vector3, yaw: number): number {
  const r = Math.max(1e-6, Math.hypot(p.x, p.z));
  const pull = THREE.MathUtils.clamp((r - RADIUS) * 0.3, -1, 1);
  const dx = -p.z / r - (p.x / r) * pull;
  const dz = p.x / r - (p.z / r) * pull;
  const err = Math.atan2(Math.sin(Math.atan2(dx, dz) - yaw), Math.cos(Math.atan2(dx, dz) - yaw));
  return THREE.MathUtils.clamp(err * 2.5, -1.5, 1.5);
}

app.onFixedUpdate((dt, time) => {
  let target: number;
  let turn: number;
  if (settings.mode === 'manual') {
    settings.targetSpeed = THREE.MathUtils.clamp(settings.targetSpeed + keys.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']) * 3 * dt, 0, 8);
    target = settings.targetSpeed;
    turn = keys.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']) * 1.6;
  } else {
    target = programSpeed(time);
    settings.targetSpeed = target;
    turn = circleSteer(dog.position, dog.yaw);
  }
  dog.update(dt, target, turn);
  chart.sample(dog.legs.map((l) => !l.swinging), dt);
});

// ---------------------------------------------------------------------------
// Rendering

const tmp = new THREE.Vector3();
const camGoal = new THREE.Vector3();
const right = new THREE.Vector3();

app.onFrame((_alpha, frameDt) => {
  body.begin();
  const spine = dog.spine;
  for (let i = 0; i < spine.length - 1; i++) {
    const t = i / (spine.length - 2);
    const r = THREE.MathUtils.lerp(0.11, 0.135, t);
    body.segment(spine[i], spine[i + 1], r, FUR);
    body.joint(spine[i], r, FUR);
  }
  body.joint(spine[spine.length - 1], 0.14, FUR);
  body.chain(dog.neck, 0.075, 0.06, FUR);
  body.chain(dog.tail.points, 0.03, 0.012, FUR);
  for (const leg of dog.legs) {
    const ik = leg.ik;
    body.segment(leg.root, ik.mid, leg.front ? 0.045 : 0.055, FUR);
    body.joint(ik.mid, 0.034, FUR);
    body.segment(ik.mid, ik.end, 0.028, FUR);
    body.joint(ik.end, 0.024, DARK);
    body.segment(leg.ankle, leg.foot, 0.02, DARK);
    body.joint(leg.foot, 0.032, DARK);
  }
  body.commit();
  headGroup.position.copy(dog.head.position);
  headGroup.quaternion.copy(dog.head.quaternion);

  const d = app.debug;
  if (settings.showFeet) {
    for (const leg of dog.legs) {
      d.point(leg.planted, leg.swinging ? 0x6b7280 : 0xffd166);
      if (leg.swinging) d.line(leg.foot, leg.planted, 0x4b5563);
    }
  }
  if (settings.showSupport) {
    const down = dog.legs.filter((l) => !l.swinging).map((l) => l.planted);
    if (down.length >= 2) d.polyline(down, 0x4fd18b, down.length > 2);
    d.line(dog.position, tmp.set(dog.position.x, height(dog.position.x, dog.position.z), dog.position.z), 0x4fd18b);
  }

  // Cameras.
  right.set(Math.cos(dog.yaw), 0, -Math.sin(dog.yaw));
  if (settings.camera !== 'free') {
    if (settings.camera === 'side') {
      camGoal.copy(dog.position).addScaledVector(right, -3.4).addScaledVector(dog.forward, 0.6);
      camGoal.y = dog.position.y + 0.9;
    } else {
      camGoal.copy(dog.position).addScaledVector(dog.forward, -3.2);
      camGoal.y = dog.position.y + 1.4;
    }
    app.camera.position.lerp(camGoal, 1 - Math.exp(-frameDt * 3));
    app.controls.target.lerp(tmp.copy(dog.position).setY(dog.position.y - 0.05), 1 - Math.exp(-frameDt * 8));
  }
  app.focusShadow(dog.position);

  readTimer -= frameDt;
  if (readTimer <= 0) {
    readTimer = 0.1;
    if (settings.mode === 'auto') speedBinding.refresh();
    const g = dog.gait;
    const parts = (Object.keys(g.weights) as GaitName[]).filter((k) => g.weights[k] > 0.01).map((k) => `${k} ${Math.round(g.weights[k] * 100)}%`);
    readout.textContent =
      `${parts.join(' · ')}\n` +
      `${dog.speed.toFixed(2)} m/s · ${g.frequency.toFixed(2)} Hz · duty ${g.duty.toFixed(2)}\n` +
      `stride ${(dog.speed / g.frequency).toFixed(2)} m`;
  }
  chart.draw();
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------
// Panels and controls

const readout = frame.addPanel('Gait');
readout.style.fontFamily = 'var(--mono)';
readout.style.whiteSpace = 'pre';
let readTimer = 0;
const chartBody = frame.addPanel('Footfalls (filled = stance)');
const chart = new GaitChart(chartBody, ['LF', 'RF', 'LH', 'RH'], 180, ['#ff8a3d', '#5fb3ff', '#ffd166', '#4fd18b']);

const pane = createPane(frame.controls);
const ctl = pane.addFolder({ title: 'Control' });
ctl.addBinding(settings, 'mode', { options: { 'auto (all gaits)': 'auto', 'manual (WASD)': 'manual' } });
const speedBinding = ctl.addBinding(settings, 'targetSpeed', { label: 'target speed', min: 0, max: 8, step: 0.1 });
ctl.addBinding(settings, 'camera', { options: { side: 'side', chase: 'chase', free: 'free' } });
ctl.addBinding(dog, 'standHeight', { label: 'stand height', min: 0.34, max: 0.5, step: 0.01 });

const table = pane.addFolder({ title: 'Gait table', expanded: false });
for (const name of Object.keys(GAITS) as GaitName[]) {
  table.addBinding(GAITS[name], 'duty', { label: `${name} duty`, min: 0.2, max: 0.8, step: 0.01 });
}

const dbg = pane.addFolder({ title: 'Debug', expanded: false });
dbg.addBinding(settings, 'showFeet', { label: 'footholds' });
dbg.addBinding(settings, 'showSupport', { label: 'support polygon' });

const sim = addSimulationFolder(pane, app.loop);
app.start();
