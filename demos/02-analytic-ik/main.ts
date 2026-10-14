import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { Arm, Head, type ArmSettings, type HeadSettings, type Materials } from './rig';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '02',
  writeup,
  hint: 'Click a target or pole to grab it · T / R: move / rotate · Orbit: drag',
});

const app = createApp(frame.viewport, {
  rate: 60,
  cameraPosition: [1.6, 2.0, 3.2],
  cameraTarget: [0, 1.35, 0.15],
});
frame.attach(app);

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Settings

const settings = {
  animate: true,
  sway: true,
  gizmo: 'translate' as 'translate' | 'rotate',
  look: 'right' as 'right' | 'left' | 'camera',
  softIK: true,
  showTriangles: true,
  showReach: false,
  showCones: true,
  showGaze: true,
};

const arm: ArmSettings & { swingDeg: number; twistDeg: number } = {
  softness: 0.06,
  stretch: 0,
  swingLimit: 70 * DEG,
  twistLimit: 90 * DEG,
  twistShare: 0.5,
  swingDeg: 70,
  twistDeg: 90,
};

const head: HeadSettings & { headDeg: number; eyeDeg: number } = {
  headLimit: 65 * DEG,
  eyeLimit: 30 * DEG,
  head: { f: 1.4, zeta: 0.85, r: 0 },
  eyes: { f: 7, zeta: 0.9, r: 0 },
  headDeg: 65,
  eyeDeg: 30,
};

// ---------------------------------------------------------------------------
// Character

const materials: Materials = {
  body: new THREE.MeshStandardMaterial({ color: 0xd5d9e0, roughness: 0.45, metalness: 0.1 }),
  joint: new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.5 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.45 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.25 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.35 }),
};

const torso = new THREE.Group();
torso.position.set(0, 1.0, 0);
app.scene.add(torso);
{
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 1.0, 12), materials.joint);
  stand.position.set(0, 0.5, 0);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.04, 32), materials.joint);
  base.position.set(0, 0.02, 0);
  for (const m of [stand, base]) m.castShadow = m.receiveShadow = true;
  app.scene.add(stand, base);

  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.3, 8, 24), materials.body);
  chest.position.y = 0.28;
  chest.scale.set(1.35, 1, 0.75);
  const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), materials.joint);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 10), materials.joint);
  collar.rotation.z = Math.PI / 2;
  collar.position.y = 0.48;
  for (const m of [chest, pelvis, collar]) m.castShadow = true;
  torso.add(chest, pelvis, collar);
}

const SHOULDER = { right: new THREE.Vector3(-0.25, 0.48, 0), left: new THREE.Vector3(0.25, 0.48, 0) };
const UPPER = 0.3;
const FORE = 0.28;

const arms = {
  right: new Arm(app.scene, UPPER, FORE, materials),
  left: new Arm(app.scene, UPPER, FORE, materials),
};

// ---------------------------------------------------------------------------
// Targets and poles

function makeTarget(color: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.03, 20, 14), mat);
  const pointer = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.08, 12).translate(0, 0.07, 0), mat);
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.004, 0.03), mat);
  palm.position.set(0, 0.03, 0.02);
  palm.rotation.x = Math.PI / 2;
  g.add(ball, pointer, palm);
  return g;
}

function makePole(color: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.OctahedronGeometry(0.035),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, wireframe: true }),
  );
}

const targets = { right: makeTarget(0xffd166), left: makeTarget(0x5fb3ff) };
const poles = { right: makePole(0xffd166), left: makePole(0x5fb3ff) };
targets.right.position.set(-0.35, 1.25, 0.4);
targets.left.position.set(0.35, 1.3, 0.35);
poles.right.position.set(-0.85, 0.95, -0.5);
poles.left.position.set(0.85, 0.95, -0.5);
app.scene.add(targets.right, targets.left, poles.right, poles.left);

const selectable: THREE.Object3D[] = [targets.right, targets.left, poles.right, poles.left];

const transform = new TransformControls(app.camera, app.renderer.domElement);
transform.size = 0.6;
const transformHelper = transform.getHelper();
app.scene.add(transformHelper);
transform.attach(targets.right);
transform.addEventListener('dragging-changed', (e) => {
  app.controls.enabled = !e.value;
  if (e.value && settings.animate) {
    settings.animate = false;
    pane.refresh();
  }
});

