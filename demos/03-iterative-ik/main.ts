import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import { SegmentBatch } from '../../src/rig/segments';
import { Chain, type JointSpec, type SolveResult } from '../../src/ik/chain';
import { solveCCD } from '../../src/ik/ccd';
import { solveFABRIK } from '../../src/ik/fabrik';
import { solveJacobian, type JacobianMethod } from '../../src/ik/jacobian';
import { FabrikTree } from '../../src/ik/fabrikTree';
import { robotArm, tentacle, tree, type ScenarioId } from './scenarios';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '03',
  writeup,
  hint: 'Drag the gizmo to move the targets · Orbit: drag · Zoom: scroll',
});

const app = createApp(frame.viewport, {
  rate: 60,
  cameraPosition: [0.4, 2.6, 6.2],
  cameraTarget: [0, 1.0, 0],
});
frame.attach(app);

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Settings

const settings = {
  scenario: 'tentacle' as ScenarioId,
  animate: true,
  warmStart: true,
  iterations: 8,
  tolerance: 0.001,
  coneDeg: 30,
  twistDeg: 15,
  ccdMaxDeg: 30,
  method: 'dls' as JacobianMethod,
  lambda: 0.1,
  showTargets: true,
  showCones: false,
};

const SOLVERS = [
  { id: 'ccd', name: 'CCD', color: 0xff8a3d, css: '#ff8a3d', x: -1.8 },
  { id: 'fabrik', name: 'FABRIK', color: 0x5fb3ff, css: '#5fb3ff', x: 0 },
  { id: 'jacobian', name: 'Jacobian', color: 0x4fd18b, css: '#4fd18b', x: 1.8 },
] as const;
type SolverId = (typeof SOLVERS)[number]['id'];

function runSolver(
  id: SolverId,
  chain: Chain,
  target: THREE.Vector3,
  iterations: number,
  errors?: number[],
  tolerance = settings.tolerance,
): SolveResult {
  const o = { iterations, tolerance, errors };
  switch (id) {
    case 'ccd':
      return solveCCD(chain, target, { ...o, maxAngle: settings.ccdMaxDeg * DEG });
    case 'fabrik':
      return solveFABRIK(chain, target, o);
    case 'jacobian':
      return solveJacobian(chain, target, { ...o, method: settings.method, lambda: settings.lambda });
  }
}

// ---------------------------------------------------------------------------
// Scene objects

const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.15 });
const batch = new SegmentBatch(256, material);
app.scene.add(batch);

const targetMat = new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x6b4a00, roughness: 0.4 });
const targetRig = new THREE.Group();
targetRig.position.set(0.5, 1.1, 0.3);
app.scene.add(targetRig);
const laneTargets = SOLVERS.map((s) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 14), targetMat);
  app.scene.add(m);
  return { solver: s, mesh: m };
});
const treeTargets = tree().targetOffsets.map((off) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 14), targetMat);
  m.userData.offset = off;
  app.scene.add(m);
  return m;
});

const bases = SOLVERS.map((s) => {
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 0.06, 32),
    new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.6 }),
  );
  base.position.set(s.x, 0.03, 0);
  base.receiveShadow = base.castShadow = true;
  app.scene.add(base);
  const label = app.label(s.name, base, [0, -0.02, 0.45]);
  return { base, label };
});

const transform = new TransformControls(app.camera, app.renderer.domElement);
transform.attach(targetRig);
transform.size = 0.7;
transform.addEventListener('dragging-changed', (e) => {
  app.controls.enabled = !e.value;
  if (e.value && settings.animate) {
    settings.animate = false;
    pane.refresh();
  }
});
app.scene.add(transform.getHelper());

// ---------------------------------------------------------------------------
// Chains

interface Lane {
  id: SolverId;
  chain: Chain;
  target: THREE.Vector3;
  last: SolveResult;
  time: number;
}

let lanes: Lane[] = [];
let treeSolver: FabrikTree | null = null;
let treeEffectors: number[] = [];
let treeInfo = { iterations: 0, error: 0, time: 0 };
let specs: JointSpec[] = [];
let radius: [number, number] = [0.05, 0.015];

function build(): void {
  const scenario = settings.scenario;
  treeSolver = null;
  lanes = [];
  if (scenario === 'tree') {
    const t = tree();
    treeSolver = new FabrikTree(t.nodes);
    treeEffectors = t.effectors;
  } else {
    specs = scenario === 'tentacle' ? tentacle(settings.coneDeg * DEG, settings.twistDeg * DEG) : robotArm();
    radius = scenario === 'tentacle' ? [0.055, 0.014] : [0.075, 0.045];
    lanes = SOLVERS.map((s) => {
      const chain = new Chain(specs);
      chain.basePosition.set(s.x, 0.06, 0);
      chain.forward();
      return { id: s.id, chain, target: new THREE.Vector3(), last: { iterations: 0, error: 0 }, time: 0 };
    });
  }
  const isTree = scenario === 'tree';
  bases.forEach((b, i) => {
    const visible = !isTree || SOLVERS[i].id === 'fabrik';
    b.base.visible = visible;
    b.label.visible = visible;
    b.label.element.textContent = isTree && visible ? 'FABRIK · multi-effector' : SOLVERS[i].name;
  });
  for (const lt of laneTargets) lt.mesh.visible = !isTree;
  if (isTree) targetRig.position.set(0.2, 1.15, 0.2);
  for (const m of treeTargets) m.visible = isTree;
  plotDirty = true;
}

