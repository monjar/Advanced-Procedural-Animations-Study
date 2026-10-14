import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { Keyboard } from '../../src/input/keyboard';
import { SegmentBatch } from '../../src/rig/segments';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { GaitChart } from '../../src/ui/gaitChart';
import { hills, terrainGrid, terrainMesh } from '../../src/world/terrain';
import { Biped } from './biped';
import { StrideWheel } from './wheel';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '07',
  writeup,
  hint: 'Manual mode: W walk · Shift+W run · A / D turn · Orbit: drag (free camera)',
});

const app = createApp(frame.viewport, { rate: 60, ground: false, cameraPosition: [3, 1.6, 4], cameraTarget: [0, 0.9, 0] });
frame.attach(app);

const height = hills({ seed: 4, amplitude: 0.4, scale: 9 });
app.scene.add(terrainMesh(height, 70, 210, new THREE.MeshStandardMaterial({ color: 0x30353f, roughness: 0.95 })));
app.scene.add(terrainGrid(height, 70, 1, 0x3f4552));

const settings = {
  mode: 'auto' as 'auto' | 'manual',
  camera: 'side' as 'side' | 'chase' | 'free',
  targetSpeed: 0,
  showFeet: false,
  showReach: false,
};

const RADIUS = 8;
const biped = new Biped(height, new THREE.Vector3(RADIUS, 0, 0));

// ---------------------------------------------------------------------------
// Visuals

const BODY = 0xd5d9e0;
const JOINT = 0x3a3f4a;
const RIGHT = 0x5fb3ff;
const LEFT = 0xff8a3d;
const batch = new SegmentBatch(64, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.05 }));
app.scene.add(batch);

const headGroup = new THREE.Group();
{
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 18), new THREE.MeshStandardMaterial({ color: BODY, roughness: 0.45 }));
  skull.scale.set(0.95, 1.1, 1);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.25 }));
  visor.position.set(0, 0.02, 0.085);
  headGroup.add(skull, visor);
  headGroup.traverse((o) => (o.castShadow = true));
}
app.scene.add(headGroup);

// ---------------------------------------------------------------------------
// Control

const keys = new Keyboard();
const PROGRAM: [number, number][] = [
  [3, 0],
  [7, 1.3],
  [6, 3.6],
  [4, 1.0],
  [3, 0],
  [6, 4.8],
  [5, 1.6],
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
    const fwd = keys.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    const runKey = keys.isDown('ShiftLeft') || keys.isDown('ShiftRight');
    target = fwd > 0 ? (runKey ? 4 : 1.4) : 0;
    turn = keys.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']) * 1.8;
  } else {
    target = programSpeed(time);
    // Standing still in auto: hold the heading rather than steering in place.
    turn = biped.speed > 0.2 ? circleSteer(biped.position, biped.yaw) : 0;
  }
  settings.targetSpeed = target;
  biped.update(dt, target, turn);
  chart.push(biped.feet.map((f) => !f.swinging));
});

// ---------------------------------------------------------------------------
// Rendering

const tmp = new THREE.Vector3();
const camGoal = new THREE.Vector3();

