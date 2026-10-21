import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { readGamepad } from '../../src/input/gamepad';
import { Keyboard } from '../../src/input/keyboard';
import { SegmentBatch } from '../../src/rig/segments';
import { drawSkeleton } from '../../src/rig/skeletonView';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import type { ControlInput } from '../09-motion-matching/controller';
import { PhaseNet, Runner, type NetworksFile, type PfnnModel } from './pfnn';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '26',
  writeup,
  hint: 'Left: phase-functioned network · right: plain network, same layers · WASD / gamepad, Shift runs · autopilot until you take over',
});
const app = createApp(frame.viewport, { rate: 60, cameraPosition: [0.5, 2.3, -5.2], cameraTarget: [0, 0.9, 0] });
frame.attach(app);

const [nets, model] = await Promise.all([
  fetch(new URL('../../assets/pfnn/networks.json', document.baseURI)).then((r) => r.json() as Promise<NetworksFile>),
  fetch(new URL('../../assets/pfnn/model.json', document.baseURI)).then((r) => r.json() as Promise<PfnnModel>),
]);
const start = () => ({ joints: nets.fixture.x[0].slice(model.traj.length * 4 + 2), phase: nets.fixture.phase[0] });
let pfnn = new Runner(new PhaseNet(nets.pfnn, nets, true), model, start());
let mlp = new Runner(new PhaseNet(nets.mlp, nets, false), model, start());
const joints = model.names.map((name, i) => ({ name, parent: model.parents[i] }));

const view = { autopilot: true, follow: true };

// ---------------------------------------------------------------------------------------- input (as study 16)

const keyboard = new Keyboard();
const input: ControlInput = { x: 0, z: 0, run: false };
const AUTOPILOT: [number, number, 'idle' | 'walk' | 'run'][] = [
  [2, 0, 'idle'],
  [4, 0, 'walk'],
  [3, 90, 'walk'],
  [3, 90, 'run'],
  [2, 0, 'idle'],
  [3, 90, 'walk'],
  [3, 0, 'run'],
  [3, 90, 'walk'],
];
const LOOP = AUTOPILOT.reduce((s, [d]) => s + d, 0);
let autoTime = 0;
function autopilot(dt: number): void {
  autoTime = (autoTime + dt) % LOOP;
  let t = autoTime;
  let heading = 0;
  for (const [d, turn, speed] of AUTOPILOT) {
    heading += turn;
    if (t < d) {
      const h = THREE.MathUtils.degToRad(heading);
      const m = speed === 'idle' ? 0 : 1;
      input.x = Math.sin(h) * m;
      input.z = Math.cos(h) * m;
      input.run = speed === 'run';
      return;
    }
    t -= d;
  }
}
const camForward = new THREE.Vector3();
function manual(): boolean {
  const pad = readGamepad();
  const fwd = keyboard.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']) || pad.y;
  const side = keyboard.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']) || pad.x;
  const run = keyboard.isDown('ShiftLeft') || keyboard.isDown('ShiftRight') || pad.run;
  if (fwd === 0 && side === 0) {
    input.x = input.z = 0;
    input.run = run;
    return false;
  }
  app.camera.getWorldDirection(camForward);
  camForward.y = 0;
  camForward.normalize();
  let x = camForward.x * fwd - camForward.z * side;
  let z = camForward.z * fwd + camForward.x * side;
  const m = Math.hypot(x, z);
  if (m > 1) (x /= m), (z /= m);
  input.x = x;
  input.z = z;
  input.run = run;
  return true;
}

// ---------------------------------------------------------------------------------------- simulation

const timing = { pfnn: 0, mlp: 0 };
const N = 360;
const phaseTrace = [new Float32Array(N), new Float32Array(N)];
const kneeTrace = [new Float32Array(N), new Float32Array(N)];
let head = 0;
const knee = (w: ArrayLike<number>) => {
  const [h, k, a] = ['LeftUpLeg', 'LeftLeg', 'LeftFoot'].map((n) => model.names.indexOf(n));
  const ux = w[h * 3] - w[k * 3];
  const uy = w[h * 3 + 1] - w[k * 3 + 1];
  const uz = w[h * 3 + 2] - w[k * 3 + 2];
  const vx = w[a * 3] - w[k * 3];
  const vy = w[a * 3 + 1] - w[k * 3 + 1];
  const vz = w[a * 3 + 2] - w[k * 3 + 2];
  return 180 - (Math.acos((ux * vx + uy * vy + uz * vz) / (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz))) * 180) / Math.PI;
};
app.onFixedUpdate((dt) => {
  if (manual()) view.autopilot = false;
  if (view.autopilot) autopilot(dt);
  let t0 = performance.now();
  pfnn.step(input, dt);
  timing.pfnn += (performance.now() - t0 - timing.pfnn) * 0.05;
  t0 = performance.now();
  mlp.step(input, dt);
  timing.mlp += (performance.now() - t0 - timing.mlp) * 0.05;
  [pfnn, mlp].forEach((r, i) => {
    phaseTrace[i][head] = r.phase;
    kneeTrace[i][head] = knee(r.world);
  });
  head = (head + 1) % N;
  // If either character wanders off or breaks, start both again side by side.
  if (!Number.isFinite(pfnn.world[0]) || !Number.isFinite(mlp.world[0])) {
    pfnn = new Runner(new PhaseNet(nets.pfnn, nets, true), model, start());
    mlp = new Runner(new PhaseNet(nets.mlp, nets, false), model, start());
  }
});