function setGizmo(mode: 'translate' | 'rotate'): void {
  const isPole = transform.object === poles.right || transform.object === poles.left;
  settings.gizmo = isPole ? 'translate' : mode;
  transform.setMode(settings.gizmo);
}

// Click (without dragging) to select a target or pole.
{
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down: { x: number; y: number } | null = null;
  const canvas = app.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || transform.dragging) return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, app.camera);
    const hit = raycaster.intersectObjects(selectable, true)[0];
    if (!hit) return;
    let o: THREE.Object3D | null = hit.object;
    while (o && !selectable.includes(o)) o = o.parent;
    if (o) {
      transform.attach(o);
      setGizmo(settings.gizmo);
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 't' || e.key === 'T') setGizmo('translate');
    if (e.key === 'r' || e.key === 'R') setGizmo('rotate');
    pane.refresh();
  });
}

const head3 = new Head(torso, new THREE.Vector3(0, 0.56, 0), materials, head, targets.right.position);

// ---------------------------------------------------------------------------
// Animation

const euler = new THREE.Euler();

function animateTargets(t: number): void {
  // Paths deliberately leave the reachable sphere so soft IK and full extension are visible.
  targets.right.position.set(
    -0.4 + 0.28 * Math.sin(t * 0.9),
    1.25 + 0.25 * Math.sin(t * 1.3 + 0.4),
    0.32 + 0.3 * Math.sin(t * 0.7 + 1),
  );
  targets.left.position.set(
    0.38 + 0.22 * Math.sin(t * 0.8 + 2),
    1.3 + 0.28 * Math.sin(t * 1.1 + 1.3),
    0.3 + 0.28 * Math.sin(t * 0.6 + 2.5),
  );
  // Rotations sweep through the wrist limits.
  targets.right.quaternion.setFromEuler(euler.set(1.2 + 0.6 * Math.sin(t * 0.8), 0, -0.4 + 1.3 * Math.sin(t * 0.5)));
  targets.left.quaternion.setFromEuler(euler.set(1.2 + 0.5 * Math.sin(t * 0.7 + 1), 0, 0.4 + 1.2 * Math.sin(t * 0.45 + 2)));
}

const shoulderWorld = new THREE.Vector3();
const lookPoint = new THREE.Vector3();

app.onFixedUpdate((dt, time) => {
  if (settings.animate) animateTargets(time);

  if (settings.sway) {
    torso.rotation.set(0.05 * Math.sin(time * 0.9), 0.3 * Math.sin(time * 0.45), 0.06 * Math.sin(time * 0.6));
    torso.position.y = 1.0 + 0.015 * Math.sin(time * 1.8);
  } else {
    torso.rotation.set(0, 0, 0);
    torso.position.y = 1.0;
  }
  torso.updateMatrixWorld(true);

  const solve = { ...arm, softness: settings.softIK ? arm.softness : 0 };
  for (const side of ['right', 'left'] as const) {
    torso.localToWorld(shoulderWorld.copy(SHOULDER[side]));
    arms[side].update(shoulderWorld, targets[side].position, targets[side].quaternion, poles[side].position, solve);
  }

  if (settings.look === 'camera') lookPoint.copy(app.camera.position);
  else lookPoint.copy(targets[settings.look].position);
  head3.update(dt, lookPoint, head);
});

// ---------------------------------------------------------------------------
// Debug drawing and readout

const readout = frame.addPanel('Solver');
readout.style.fontFamily = 'var(--mono)';
readout.style.whiteSpace = 'pre';
let readoutTimer = 0;

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const torsoQuat = new THREE.Quaternion();