app.onFrame((_alpha, frameDt) => {
  batch.begin();
  // Legs.
  biped.feet.forEach((f) => {
    const c = f.side > 0 ? LEFT : RIGHT;
    batch.segment(f.hip, f.ik.mid, 0.062, BODY);
    batch.joint(f.hip, 0.07, JOINT);
    batch.joint(f.ik.mid, 0.052, JOINT);
    batch.segment(f.ik.mid, f.ik.end, 0.048, BODY);
    batch.joint(f.ankle, 0.04, JOINT);
    batch.segment(f.heel, f.toe, 0.035, c);
    batch.segment(f.ankle, tmp.copy(f.heel).lerp(f.toe, 0.35), 0.036, c);
  });
  // Pelvis, spine, shoulders.
  batch.segment(biped.feet[0].hip, biped.feet[1].hip, 0.085, BODY);
  for (let i = 0; i < biped.spine.length - 1; i++) {
    const r = THREE.MathUtils.lerp(0.09, 0.115, i / (biped.spine.length - 2));
    batch.segment(biped.spine[i], biped.spine[i + 1], r, BODY);
    batch.joint(biped.spine[i + 1], r, BODY);
  }
  batch.segment(biped.arms[0].shoulder, biped.arms[1].shoulder, 0.075, BODY);
  batch.segment(biped.chest, biped.neck, 0.045, JOINT);
  // Arms.
  biped.arms.forEach((a) => {
    batch.joint(a.shoulder, 0.06, JOINT);
    batch.segment(a.shoulder, a.elbow, 0.042, BODY);
    batch.joint(a.elbow, 0.038, JOINT);
    batch.segment(a.elbow, a.hand, 0.034, BODY);
    batch.joint(a.hand, 0.045, BODY);
  });
  batch.commit();
  headGroup.position.copy(biped.head);
  headGroup.quaternion.copy(biped.headQuat);

  const d = app.debug;
  if (settings.showFeet) {
    for (const f of biped.feet) {
      d.point(f.planted, f.swinging ? 0x6b7280 : 0xffd166);
      if (f.swinging) d.line(f.ground, f.planted, 0x4b5563);
    }
  }
  if (settings.showReach) {
    for (const f of biped.feet) d.line(f.hip, f.ankle, f.ik.error > 1e-3 ? 0xff4d4d : 0x4fd18b);
  }

  if (settings.camera !== 'free') {
    if (settings.camera === 'side') {
      camGoal.copy(biped.position).addScaledVector(biped.left, 3.6).addScaledVector(biped.forward, 0.8);
      camGoal.y = biped.position.y + 1.3;
    } else {
      camGoal.copy(biped.position).addScaledVector(biped.forward, -3.6);
      camGoal.y = biped.position.y + 1.8;
    }
    app.camera.position.lerp(camGoal, 1 - Math.exp(-frameDt * 3));
    app.controls.target.lerp(tmp.copy(biped.position).setY(biped.position.y + 0.85), 1 - Math.exp(-frameDt * 8));
  }
  app.focusShadow(biped.position);

  readTimer -= frameDt;
  if (readTimer <= 0) {
    readTimer = 0.1;
    if (settings.mode === 'auto') speedBinding.refresh();
    const run = Math.round(biped.wRun * 100);
    const gait = biped.wIdle > 0.95 ? 'standing' : run === 0 ? 'walk' : run === 100 ? 'run' : `walk ${100 - run}% · run ${run}%`;
    const cadence = biped.speed > 0.05 ? ((2 * biped.speed) / biped.strideLength) * 60 : 0;
    readout.textContent =
      `${gait}\n${biped.speed.toFixed(2)} m/s · ${cadence.toFixed(0)} steps/min\n` +
      `stride ${biped.strideLength.toFixed(2)} m · duty ${biped.duty.toFixed(2)}\n` +
      `pelvis reach drop ${(biped.reachDrop * 100).toFixed(1)} cm`;
  }
  wheel.draw(biped.phase, biped.duty, biped.wRun, [biped.feet[0].swinging, biped.feet[1].swinging]);
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
const chart = new GaitChart(chartBody, ['R', 'L'], 180, ['#5fb3ff', '#ff8a3d']);
const wheel = new StrideWheel(frame.addPanel('Stride wheel'));

const pane = createPane(frame.controls);
const ctl = pane.addFolder({ title: 'Control' });
ctl.addBinding(settings, 'mode', { options: { 'auto programme': 'auto', 'manual (WASD)': 'manual' } });
const speedBinding = ctl.addBinding(settings, 'targetSpeed', { label: 'target speed', readonly: true });
ctl.addBinding(settings, 'camera', { options: { side: 'side', chase: 'chase', free: 'free' } });

const dbg = pane.addFolder({ title: 'Debug', expanded: false });
dbg.addBinding(settings, 'showFeet', { label: 'footholds' });
dbg.addBinding(settings, 'showReach', { label: 'hip → ankle' });

const sim = addSimulationFolder(pane, app.loop);
app.start();