// ---------------------------------------------------------------------------------------- rendering

const LEFTC = 0xff8a3d;
const RIGHTC = 0x5fb3ff;
const batch = new SegmentBatch(128, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
app.scene.add(batch);
const heads = [0xe2b53e, 0xd5d9e0].map((c) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 }));
  m.castShadow = true;
  app.scene.add(m);
  return m;
});
const headIndex = model.names.indexOf('Head');
const OFFSET = 0.8;
const shifted = new Float32Array(model.joints * 3);
const follow = createFollow(app, 0.3);
const mid = new THREE.Vector3();
const side = new THREE.Vector3();
function draw(world: ArrayLike<number>, offset: number, body: number, headMesh: THREE.Mesh): void {
  app.camera.getWorldDirection(side);
  side.set(-side.z, 0, side.x).normalize().multiplyScalar(offset);
  for (let i = 0; i < model.joints; i++) {
    shifted[i * 3] = world[i * 3] + side.x;
    shifted[i * 3 + 1] = world[i * 3 + 1];
    shifted[i * 3 + 2] = world[i * 3 + 2] + side.z;
  }
  drawSkeleton(batch, joints, shifted, { color: (n) => (/^Left|^LHip/.test(n) ? LEFTC : /^Right|^RHip/.test(n) ? RIGHTC : body) });
  headMesh.position.set(shifted[headIndex * 3], shifted[headIndex * 3 + 1] + 0.08, shifted[headIndex * 3 + 2]);
}

const phasePlot = new LinePlot(frame.addPanel('Gait phase (PFNN gold, MLP grey)'), { height: 80, yMin: 0, yMax: 1, yTicks: [0, 0.5, 1], xTickStep: 2, formatX: (x) => `${(x - 6).toFixed(0)}s` });
const kneePlot = new LinePlot(frame.addPanel('Left knee flexion (°): the MLP blurs the extremes'), { height: 90, yMin: 0, yMax: 110, yTicks: [0, 50, 100], xTickStep: 2, formatX: (x) => `${(x - 6).toFixed(0)}s` });
const readoutBody = frame.addPanel('Readout');
const readout = document.createElement('pre');
readout.style.margin = '0';
readout.style.font = '11px ui-monospace, monospace';
readout.style.color = '#c3c9d1';
readoutBody.appendChild(readout);
let readTimer = 0;
const ordered = (a: Float32Array) => Float32Array.from({ length: N }, (_, k) => a[(head + k) % N]);

app.onFrame((_a, frameDt) => {
  batch.begin();
  draw(pfnn.world, -OFFSET, 0xe2b53e, heads[0]);
  draw(mlp.world, OFFSET, 0xd5d9e0, heads[1]);
  batch.commit();
  mid.set((pfnn.world[0] + mlp.world[0]) / 2, 0.9, (pfnn.world[2] + mlp.world[2]) / 2);
  if (view.follow) follow.update(mid, frameDt);
  app.focusShadow(mid);
  readTimer -= frameDt;
  if (readTimer <= 0) {
    readTimer = 0.25;
    const sp = (r: Runner) => Math.hypot(r.controller.x.v, r.controller.z.v).toFixed(2);
    readout.textContent =
      `                 PFNN        MLP\n` +
      `weights          ${nets.params.pfnn.toLocaleString()}     ${nets.params.mlp.toLocaleString()}\n` +
      `CPU per frame    ${timing.pfnn.toFixed(2)} ms     ${timing.mlp.toFixed(2)} ms\n` +
      `asked speed      ${sp(pfnn)} m/s    ${sp(mlp)} m/s\n` +
      `${view.autopilot ? 'autopilot' : 'manual'}${input.run ? ' · running' : ''}`;
  }
  phasePlot.draw(
    [
      { values: ordered(phaseTrace[0]), dx: 6 / N, color: '#e2b53e' },
      { values: ordered(phaseTrace[1]), dx: 6 / N, color: '#8a93a6' },
    ],
    6,
  );
  kneePlot.draw(
    [
      { values: ordered(kneeTrace[0]), dx: 6 / N, color: '#e2b53e' },
      { values: ordered(kneeTrace[1]), dx: 6 / N, color: '#8a93a6' },
    ],
    6,
  );
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
pane.addBinding(view, 'autopilot');
pane.addBinding(view, 'follow', { label: 'camera follows' });
pane.addButton({ title: 'Restart both' }).on('click', () => {
  pfnn = new Runner(new PhaseNet(nets.pfnn, nets, true), model, start());
  mlp = new Runner(new PhaseNet(nets.mlp, nets, false), model, start());
});
const sim = addSimulationFolder(pane, app.loop);
app.start();
