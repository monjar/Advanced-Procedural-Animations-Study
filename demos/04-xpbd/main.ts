import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { BridgeScene } from './bridge';
import { CapeScene } from './cape';
import { LabScene } from './lab';
import type { Material, SolverSettings, XpbdScene } from './types';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '04',
  writeup,
  hint: 'Drag the cloth or ropes with the mouse · Orbit: drag empty space · Zoom: scroll',
});

const app = createApp(frame.viewport, { rate: 60, cameraPosition: [0, 2.6, 7], cameraTarget: [0, 1.1, 0] });
frame.attach(app);

type SceneId = 'cape' | 'bridge' | 'lab';

const settings = {
  scene: 'cape' as SceneId,
  follow: true,
  walkSpeed: 2.2,
  sway: true,
  showParticles: false,
  showConstraints: false,
};

const solver: SolverSettings = {
  mode: 'xpbd',
  substeps: 10,
  iterations: 1,
  pbdStiffness: 1,
  damping: 0.3,
  friction: 0.4,
  wind: 0,
};

const MATERIALS: Record<Exclude<SceneId, 'lab'>, Material> = {
  cape: { stretch: -7, shear: -5, bend: -2.5 },
  bridge: { stretch: -6, shear: -4, bend: -1 },
};
const material: Material = { ...MATERIALS.cape };

const CAMERAS: Record<SceneId, { pos: THREE.Vector3Tuple; target: THREE.Vector3Tuple }> = {
  cape: { pos: [3.5, 2.6, 5.5], target: [0, 1.0, 0] },
  bridge: { pos: [2.5, 3.2, 6.5], target: [0, 1.1, 0] },
  lab: { pos: [0, 1.9, 4.8], target: [0, 1.5, 0] },
};

// ---------------------------------------------------------------------------
// Scene management

let scene: XpbdScene;
const follow = createFollow(app, 0.12);
const focusPoint = new THREE.Vector3();

const transform = new TransformControls(app.camera, app.renderer.domElement);
transform.size = 0.7;
transform.addEventListener('dragging-changed', (e) => {
  app.controls.enabled = !e.value;
  if (e.value) scene.onHandleDrag?.();
});
const transformHelper = transform.getHelper();
app.scene.add(transformHelper);

function load(id: SceneId): void {
  if (scene) {
    transform.detach();
    app.scene.remove(scene.root);
    scene.dispose();
  }
  if (id === 'cape') {
    const cape = new CapeScene();
    cape.walk.speed = settings.walkSpeed;
    scene = cape;
  } else if (id === 'bridge') {
    scene = new BridgeScene();
  } else {
    const lab = new LabScene((text, parent) => app.label(text, parent));
    lab.sway.enabled = settings.sway;
    scene = lab;
  }
  app.scene.add(scene.root);
  if (scene.handle) transform.attach(scene.handle);
  transformHelper.visible = !!scene.handle;
  if (id !== 'lab') Object.assign(material, MATERIALS[id]);
  scene.applyMaterial(material);
  scene.applySolver(solver);
  const cam = CAMERAS[id];
  app.camera.position.set(...cam.pos);
  app.controls.target.set(...cam.target);
  app.focusShadow(new THREE.Vector3(0, 0, 0));
  refreshVisibility();
  pane?.refresh();
}

// ---------------------------------------------------------------------------
// Mouse grab: pin the nearest particle under the cursor to a camera-facing drag plane.