// ---------------------------------------------------------------------------
// Simulation

const scratch = new THREE.Vector3();

function animateTarget(t: number): void {
  if (settings.scenario === 'tree') {
    // The rig is the centroid of the three branch targets; keep it inside the tree's workspace.
    targetRig.position.set(0.35 * Math.sin(t * 0.6), 1.15 + 0.15 * Math.sin(t * 0.9), 0.3 * Math.cos(t * 0.45));
    return;
  }
  // Mostly inside the workspace, periodically pushed out of reach to expose singular behaviour.
  const reach = Math.pow(Math.max(0, Math.sin(t * 0.31)), 4);
  targetRig.position.set(
    0.6 * Math.sin(t * 0.7),
    1.0 + 0.4 * Math.sin(t * 1.1) + 0.55 * reach,
    0.5 * Math.cos(t * 0.5),
  );
}

app.onFixedUpdate((_dt, time) => {
  if (settings.animate) animateTarget(time);

  if (treeSolver) {
    const targets = new Map<number, THREE.Vector3>();
    treeTargets.forEach((m, i) => {
      m.position.copy(targetRig.position).add(m.userData.offset as THREE.Vector3);
      m.position.y += 0.08 * Math.sin(time * 1.7 + i * 2);
      targets.set(treeEffectors[i], m.position);
    });
    const t0 = performance.now();
    const r = treeSolver.solve(targets, scratch.set(0, 0.06, 0), settings.iterations, settings.tolerance);
    treeInfo = { ...r, time: smooth(treeInfo.time, performance.now() - t0) };
    return;
  }

  for (const lane of lanes) {
    const s = SOLVERS.find((x) => x.id === lane.id)!;
    lane.target.copy(targetRig.position).add(scratch.set(s.x, 0, 0));
    if (!settings.warmStart) lane.chain.resetPose();
    const t0 = performance.now();
    lane.last = runSolver(lane.id, lane.chain, lane.target, settings.iterations);
    lane.time = smooth(lane.time, performance.now() - t0);
  }
});

function smooth(prev: number, next: number): number {
  return prev === 0 ? next : prev * 0.95 + next * 0.05;
}

// ---------------------------------------------------------------------------
// Rendering

const coneCentre = new THREE.Vector3();
const coneAxis = new THREE.Vector3();

