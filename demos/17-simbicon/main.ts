import * as THREE from 'three';
import loadMujoco from '@mujoco/mujoco';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { Keyboard } from '../../src/input/keyboard';
import { MujocoView, mjToThree } from '../../src/physics/mujocoView';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { GaitChart } from '../../src/ui/gaitChart';
import { LinePlot } from '../../src/ui/plot';
import { GAITS, Simbicon } from './simbicon';
import xml from './biped.xml?raw';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '17',
  writeup,
  hint: 'A / D steer · click the ground to send it somewhere · drag it to pull · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 120, cameraPosition: [3.2, 1.8, 3.4], cameraTarget: [0, 0.9, 0] });
frame.attach(app);

const mj = await loadMujoco();
const ctl = new Simbicon(mj, xml);

// ---------------------------------------------------------------------------------------- rendering

const skin = new THREE.MeshStandardMaterial({ color: 0xd5d9e0, roughness: 0.45 });
const left = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.5 });
const right = new THREE.MeshStandardMaterial({ color: 0x5fb3ff, roughness: 0.5 });
const bodyOf = ctl.model.geom_bodyid as Int32Array;
const leftBodies = new Set(['L_thigh', 'L_shin', 'L_foot'].map((n) => mj.mj_name2id(ctl.model, mj.mjtObj.mjOBJ_BODY.value, n)));
const rightBodies = new Set(['R_thigh', 'R_shin', 'R_foot'].map((n) => mj.mj_name2id(ctl.model, mj.mjtObj.mjOBJ_BODY.value, n)));
const view = new MujocoView(ctl.model, ctl.data, (g) => (leftBodies.has(bodyOf[g]) ? left : rightBodies.has(bodyOf[g]) ? right : skin));
app.scene.add(view.group);

// ---------------------------------------------------------------------------------------- control

const settings = { gait: 'walk', pushStrength: 0.4, showBalance: true, slowMotion: false };
const keys = new Keyboard();
let walkTarget: THREE.Vector3 | null = null;
let fallenFor = 0;
let falls = 0;
let accumulator = 0;
let dragging = false;
const dragPoint = new THREE.Vector3();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const targetMarker = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.22, 32), new THREE.MeshBasicMaterial({ color: 0xffd166, side: THREE.DoubleSide }));
targetMarker.rotation.x = -Math.PI / 2;
targetMarker.visible = false;
app.scene.add(targetMarker);

function setNdc(e: PointerEvent): void {
  const r = app.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, app.camera);
}
let downAt = { x: 0, y: 0 };
app.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  downAt = { x: e.clientX, y: e.clientY };
  setNdc(e);
  const hit = raycaster.intersectObjects(view.meshes.map((m) => m.mesh), false)[0];
  if (hit) {
    dragging = true;
    app.controls.enabled = false;
    dragPlane.constant = -hit.point.y;
    dragPoint.copy(hit.point);
  }
});
app.renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  setNdc(e);
  raycaster.ray.intersectPlane(dragPlane, dragPoint);
});
window.addEventListener('pointerup', (e) => {
  if (dragging) {
    dragging = false;
    app.controls.enabled = true;
    ctl.data.xfrc_applied.fill(0);
    return;
  }
  // A click (not a drag) on the ground: walk there.
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5 && e.target === app.renderer.domElement) {
    setNdc(e as PointerEvent);
    const p = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(ground, p)) {
      walkTarget = p;
      targetMarker.position.set(p.x, 0.01, p.z);
      targetMarker.visible = true;
    }
  }
});

const torsoWorld = new THREE.Vector3();
function steer(): void {
  const q = ctl.data.qpos as Float64Array;
  const turn = keys.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
  if (turn !== 0) {
    walkTarget = null;
    targetMarker.visible = false;
    ctl.targetHeading = ctl.state.heading + turn * 0.8;
  } else if (walkTarget) {
    // Three (x, −z) is MuJoCo (x, y).
    const dx = walkTarget.x - q[0];
    const dy = -walkTarget.z - q[1];
    ctl.targetHeading = Math.atan2(dy, dx);
    if (Math.hypot(dx, dy) < 0.6) {
      walkTarget = null;
      targetMarker.visible = false;
    }
  }
}

function physicsStep(): void {
  if (dragging) {
    const p = ctl.data.xpos as Float64Array;
    const v = ctl.data.qvel as Float64Array;
    const tx = dragPoint.x;
    const ty = -dragPoint.z;
    const tz = dragPoint.y;
    let fx = 600 * (tx - p[3]) - 80 * v[0];
    let fy = 600 * (ty - p[4]) - 80 * v[1];
    let fz = 600 * (tz - p[5]) - 80 * v[2];
    const m = Math.hypot(fx, fy, fz);
    if (m > 500) (fx *= 500 / m), (fy *= 500 / m), (fz *= 500 / m);
    const f = ctl.data.xfrc_applied as Float64Array;
    f[6] = fx; // body 1 = torso
    f[7] = fy;
    f[8] = fz;
  }
  ctl.step();
}

const D_N = 300;
const dTrace = new Float32Array(D_N);
const vTrace = new Float32Array(D_N);
const hipTrace = new Float32Array(D_N);
let traceHead = 0;
let traceTimer = 0;

