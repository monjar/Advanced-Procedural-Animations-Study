import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { SecondOrderVec3, stepResponse, type Integrator, type SecondOrderParams } from '../../src/math/secondOrder';
import { criticalSpringVec3 } from '../../src/math/spring';
import { Critter, type CritterSettings } from './critter';
import { LinePlot } from '../../src/ui/plot';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '01',
  writeup,
  hint: 'Orbit: drag · Zoom: scroll · Change the input mode to drag the target yourself',
});

const app = createApp(frame.viewport, {
  rate: 60,
  cameraPosition: [0, 5.6, 10],
  cameraTarget: [0, 0.9, 0.9],
});
frame.attach(app);

// ---------------------------------------------------------------------------
// Settings

type InputMode = 'jumps' | 'orbit' | 'drag';

const settings = {
  mode: 'jumps' as InputMode,
  jumpInterval: 1.6,
  integrator: 'pole-matching' as Integrator,
  trails: true,
  links: true,
  squash: true,
  plot: 0,
};

interface Follower {
  name: string;
  color: number;
  lane: number;
  params: SecondOrderParams;
  /** Present for the exact critically damped spring follower. */
  halflife?: number;
  sys: SecondOrderVec3;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Mesh;
  trail: THREE.Vector3[];
}

const followerDefs = [
  { name: 'Smooth', color: 0x5fb3ff, params: { f: 1.2, zeta: 1, r: 0 } },
  { name: 'Bouncy', color: 0xff8a3d, params: { f: 2.2, zeta: 0.3, r: 1.5 } },
  { name: 'Anticipate', color: 0x4fd18b, params: { f: 1.8, zeta: 0.6, r: -1.6 } },
  { name: 'Exact spring', color: 0xb08cff, params: { f: 1, zeta: 1, r: 0 }, halflife: 0.3 },
];
const lanes = [-1.8, -0.6, 0.6, 1.8];

const critterSettings: CritterSettings = {
  body: { f: 1.1, zeta: 0.75, r: 0.5 },
  antenna: { f: 3.5, zeta: 0.18, r: 0 },
  tail: { f: 2.4, zeta: 0.3, r: 0 },
  lean: 0.06,
  hop: 0.22,
};
const CRITTER_LANE = 3.8;

// ---------------------------------------------------------------------------
// Scene

const target = new THREE.Group();
target.position.set(0, 1.4, 0);
{
  const mat = new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x6b4a00, roughness: 0.4 });
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 4.4, 8), mat);
  rail.rotation.x = Math.PI / 2;
  target.add(rail);
  for (const z of lanes) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 32), mat);
    ring.position.z = z;
    target.add(ring);
  }
  const handle = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), mat);
  target.add(handle);
}
app.scene.add(target);

const followers: Follower[] = followerDefs.map((d, i) => {
  const start = new THREE.Vector3(0, 1.4, lanes[i]);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 32, 20),
    new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.35 }),
  );
  mesh.castShadow = true;
  mesh.position.copy(start);
  app.scene.add(mesh);
  return {
    name: d.name,
    color: d.color,
    lane: lanes[i],
    params: { ...d.params },
    halflife: d.halflife,
    sys: new SecondOrderVec3(d.params, start),
    pos: start.clone(),
    vel: new THREE.Vector3(),
    mesh,
    trail: [],
  };
});

const critter = new Critter(app.scene, new THREE.Vector3(0, 0, CRITTER_LANE), critterSettings);

const transform = new TransformControls(app.camera, app.renderer.domElement);
transform.attach(target);
transform.showZ = false;
transform.size = 0.8;
transform.addEventListener('dragging-changed', (e) => (app.controls.enabled = !e.value));
const transformHelper = transform.getHelper();
app.scene.add(transformHelper);

// ---------------------------------------------------------------------------
// Input motion

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(7);
let nextJump = 0.6;

function updateTarget(time: number): void {
  if (settings.mode === 'jumps') {
    if (time >= nextJump) {
      nextJump = time + settings.jumpInterval;
      let x: number;
      do x = THREE.MathUtils.lerp(-2.8, 2.8, rand());
      while (Math.abs(x - target.position.x) < 1.5);
      target.position.set(x, THREE.MathUtils.lerp(0.7, 2.4, rand()), 0);
    }
  } else if (settings.mode === 'orbit') {
    const t = time * 0.7;
    target.position.set(Math.sin(t) * 3, 1.5 + Math.sin(t * 2) * 0.8, 0);
  }
}

// ---------------------------------------------------------------------------
// Simulation

const input = new THREE.Vector3();
const critterTarget = new THREE.Vector3();

app.onFixedUpdate((dt, time) => {
  updateTarget(time);

  for (const f of followers) {
    input.set(target.position.x, target.position.y, target.position.z + f.lane);
    if (f.halflife !== undefined) {
      criticalSpringVec3(f.pos, f.vel, input, f.halflife, dt);
    } else {
      f.sys.update(dt, input);
      if (!Number.isFinite(f.sys.value.x) || f.sys.value.distanceTo(input) > 60) f.sys.reset(input);
      f.pos.copy(f.sys.value);
      f.vel.copy(f.sys.velocity);
    }
  }

  critterTarget.set(target.position.x, 0, CRITTER_LANE);
  critter.update(dt, critterTarget);
});

// ---------------------------------------------------------------------------
// Rendering

const Y = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
const TRAIL = 90;