app.onFrame((_alpha, frameDt) => {
  batch.begin();
  if (treeSolver) {
    const p = treeSolver.positions;
    for (let i = 1; i < p.length; i++) {
      const depth = Math.min(1, p[i].y / 1.6);
      const r = THREE.MathUtils.lerp(0.06, 0.016, depth);
      batch.segment(p[treeSolver.parent[i]], p[i], r, 0x5fb3ff);
      batch.joint(p[i], r * 1.2, 0x5fb3ff);
    }
    batch.joint(p[0], 0.07, 0x5fb3ff);
    if (settings.showTargets) treeEffectors.forEach((e, i) => app.debug.line(p[e], treeTargets[i].position, 0x8b929c));
  } else {
    for (const lane of lanes) {
      const s = SOLVERS.find((x) => x.id === lane.id)!;
      batch.chain(lane.chain.positions, radius[0], radius[1], s.color);
      if (settings.showTargets) app.debug.line(lane.chain.effector, lane.target, lane.last.error > 0.01 ? 0xff4d4d : 0x8b929c);
      if (settings.showCones && settings.scenario === 'tentacle') {
        const c = lane.chain;
        for (let i = 1; i < c.size; i++) {
          coneAxis.copy(c.joints[i].boneDir).applyQuaternion(c.world[i - 1]);
          const h = 0.08;
          coneCentre.copy(c.positions[i]).addScaledVector(coneAxis, h * Math.cos(c.joints[i].cone));
          app.debug.circle(coneCentre, coneAxis, h * Math.sin(c.joints[i].cone), 0x7c5cff, 20);
        }
      }
    }
    for (const lt of laneTargets) lt.mesh.position.copy(targetRig.position).add(scratch.set(lt.solver.x, 0, 0));
  }
  batch.commit();

  readoutTimer -= frameDt;
  if (readoutTimer <= 0) {
    readoutTimer = 0.15;
    updateReadout();
  }
  plotTimer -= frameDt;
  if (plotTimer <= 0 || plotDirty) {
    plotTimer = 0.25;
    plotDirty = false;
    updatePlot();
  }
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------
// Readout and convergence plot

const readout = frame.addPanel('Per-frame solve');
readout.style.fontFamily = 'var(--mono)';
readout.style.whiteSpace = 'pre';
let readoutTimer = 0;

function updateReadout(): void {
  const fmt = (name: string, r: SolveResult, time: number) =>
    `${name.padEnd(9)} it ${String(r.iterations).padStart(2)}  err ${(r.error * 1000).toFixed(2).padStart(7)} mm  ${(time * 1000).toFixed(0).padStart(4)} µs`;
  if (treeSolver) {
    readout.textContent = fmt('FABRIK', treeInfo, treeInfo.time);
    return;
  }
  readout.textContent = lanes
    .map((l) => fmt(l.id === 'jacobian' ? settings.method.toUpperCase() : SOLVERS.find((s) => s.id === l.id)!.name, l.last, l.time))
    .join('\n');
}

const plotBody = frame.addPanel('Convergence from rest (error vs iteration)');
const plot = new LinePlot(plotBody, {
  yMin: 1e-5,
  yMax: 3,
  logY: true,
  yTicks: [1e-4, 1e-2, 1],
  formatY: (y) => (y >= 1 ? '1 m' : y >= 1e-2 ? '1 cm' : '0.1 mm'),
  xTickStep: 10,
  height: 130,
});
let plotTimer = 0;
let plotDirty = true;
const PLOT_ITERS = 40;
const probe = { chain: null as Chain | null, key: '' };

function updatePlot(): void {
  if (treeSolver) {
    const t = tree();
    const fresh = new FabrikTree(t.nodes);
    const targets = new Map<number, THREE.Vector3>();
    treeTargets.forEach((m, i) => targets.set(t.effectors[i], m.position));
    const root = new THREE.Vector3(0, 0.06, 0);
    const errors = [fresh.solve(targets, root, 0, 0).error];
    fresh.solve(targets, root, PLOT_ITERS, 1e-5, errors);
    plot.draw([{ values: errors, dx: 1, color: '#5fb3ff' }], PLOT_ITERS);
    return;
  }
  const key = JSON.stringify(specs.map((s) => [s.cone, s.twist, s.type]));
  if (!probe.chain || probe.key !== key) {
    probe.chain = new Chain(specs);
    probe.key = key;
  }
  const series = SOLVERS.map((s) => {
    const c = probe.chain!;
    c.basePosition.set(0, 0.06, 0);
    c.resetPose();
    const target = scratch.copy(targetRig.position);
    const errors = [c.error(target)];
    runSolver(s.id, c, target, PLOT_ITERS, errors, 1e-5);
    return { values: errors, dx: 1, color: s.css };
  });
  plot.draw(series, PLOT_ITERS);
}

// ---------------------------------------------------------------------------
// Controls

const pane = createPane(frame.controls);

const scene = pane.addFolder({ title: 'Scenario' });
scene
  .addBinding(settings, 'scenario', {
    options: { 'tentacle (ball joints)': 'tentacle', 'robot arm (hinges)': 'robot', 'tree (multi-effector)': 'tree' },
  })
  .on('change', build);
scene.addBinding(settings, 'animate', { label: 'animate target' });
scene.addBinding(settings, 'warmStart', { label: 'warm start' });

const solve = pane.addFolder({ title: 'Solve' });
solve.addBinding(settings, 'iterations', { label: 'iterations/frame', min: 1, max: 40, step: 1 });
solve.addBinding(settings, 'tolerance', { min: 0.0001, max: 0.02, step: 0.0001 });
solve.addBinding(settings, 'ccdMaxDeg', { label: 'CCD max step °', min: 1, max: 180, step: 1 });
solve.addBinding(settings, 'method', {
  label: 'jacobian',
  options: { 'damped least squares': 'dls', 'pseudo-inverse': 'pinv', transpose: 'transpose' },
});
solve.addBinding(settings, 'lambda', { label: 'DLS λ', min: 0.01, max: 1, step: 0.01 });
solve.on('change', () => (plotDirty = true));

const limits = pane.addFolder({ title: 'Tentacle limits' });
limits.addBinding(settings, 'coneDeg', { label: 'cone °', min: 2, max: 180, step: 1 });
limits.addBinding(settings, 'twistDeg', { label: 'twist °', min: 0, max: 180, step: 1 });
limits.on('change', () => {
  if (settings.scenario === 'tentacle') build();
});

const debug = pane.addFolder({ title: 'Debug', expanded: false });
debug.addBinding(settings, 'showTargets', { label: 'effector → target' });
debug.addBinding(settings, 'showCones', { label: 'cone limits' });

const sim = addSimulationFolder(pane, app.loop);

build();
app.start();
