import * as THREE from 'three';
import loadMujoco from '@mujoco/mujoco';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import { planGrasps, type Grasp } from './grasp';
import { handLinks, JOINTS, PALM, type Link } from './hand';
import { GraspSim, type LiftResult } from './physics';
import { SHAPES, shapeMesh, type Shape } from './shapes';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '18',
  writeup,
  hint: 'Pick an object · step through the ranked grasps · each one is lifted in MuJoCo · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 60, ground: false, cameraPosition: [0.5, 0.36, 0.62], cameraTarget: [0, 0.12, 0] });
frame.attach(app);
app.camera.near = 0.01;
app.camera.updateProjectionMatrix();
app.controls.minDistance = 0.2;
app.controls.maxDistance = 2;
app.sun.shadow.camera.left = app.sun.shadow.camera.bottom = -0.6;
app.sun.shadow.camera.right = app.sun.shadow.camera.top = 0.6;
app.sun.shadow.camera.updateProjectionMatrix();

const mj = await loadMujoco();

// ---------------------------------------------------------------------------------------- scene

const table = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.04, 0.9), new THREE.MeshStandardMaterial({ color: 0x3a3430, roughness: 0.8 }));
table.position.y = -0.02;
table.receiveShadow = true;
app.scene.add(table);
const grid = new THREE.GridHelper(1.4, 28, 0x4a433d, 0x433c36);
grid.position.y = 0.0005;
app.scene.add(grid);

const objectMat = new THREE.MeshStandardMaterial({ color: 0x5fb3ff, roughness: 0.45 });
const skin = new THREE.MeshStandardMaterial({ color: 0xe0b89a, roughness: 0.6 });
const objectRoot = new THREE.Group();
app.scene.add(objectRoot);

/** Hand meshes: one capsule per link (lengths never change), the palm box and a forearm stub. */
const handRoot = new THREE.Group();
app.scene.add(handRoot);
const restLinks = handLinks(new Float64Array(JOINTS), new THREE.Matrix4());
const linkMeshes = restLinks.map((l) => {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(l.radius, l.a.distanceTo(l.b), 6, 12), skin);
  m.castShadow = true;
  handRoot.add(m);
  return m;
});
const palm = new THREE.Mesh(new THREE.BoxGeometry(2 * PALM.halfWidth, PALM.length, 2 * PALM.halfThickness), skin);
const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.2, 16), skin);
for (const m of [palm, forearm]) {
  m.castShadow = true;
  handRoot.add(m);
}

const Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const links: Link[] = [];

function drawHand(pose: ArrayLike<number>, wrist: THREE.Matrix4): void {
  handLinks(pose, wrist, links);
  links.forEach((l, i) => {
    const m = linkMeshes[i];
    m.position.lerpVectors(l.a, l.b, 0.5);
    m.quaternion.setFromUnitVectors(Y, _v.subVectors(l.b, l.a).normalize());
  });
  wrist.decompose(_v, _q, _s);
  palm.quaternion.copy(_q);
  palm.position.set(0, PALM.length / 2, 0).applyMatrix4(wrist);
  forearm.quaternion.copy(_q);
  forearm.position.set(0, -0.1, 0).applyMatrix4(wrist);
}

// ---------------------------------------------------------------------------------------- state

/** MuJoCo z-up ↔ the scene's y-up: (x, y, z)ᵐʲ = C · (x, y, z)ᵗʰʳᵉᵉ. */
const C = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
const Cinv = C.clone().invert();

const settings = { object: 0, candidate: 1, autoRetry: true, slowMotion: false, showContacts: true, showApproaches: true };
let shape: Shape = SHAPES[0];
let grasps: Grasp[] = [];
let planMs = 0;
const results = new Map<number, LiftResult>();

type Phase = 'reach' | 'shape' | 'physics' | 'result';
let phase: Phase = 'reach';
let phaseTime = 0;
let sim: GraspSim | null = null;
let accumulator = 0;
const objectMatrix = new THREE.Matrix4();
const handMatrix = new THREE.Matrix4();
const pose = new Float64Array(JOINTS);

const N_TRACE = 240;
const handTrace = new Float32Array(N_TRACE);
const objTrace = new Float32Array(N_TRACE);
let traceLen = 0;

const readout = { grasp: '', epsilon: 0, opposition: 0, lift: 0, plan: '', physics: '' };

function selectObject(i: number): void {
  shape = SHAPES[i];
  objectRoot.clear();
  objectRoot.add(shapeMesh(shape, objectMat));
  const t0 = performance.now();
  grasps = planGrasps(shape);
  planMs = performance.now() - t0;
  results.clear();
  const fc = grasps.filter((g) => g.epsilon > 0).length;
  readout.plan = `${grasps.length} closed, ${fc} in force closure, ${planMs.toFixed(0)} ms`;
  settings.candidate = 1;
  pane.refresh();
  startAttempt();
}