app.onFrame(() => {
  for (const f of followers) {
    f.mesh.position.copy(f.pos);

    // Volume-preserving squash and stretch along the velocity.
    const speed = f.vel.length();
    if (settings.squash && speed > 1e-3 && Number.isFinite(speed)) {
      const s = 1 + Math.min(speed * 0.04, 0.6);
      f.mesh.quaternion.setFromUnitVectors(Y, tmpDir.copy(f.vel).divideScalar(speed));
      f.mesh.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));
    } else {
      f.mesh.scale.setScalar(1);
    }

    f.trail.push(f.pos.clone());
    if (f.trail.length > TRAIL) f.trail.shift();
    if (settings.trails) app.debug.polyline(f.trail, f.color);
    if (settings.links) {
      input.set(target.position.x, target.position.y, target.position.z + f.lane);
      app.debug.line(f.pos, input, 0x555b66);
    }
  }
  critter.sync();
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------
// Step-response plot

const plotBody = frame.addPanel('Step response');
const plot = new LinePlot(plotBody, {
  yMin: -0.5,
  yMax: 2,
  yTicks: [0, 1],
  xTickStep: 1,
  formatX: (x) => `${x}s`,
});
const legend = document.createElement('div');
plotBody.appendChild(legend);

function redrawPlot(): void {
  const f = followers[settings.plot];
  const duration = 3;
  const dt = app.loop.dt;
  let actual: Float64Array;
  let reference: Float64Array;
  if (f.halflife !== undefined) {
    actual = springStep(f.halflife, dt, duration);
    reference = springStep(f.halflife, 1 / 1000, duration);
  } else {
    actual = stepResponse(f.params, dt, duration, settings.integrator);
    reference = stepResponse(f.params, 1 / 1000, duration, 'pole-matching');
  }
  plot.draw(
    [
      { values: reference, dx: 1 / 1000, color: '#8b929c', dashed: true },
      { values: actual, dx: dt, color: `#${f.color.toString(16).padStart(6, '0')}` },
    ],
    duration,
  );
  legend.textContent = `${f.name} @ ${Math.round(1 / dt)} Hz ${app.loop.mode === 'fixed' ? 'fixed' : 'max'} step${
    f.halflife === undefined ? ` · ${settings.integrator}` : ' · exact'
  } — dashed: 1 kHz reference`;
}

function springStep(halflife: number, dt: number, duration: number): Float64Array {
  const n = Math.round(duration / dt);
  const out = new Float64Array(n + 1);
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  const goal = new THREE.Vector3(1, 0, 0);
  for (let i = 1; i <= n; i++) {
    criticalSpringVec3(p, v, goal, halflife, dt);
    out[i] = p.x;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Controls

const pane = createPane(frame.controls);

const inputFolder = pane.addFolder({ title: 'Input' });
inputFolder
  .addBinding(settings, 'mode', { options: { 'random jumps': 'jumps', 'smooth orbit': 'orbit', 'drag (gizmo)': 'drag' } })
  .on('change', () => applyMode());
inputFolder.addBinding(settings, 'jumpInterval', { label: 'jump every (s)', min: 0.4, max: 4, step: 0.1 });

const sysFolder = pane.addFolder({ title: 'Integration' });
sysFolder.addBinding(settings, 'integrator', {
  options: { 'pole matching': 'pole-matching', 'clamped k2': 'clamped', 'naive euler': 'euler' },
});
const plotBinding = sysFolder.addBinding(settings, 'plot', {
  label: 'plot',
  options: Object.fromEntries(followers.map((f, i) => [f.name, i])),
});

followers.forEach((f, i) => {
  const folder = pane.addFolder({ title: f.name, expanded: i === 1 });
  if (f.halflife !== undefined) {
    folder.addBinding(f, 'halflife', { min: 0.02, max: 1.5, step: 0.01 });
  } else {
    folder.addBinding(f.params, 'f', { min: 0.1, max: 12, step: 0.05 });
    folder.addBinding(f.params, 'zeta', { label: 'ζ', min: 0, max: 2.5, step: 0.01 });
    folder.addBinding(f.params, 'r', { min: -3, max: 3, step: 0.05 });
  }
  folder.on('change', () => (settings.plot = i));
});

const critterFolder = pane.addFolder({ title: 'Critter', expanded: false });
for (const key of ['body', 'antenna', 'tail'] as const) {
  const p = critterSettings[key];
  critterFolder.addBinding(p, 'f', { label: `${key} f`, min: 0.1, max: 8, step: 0.05 });
  critterFolder.addBinding(p, 'zeta', { label: `${key} ζ`, min: 0, max: 2, step: 0.01 });
  critterFolder.addBinding(p, 'r', { label: `${key} r`, min: -3, max: 3, step: 0.05 });
}
critterFolder.addBinding(critterSettings, 'lean', { min: 0, max: 0.2, step: 0.005 });
critterFolder.addBinding(critterSettings, 'hop', { min: 0, max: 0.6, step: 0.01 });

const viewFolder = pane.addFolder({ title: 'Debug', expanded: false });
viewFolder.addBinding(settings, 'trails');
viewFolder.addBinding(settings, 'links', { label: 'input links' });
viewFolder.addBinding(settings, 'squash', { label: 'squash & stretch' });

const sim = addSimulationFolder(pane, app.loop, [15, 30, 60, 120, 240]);

function applySettings(): void {
  for (const f of followers) {
    f.sys.core.setParams(f.params);
    f.sys.core.integrator = settings.integrator;
  }
  critter.configure(critterSettings, settings.integrator);
  plotBinding.refresh();
  redrawPlot();
}

function applyMode(): void {
  const drag = settings.mode === 'drag';
  transform.enabled = drag;
  transformHelper.visible = drag;
}

pane.on('change', applySettings);
applyMode();
applySettings();
app.start();