app.onFrame((_alpha, frameDt) => {
  const d = app.debug;
  for (const side of ['right', 'left'] as const) {
    const r = arms[side].result;
    torso.localToWorld(shoulderWorld.copy(SHOULDER[side]));
    const color = side === 'right' ? 0xffd166 : 0x5fb3ff;
    if (settings.showTriangles) {
      d.polyline([shoulderWorld, r.mid, r.end], color, true);
      d.line(r.mid, poles[side].position, 0x6b7280);
      if (r.error > 1e-3) d.line(r.end, targets[side].position, 0xff4d4d);
    }
    if (settings.showReach) {
      const chain = r.lengthA + r.lengthB;
      tmp.subVectors(targets[side].position, shoulderWorld).cross(r.bendDir).normalize();
      d.circle(shoulderWorld, tmp, chain, 0x4b5563, 64);
      if (settings.softIK && arm.softness > 0) d.circle(shoulderWorld, tmp, chain - arm.softness, 0x2f6f4f, 64);
    }
  }

  if (settings.showCones) {
    torso.getWorldQuaternion(torsoQuat);
    head3.eyeCentre(tmp);
    const axis = tmp2.set(0, 0, 1).applyQuaternion(torsoQuat);
    const dist = 0.25;
    const centre = tmp.clone().addScaledVector(axis, dist * Math.cos(head.headLimit));
    d.circle(centre, axis, dist * Math.sin(head.headLimit), 0x7c5cff, 48);
  }
  if (settings.showGaze) {
    head3.eyeCentre(tmp);
    d.line(tmp, head3.gazeEyes.value, 0x9b87ff);
    d.point(head3.gazeHead.value, 0x7c5cff);
  }

  readoutTimer -= frameDt;
  if (readoutTimer <= 0) {
    readoutTimer = 0.1;
    const lines: string[] = [];
    for (const side of ['right', 'left'] as const) {
      const r = arms[side].result;
      torso.localToWorld(shoulderWorld.copy(SHOULDER[side]));
      const dist = shoulderWorld.distanceTo(targets[side].position);
      lines.push(
        `${side.padEnd(5)} reach ${(UPPER + FORE).toFixed(2)}  dist ${dist.toFixed(3)}  err ${r.error.toFixed(3)}` +
          (r.lengthA > UPPER + 1e-6 ? `  ×${(r.lengthA / UPPER).toFixed(2)}` : ''),
      );
    }
    readout.textContent = lines.join('\n');
  }

  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------
// Controls

const pane = createPane(frame.controls);

const scene = pane.addFolder({ title: 'Scene' });
scene.addBinding(settings, 'animate', { label: 'animate targets' });
scene.addBinding(settings, 'sway', { label: 'torso sway' });
scene
  .addBinding(settings, 'gizmo', { options: { move: 'translate', rotate: 'rotate' } })
  .on('change', (e) => setGizmo(e.value));

const ik = pane.addFolder({ title: 'Two-bone IK' });
ik.addBinding(settings, 'softIK', { label: 'soft IK' });
ik.addBinding(arm, 'softness', { min: 0.005, max: 0.2, step: 0.005 });
ik.addBinding(arm, 'stretch', { min: 0, max: 1, step: 0.01 });

const wrist = pane.addFolder({ title: 'Wrist (swing-twist)' });
wrist
  .addBinding(arm, 'swingDeg', { label: 'swing limit °', min: 0, max: 180, step: 1 })
  .on('change', (e) => (arm.swingLimit = e.value * DEG));
wrist
  .addBinding(arm, 'twistDeg', { label: 'twist limit °', min: 0, max: 180, step: 1 })
  .on('change', (e) => (arm.twistLimit = e.value * DEG));
wrist.addBinding(arm, 'twistShare', { label: 'forearm share', min: 0, max: 1, step: 0.05 });

const look = pane.addFolder({ title: 'Look-at' });
look.addBinding(settings, 'look', { label: 'look at', options: { 'right target': 'right', 'left target': 'left', camera: 'camera' } });
look
  .addBinding(head, 'headDeg', { label: 'head cone °', min: 0, max: 120, step: 1 })
  .on('change', (e) => (head.headLimit = e.value * DEG));
look
  .addBinding(head, 'eyeDeg', { label: 'eye cone °', min: 0, max: 60, step: 1 })
  .on('change', (e) => (head.eyeLimit = e.value * DEG));
look.addBinding(head.head, 'f', { label: 'head f', min: 0.2, max: 8, step: 0.1 });
look.addBinding(head.head, 'zeta', { label: 'head ζ', min: 0.1, max: 2, step: 0.01 });
look.addBinding(head.eyes, 'f', { label: 'eyes f', min: 0.5, max: 15, step: 0.1 });
look.on('change', () => head3.configure(head));

const debug = pane.addFolder({ title: 'Debug', expanded: false });
debug.addBinding(settings, 'showTriangles', { label: 'IK triangles' });
debug.addBinding(settings, 'showReach', { label: 'reach circles' });
debug.addBinding(settings, 'showCones', { label: 'head cone' });
debug.addBinding(settings, 'showGaze', { label: 'gaze' });

const sim = addSimulationFolder(pane, app.loop);

app.start();