app.onFixedUpdate((dt) => {
  steer();
  const scaled = settings.slowMotion ? dt * 0.25 : dt;
  accumulator += scaled;
  let n = 0;
  view.snapshot();
  while (accumulator >= ctl.dt && n < 400) {
    physicsStep();
    accumulator -= ctl.dt;
    n++;
  }
  // Fallen: stand it back up where it lies, facing the same way.
  if (ctl.fallen) {
    fallenFor += scaled;
    if (fallenFor > 1.5) {
      const q = ctl.data.qpos as Float64Array;
      const [x, y, h] = [q[0], q[1], ctl.state.heading];
      ctl.reset();
      q[0] = x;
      q[1] = y;
      q[3] = Math.cos(h / 2);
      q[6] = Math.sin(h / 2);
      mj.mj_forward(ctl.model, ctl.data);
      ctl.targetHeading = ctl.steerHeading = h;
      fallenFor = 0;
      falls++;
      view.snapshot();
    }
  } else fallenFor = 0;
  gait.sample([ctl.state.stance === 0, ctl.state.stance === 1], scaled);
  traceTimer += scaled;
  while (traceTimer > 1 / 50) {
    traceTimer -= 1 / 50;
    dTrace[traceHead] = ctl.state.d;
    vTrace[traceHead] = ctl.state.v;
    const g = ctl.active;
    hipTrace[traceHead] = g.swingHip + g.cd * ctl.state.d + g.cv * ctl.state.v;
    traceHead = (traceHead + 1) % D_N;
  }
});

// ---------------------------------------------------------------------------------------- panels

const balancePlot = new LinePlot(frame.addPanel('Balance feedback: d (m), v (m/s), swing hip target (rad)'), {
  height: 110,
  yMin: -0.4,
  yMax: 1.4,
  yTicks: [0, 0.5, 1],
  xTickStep: 2,
  formatX: (x) => `${x - 6}s`,
});
const gaitBody = frame.addPanel('Footfalls (filled = stance)');
const gait = new GaitChart(gaitBody, ['left', 'right'], 240, ['#ff8a3d', '#5fb3ff']);
const ordered = (a: Float32Array) => Float32Array.from({ length: D_N }, (_, i) => a[(traceHead + i) % D_N]);

const follow = createFollow(app, 0.4);
const com = new THREE.Vector3();
const foot = new THREE.Vector3();
app.onFrame((_a, frameDt) => {
  view.update(Math.min(1, accumulator / ctl.dt));
  const p = ctl.data.xpos as Float64Array;
  mjToThree(p[3], p[4], p[5], torsoWorld);
  follow.update(torsoWorld, frameDt);
  app.focusShadow(torsoWorld);
  if (settings.showBalance) {
    const c = ctl.state.com;
    mjToThree(c[0], c[1], c[2], com);
    const fb = (['L_foot', 'R_foot'] as const)[ctl.state.stance];
    const fi = mj.mj_name2id(ctl.model, mj.mjtObj.mjOBJ_BODY.value, fb) * 3;
    mjToThree(p[fi], p[fi + 1], 0.01, foot);
    app.debug.point(com, 0xffd166);
    app.debug.line(com, new THREE.Vector3(com.x, 0.01, com.z), 0xffd166);
    app.debug.line(foot, new THREE.Vector3(com.x, 0.01, com.z), 0x4fd18b);
    app.debug.point(foot, ctl.state.stance === 0 ? 0xff8a3d : 0x5fb3ff);
  }
  if (dragging) app.debug.line(torsoWorld, dragPoint, 0xffd166);
  balancePlot.draw(
    [
      { values: ordered(dTrace), dx: 6 / D_N, color: '#4fd18b' },
      { values: ordered(vTrace), dx: 6 / D_N, color: '#5fb3ff' },
      { values: ordered(hipTrace), dx: 6 / D_N, color: '#ff8a3d' },
    ],
    6,
  );
  gait.draw();
  readout.speed = Math.hypot(ctl.state.comVel[0], ctl.state.comVel[1]);
  readout.steps = ctl.state.steps;
  readout.falls = falls;
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
const gf = pane.addFolder({ title: 'Gait' });
gf.addBinding(settings, 'gait', { options: Object.fromEntries(Object.entries(GAITS).map(([k, g]) => [g.name, k])) }).on('change', (ev) => {
  ctl.gait = { ...GAITS[ev.value] };
});
const push = pane.addFolder({ title: 'Push' });
push.addBinding(settings, 'pushStrength', { label: 'strength (m/s)', min: 0.1, max: 1.2, step: 0.05 });
const shove = (angle: number) => {
  const h = ctl.state.heading + angle;
  ctl.push(Math.cos(h) * settings.pushStrength, Math.sin(h) * settings.pushStrength);
};
push.addButton({ title: 'Push from the left' }).on('click', () => shove(-Math.PI / 2));
push.addButton({ title: 'Push from the right' }).on('click', () => shove(Math.PI / 2));
push.addButton({ title: 'Push from behind' }).on('click', () => shove(0));
push.addButton({ title: 'Push from the front' }).on('click', () => shove(Math.PI));
const view_ = pane.addFolder({ title: 'View' });
view_.addBinding(settings, 'showBalance', { label: 'balance overlay' });
view_.addBinding(settings, 'slowMotion', { label: 'slow motion ×¼' });
const readout = { speed: 0, steps: 0, falls: 0 };
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'speed', { readonly: true, format: (v: number) => `${v.toFixed(2)} m/s` });
info.addBinding(readout, 'steps', { readonly: true, format: (v: number) => v.toFixed(0) });
info.addBinding(readout, 'falls', { readonly: true, format: (v: number) => v.toFixed(0) });
pane.addButton({ title: 'Reset' }).on('click', () => {
  ctl.reset();
  view.snapshot();
});
const sim = addSimulationFolder(pane, app.loop);
app.start();