const current = (): Grasp => grasps[Math.min(grasps.length - 1, settings.candidate - 1)];

/** The pre-shaped hand 18 cm back along the approach, where the reach starts. */
function hoverWrist(g: Grasp): THREE.Matrix4 {
  return g.wrist.clone().premultiply(new THREE.Matrix4().makeTranslation(g.approach.x * 0.18, g.approach.y * 0.18, g.approach.z * 0.18));
}

function startAttempt(): void {
  sim?.dispose();
  sim = null;
  phase = 'reach';
  phaseTime = 0;
  traceLen = 0;
  objectMatrix.identity();
  const g = current();
  readout.grasp = `#${settings.candidate} of ${grasps.length} · ${g.kind} · ${g.contacts.length} contacts`;
  readout.epsilon = g.epsilon;
  readout.opposition = g.opposition;
  readout.lift = g.lift;
  readout.physics = results.has(settings.candidate) ? describe(results.get(settings.candidate)!) : '…';
}

function describe(r: LiftResult): string {
  return `${r.held ? 'held' : 'dropped'} · rose ${(r.rise * 100).toFixed(1)} cm · slipped ${(r.slip * 100).toFixed(1)} cm`;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _qa = new THREE.Quaternion();

/** Read the hand and object back from MuJoCo into scene frames. */
function readSim(s: GraspSim): void {
  const q = s.data.qpos as Float64Array;
  for (let j = 0; j < JOINTS; j++) pose[j] = q[s.qpos0 + j];
  // Object: its MJCF body frame is the scene's object frame rotated into z-up, so T = C⁻¹ · Tᵐʲ · C.
  _m.compose(_p.set(q[0], q[1], q[2]), _qa.set(q[4], q[5], q[6], q[3]), _s.set(1, 1, 1));
  objectMatrix.copy(Cinv).multiply(_m).multiply(C);
  // Hand: its MJCF uses hand-frame coordinates directly, so the wrist is C⁻¹ · Tᵐʲ.
  const xp = s.data.xpos as Float64Array;
  const xq = s.data.xquat as Float64Array;
  const b = s.handBody;
  _m.compose(_p.set(xp[3 * b], xp[3 * b + 1], xp[3 * b + 2]), _qa.set(xq[4 * b + 1], xq[4 * b + 2], xq[4 * b + 3], xq[4 * b]), _s.set(1, 1, 1));
  handMatrix.copy(Cinv).multiply(_m);
}

app.onFixedUpdate((dt) => {
  const g = current();
  if (!g) return;
  const scaled = settings.slowMotion ? dt * 0.25 : dt;
  phaseTime += scaled;
  if (phase === 'reach') {
    // Slide in along the approach with the open pre-shape, as the planner did.
    const t = smooth(Math.min(1, phaseTime / 0.9));
    hoverWrist(g).decompose(_pa, _qa, _s);
    g.wrist.decompose(_p, _q, _s);
    handMatrix.compose(_pa.lerp(_p, t), _qa.slerp(_q, t), _s.set(1, 1, 1));
    pose.set(g.preshape);
    if (phaseTime >= 0.9) {
      phase = 'shape';
      phaseTime = 0;
      sim = new GraspSim(mj, shape, g);
    }
  } else if (phase === 'shape') {
    // Curl kinematically to just short of contact, where the physics takes over.
    const t = smooth(Math.min(1, phaseTime / 0.35));
    const q = sim!.data.qpos as Float64Array;
    for (let j = 0; j < JOINTS; j++) pose[j] = g.preshape[j] + (q[sim!.qpos0 + j] - g.preshape[j]) * t;
    handMatrix.copy(g.wrist);
    if (phaseTime >= 0.35) {
      phase = 'physics';
      phaseTime = 0;
      accumulator = 0;
    }
  } else if (phase === 'physics') {
    const s = sim!;
    accumulator += scaled;
    while (accumulator >= s.dt && s.time < s.phaseEnd) {
      s.step();
      accumulator -= s.dt;
    }
    readSim(s);
    if (traceLen < N_TRACE && s.time > (traceLen * s.phaseEnd) / N_TRACE) {
      handTrace[traceLen] = (handMatrix.elements[13] - g.wrist.elements[13]) * 100;
      objTrace[traceLen] = objectMatrix.elements[13] * 100;
      traceLen++;
    }
    if (s.time >= s.phaseEnd) {
      const r = s.result();
      results.set(settings.candidate, r);
      readout.physics = describe(r);
      phase = 'result';
      phaseTime = 0;
    }
  } else if (phaseTime > 1.6) {
    // Dropped: try the next-ranked grasp (the planner proposes, physics disposes); held: replay it.
    const r = results.get(settings.candidate);
    if (r && !r.held && settings.autoRetry && settings.candidate < Math.min(grasps.length, 12)) {
      settings.candidate++;
      pane.refresh();
    }
    startAttempt();
  }
});

// ---------------------------------------------------------------------------------------- overlays & panels

const DIGIT_COLORS = [0xff8a3d, 0xffd166, 0x4fd18b, 0x5fb3ff, 0xff5c8a, 0xc6a7ff];
const liftPlot = new LinePlot(frame.addPanel('Lift: hand (orange) vs object (blue) height, cm'), {
  height: 100,
  yMin: -2,
  yMax: 22,
  yTicks: [0, 10, 20],
  xTickStep: 0.5,
  formatX: (x) => `${x.toFixed(1)}s`,
});
const approachPoint = new THREE.Vector3();
const centre = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _e = new THREE.Vector3();
const _a = new THREE.Vector3();

app.onFrame(() => {
  const g = current();
  if (!g) return;
  objectRoot.matrixAutoUpdate = false;
  objectRoot.matrix.copy(objectMatrix);
  objectRoot.matrixWorldNeedsUpdate = true;
  drawHand(pose, handMatrix);
  centre.set(0, shape.height / 2, 0);
  if (settings.showApproaches) {
    // Every approach tried, coloured by its best grasp: green = closure with strong opposition, orange = closure
    // with weak opposition, dim red = no closure.
    const best = new Map<string, Grasp>();
    for (const x of grasps) {
      const k = x.approach.toArray().map((v) => v.toFixed(3)).join();
      const b = best.get(k);
      if (!b || x.score > b.score || (x.score === b.score && x.epsilon > b.epsilon)) best.set(k, x);
    }
    for (const x of best.values()) {
      approachPoint.copy(centre).addScaledVector(x.approach, shape.scale + 0.09);
      const c = x.epsilon <= 0 ? 0x803030 : new THREE.Color().setHSL(0.05 + 0.28 * Math.min(1, Math.max(0, x.opposition)), 0.8, 0.55).getHex();
      app.debug.point(approachPoint, c);
    }
  }
  if (settings.showContacts && phase !== 'reach') {
    // Planned contacts ride with the object: the force direction (into the object) and the friction cone.
    for (const c of g.contacts) {
      _p.copy(c.point).applyMatrix4(objectMatrix);
      _n.copy(c.normal).transformDirection(objectMatrix).negate();
      const col = DIGIT_COLORS[c.digit];
      app.debug.point(_p, col);
      _a.copy(_p).addScaledVector(_n, -0.025);
      app.debug.line(_a, _p, col);
      _t1.set(1, 0, 0);
      if (Math.abs(_n.x) > 0.9) _t1.set(0, 1, 0);
      _t1.addScaledVector(_n, -_t1.dot(_n)).normalize();
      _t2.crossVectors(_n, _t1);
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * Math.PI * 2;
        _e.copy(_n).addScaledVector(_t1, 0.6 * Math.cos(ang)).addScaledVector(_t2, 0.6 * Math.sin(ang)).normalize();
        app.debug.line(_p, _a.copy(_p).addScaledVector(_e, -0.018), col);
      }
    }
  }
  const dur = sim?.phaseEnd ?? 2.1;
  liftPlot.draw(
    [
      { values: handTrace.subarray(0, traceLen), dx: dur / N_TRACE, color: '#ff8a3d' },
      { values: objTrace.subarray(0, traceLen), dx: dur / N_TRACE, color: '#5fb3ff' },
    ],
    dur,
  );
  simHooks.end();
  simHooks.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
pane.addBinding(settings, 'object', { options: Object.fromEntries(SHAPES.map((s, i) => [s.name, i])) }).on('change', (ev) => selectObject(ev.value));
pane.addBinding(settings, 'candidate', { label: 'grasp (rank)', min: 1, max: 30, step: 1 }).on('change', () => startAttempt());
pane.addBinding(settings, 'autoRetry', { label: 'next if dropped' });
pane.addButton({ title: 'Replay' }).on('click', () => startAttempt());
const viewFolder = pane.addFolder({ title: 'View' });
viewFolder.addBinding(settings, 'showContacts', { label: 'contacts & cones' });
viewFolder.addBinding(settings, 'showApproaches', { label: 'approaches' });
viewFolder.addBinding(settings, 'slowMotion', { label: 'slow motion ×¼' });
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'plan', { readonly: true, label: 'planner' });
info.addBinding(readout, 'grasp', { readonly: true });
info.addBinding(readout, 'epsilon', { readonly: true, label: 'ε (closure)', format: (v: number) => v.toFixed(3) });
info.addBinding(readout, 'opposition', { readonly: true, format: (v: number) => v.toFixed(2) });
info.addBinding(readout, 'lift', { readonly: true, label: 'lift quality', format: (v: number) => v.toFixed(2) });
info.addBinding(readout, 'physics', { readonly: true, label: 'MuJoCo' });
const simHooks = addSimulationFolder(pane, app.loop);

selectObject(0);
app.start();