const grab = {
  ps: null as XpbdScene['systems'][number] | null,
  index: -1,
  plane: new THREE.Plane(),
  point: new THREE.Vector3(),
};
{
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const canvas = app.renderer.domElement;
  const toNdc = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, app.camera);
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (transform.dragging || (transform.axis !== null && transformHelper.visible)) return;
    toNdc(e);
    let best = { ps: null as typeof grab.ps, index: -1, d: Infinity };
    for (const ps of scene.systems) {
      const i = ps.pick(raycaster.ray, 0.12);
      if (i < 0 || ps.isPinned(i)) continue;
      const d = ps.get(i).distanceTo(raycaster.ray.origin);
      if (d < best.d) best = { ps, index: i, d };
    }
    if (!best.ps) return;
    grab.ps = best.ps;
    grab.index = best.index;
    const p = best.ps.get(best.index);
    grab.plane.setFromNormalAndCoplanarPoint(app.camera.getWorldDirection(new THREE.Vector3()).negate(), p);
    grab.point.copy(p);
    best.ps.pin(best.index, p);
    app.controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!grab.ps) return;
    toNdc(e);
    raycaster.ray.intersectPlane(grab.plane, grab.point);
  });
  const release = () => {
    if (!grab.ps) return;
    grab.ps.unpin(grab.index);
    grab.ps = null;
    app.controls.enabled = true;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

// ---------------------------------------------------------------------------
// Loop

let stepMs = 0;

app.onFixedUpdate((dt, time) => {
  if (grab.ps) grab.ps.pin(grab.index, grab.point);
  const t0 = performance.now();
  scene.update(dt, time);
  stepMs = stepMs * 0.95 + (performance.now() - t0) * 0.05;
});

const stats = frame.addPanel('Solver');
stats.style.fontFamily = 'var(--mono)';
stats.style.whiteSpace = 'pre';
let statsTimer = 0;

app.onFrame((_alpha, frameDt) => {
  scene.render(app.debug, settings.showParticles, settings.showConstraints);
  if (scene instanceof CapeScene) {
    follow.enabled = settings.follow;
    follow.update(focusPoint.copy(scene.focus).setY(1.0), frameDt);
    app.focusShadow(scene.focus);
  }
  if (grab.ps) app.debug.point(grab.point, 0xff4d4d);

  statsTimer -= frameDt;
  if (statsTimer <= 0) {
    statsTimer = 0.25;
    const particles = scene.systems.reduce((s, p) => s + p.count, 0);
    const constraints = scene.systems.reduce((s, p) => s + p.nConstraints, 0);
    const solves = constraints * solver.substeps * solver.iterations;
    stats.textContent =
      `${particles} particles · ${constraints} constraints\n` +
      `${solves.toLocaleString()} solves/step · ${stepMs.toFixed(2)} ms/step`;
  }
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------
// Controls

const pane = createPane(frame.controls);

const sceneFolder = pane.addFolder({ title: 'Scene' });
sceneFolder
  .addBinding(settings, 'scene', { options: { 'cape on a walker': 'cape', 'rope bridge': 'bridge', 'stiffness lab': 'lab' } })
  .on('change', (e) => load(e.value));
const walkBinding = sceneFolder.addBinding(settings, 'walkSpeed', { label: 'walk speed', min: 0, max: 5, step: 0.1 }).on('change', (e) => {
  if (scene instanceof CapeScene) scene.walk.speed = e.value;
});
const followBinding = sceneFolder.addBinding(settings, 'follow', { label: 'follow camera' });
const swayBinding = sceneFolder.addBinding(settings, 'sway', { label: 'sway bar' }).on('change', (e) => {
  if (scene instanceof LabScene) scene.sway.enabled = e.value;
});

const solverFolder = pane.addFolder({ title: 'Solver' });
solverFolder.addBinding(solver, 'mode', { options: { 'XPBD (compliance)': 'xpbd', 'PBD (stiffness)': 'pbd' } });
solverFolder.addBinding(solver, 'substeps', { min: 1, max: 40, step: 1 });
solverFolder.addBinding(solver, 'iterations', { label: 'iterations', min: 1, max: 20, step: 1 });
const kBinding = solverFolder.addBinding(solver, 'pbdStiffness', { label: 'PBD stiffness', min: 0.01, max: 1, step: 0.01 });
solverFolder.addBinding(solver, 'damping', { min: 0, max: 3, step: 0.05 });
solverFolder.addBinding(solver, 'friction', { min: 0, max: 1, step: 0.05 });
solverFolder.addBinding(solver, 'wind', { min: 0, max: 15, step: 0.5 });
solverFolder.on('change', () => {
  scene.applySolver(solver);
  refreshVisibility();
});

const materialFolder = pane.addFolder({ title: 'Material (log₁₀ compliance)' });
materialFolder.addBinding(material, 'stretch', { min: -9, max: -1, step: 0.1 });
materialFolder.addBinding(material, 'shear', { min: -9, max: -1, step: 0.1 });
materialFolder.addBinding(material, 'bend', { min: -9, max: 0, step: 0.1 });
materialFolder.on('change', () => scene.applyMaterial(material));

const debugFolder = pane.addFolder({ title: 'Debug', expanded: false });
debugFolder.addBinding(settings, 'showParticles', { label: 'particles' });
debugFolder.addBinding(settings, 'showConstraints', { label: 'constraints' });

const sim = addSimulationFolder(pane, app.loop);

function refreshVisibility(): void {
  const id = settings.scene;
  walkBinding.hidden = id !== 'cape';
  followBinding.hidden = id !== 'cape';
  swayBinding.hidden = id !== 'lab';
  materialFolder.hidden = id === 'lab';
  kBinding.hidden = solver.mode !== 'pbd' || id === 'lab';
}

load(settings.scene);
app.start();
