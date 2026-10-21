import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { parseMotionDB } from '../../src/anim/mmdb';
import { buildFeatures, searchAABB } from '../../src/anim/mmfeatures';
import { readGamepad } from '../../src/input/gamepad';
import { Keyboard } from '../../src/input/keyboard';
import { SegmentBatch } from '../../src/rig/segments';
import { drawSkeleton } from '../../src/rig/skeletonView';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import type { ControlInput } from '../09-motion-matching/controller';
import { FootLocker, plantedFeet } from '../09-motion-matching/footlock';
import { MotionMatcher } from '../09-motion-matching/matcher';
import { LearnedMatcher, type LmmModel } from './learned';
import { Networks, type NetworksFile } from './networks';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '16',
  writeup,
  hint: 'Left: study 09 (database) · right: learned (networks) · WASD / gamepad, Shift runs · autopilot until you take over',
});
const app = createApp(frame.viewport, { rate: 60, cameraPosition: [0.5, 2.3, -5.2], cameraTarget: [0, 0.9, 0] });
frame.attach(app);

const [dbBuffer, netFile, model] = await Promise.all([
  fetch(new URL('../../assets/mocap/cmu16-mm.bin', document.baseURI)).then((r) => r.arrayBuffer()),
  fetch(new URL('../../assets/lmm/networks.json', document.baseURI)).then((r) => r.json() as Promise<NetworksFile>),
  fetch(new URL('../../assets/lmm/model.json', document.baseURI)).then((r) => r.json() as Promise<LmmModel>),
]);
const db = parseMotionDB(dbBuffer);
const mf = buildFeatures(db);
const nets = new Networks(netFile);
const database = new MotionMatcher(mf, { search: searchAABB });
const start = nets.project(Float32Array.from(model.startX), new Float32Array(nets.X + nets.Z));
const learned = new LearnedMatcher(nets, model, start);
const lockDb = new FootLocker(db.joints);
const lockMl = new FootLocker(db.joints);

/** Learned contacts: the decompressed contact label, and the ankle nearly still (as study 09's foot locking). */
function learnedPlanted(m: LearnedMatcher): boolean[] {
  return [model.leftFoot, model.rightFoot].map((a, k) => {
    const dx = m.currWorld[a * 3] - m.prevWorld[a * 3];
    const dz = m.currWorld[a * 3 + 2] - m.prevWorld[a * 3 + 2];
    return m.contacts[k] > 0.5 && Math.hypot(dx, dz) * 60 < 0.25;
  });
}

const view = { autopilot: true, showDatabase: true, follow: true, lock: true };

// ---------------------------------------------------------------------------------------- input (as study 09)

const keyboard = new Keyboard();
const input: ControlInput = { x: 0, z: 0, run: false };
const AUTOPILOT: [number, number, 'idle' | 'walk' | 'run'][] = [
  [2, 0, 'idle'],
  [3.5, 0, 'walk'],
  [3, 90, 'walk'],
  [2.5, 90, 'run'],
  [2, 0, 'idle'],
  [3, 90, 'walk'],
  [2.5, 0, 'run'],
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

const timing = { db: 0, ml: 0 };
app.onFixedUpdate((dt) => {
  if (manual()) view.autopilot = false;
  if (view.autopilot) autopilot(dt);
  let t0 = performance.now();
  database.update(input, dt);
  timing.db += (performance.now() - t0 - timing.db) * 0.05;
  t0 = performance.now();
  learned.update(input, dt);
  timing.ml += (performance.now() - t0 - timing.ml) * 0.05;
  lockDb.enabled = lockMl.enabled = view.lock;
  lockDb.apply(database.world, plantedFeet(database), dt);
  lockMl.apply(learned.world, learnedPlanted(learned), dt);
  latentSample();
});

// ---------------------------------------------------------------------------------------- rendering

const LEFTC = 0xff8a3d;
const RIGHTC = 0x5fb3ff;
const batch = new SegmentBatch(128, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
app.scene.add(batch);
const headMat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 });
const heads = [new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), headMat(0x8b93a1)), new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), headMat(0xd5d9e0))];
for (const h of heads) {
  h.castShadow = true;
  app.scene.add(h);
}
const headIndex = db.joints.findIndex((j) => j.name === 'Head');
const OFFSET = 0.8; // metres between the two characters, across their path
const shifted = new Float32Array(db.joints.length * 3);
const follow = createFollow(app, 0.3);
const mid = new THREE.Vector3();
const side = new THREE.Vector3();

function draw(world: Float32Array, offset: number, body: number, head: THREE.Mesh): void {
  // Offset along the camera's right, so the two stay side by side on screen whichever way they walk.
  app.camera.getWorldDirection(side);
  side.set(-side.z, 0, side.x).normalize().multiplyScalar(offset);
  for (let i = 0; i < db.joints.length; i++) {
    shifted[i * 3] = world[i * 3] + side.x;
    shifted[i * 3 + 1] = world[i * 3 + 1];
    shifted[i * 3 + 2] = world[i * 3 + 2] + side.z;
  }
  drawSkeleton(batch, db.joints, shifted, { color: (n) => (/^Left|^LHip/.test(n) ? LEFTC : /^Right|^RHip/.test(n) ? RIGHTC : body) });
  head.position.set(shifted[headIndex * 3], shifted[headIndex * 3 + 1] + 0.08, shifted[headIndex * 3 + 2]);
}

app.onFrame((_a, frameDt) => {
  batch.begin();
  heads[0].visible = view.showDatabase;
  if (view.showDatabase) draw(database.world, -OFFSET, 0x8b93a1, heads[0]);
  draw(learned.world, view.showDatabase ? OFFSET : 0, 0xd5d9e0, heads[1]);
  batch.commit();
  mid.set((database.world[0] + learned.world[0]) / 2, 0.9, (database.world[2] + learned.world[2]) / 2);
  if (view.follow) follow.update(mid, frameDt);
  app.focusShadow(mid);
  readTimer -= frameDt;
  if (readTimer <= 0) {
    readTimer = 0.25;
    const dbBytes = db.rot.byteLength + mf.features.byteLength + db.root.byteLength + mf.hipPos.byteLength + mf.hipRot.byteLength;
    readout.textContent =
      `                 database   learned\n` +
      `memory           ${(dbBytes / 1048576).toFixed(1)} MB     ${(nets.size.bytes / 1048576).toFixed(2)} MB\n` +
      `CPU per frame    ${timing.db.toFixed(3)} ms  ${timing.ml.toFixed(3)} ms\n` +
      `switches / s     ${(database.transitions / Math.max(1, database.time)).toFixed(1)}        ${(learned.transitions / Math.max(1, learned.time)).toFixed(1)}\n` +
      `match cost       ${database.bestCost.toFixed(2)}       ${learned.projectedCost.toFixed(2)}\n` +
      `${view.autopilot ? 'autopilot' : 'manual'} · ${nets.size.params.toLocaleString()} weights`;
  }
  latentPlot.draw(
    latents.map((l, i) => ({ values: Float32Array.from({ length: L_N }, (_, k) => l[(latentHead + k) % L_N]), dx: 6 / L_N, color: LATENT_COLORS[i] })),
    6,
  );
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------------------- panels

const L_N = 360;
const LATENT_COLORS = ['#ff8a3d', '#5fb3ff', '#4fd18b', '#ffd166', '#c08bff', '#ff6b6b'];
const latents = LATENT_COLORS.map(() => new Float32Array(L_N));
let latentHead = 0;
function latentSample(): void {
  latents.forEach((l, i) => (l[latentHead] = learned.xz[nets.X + i]));
  latentHead = (latentHead + 1) % L_N;
}
const latentPlot = new LinePlot(frame.addPanel('Latent Z (6 of 32): what X does not say about the pose'), {
  height: 110,
  yMin: -3,
  yMax: 3,
  yTicks: [-2, 0, 2],
  xTickStep: 2,
  formatX: (x) => `${x - 6}s`,
});
const readout = frame.addPanel('Database vs learned');
readout.style.fontFamily = 'var(--mono)';
readout.style.whiteSpace = 'pre';
let readTimer = 0;

const pane = createPane(frame.controls);
const control = pane.addFolder({ title: 'Control' });
control.addBinding(view, 'autopilot');
control.addBinding(view, 'showDatabase', { label: 'show database version' });
control.addBinding(view, 'lock', { label: 'foot locking' });
control.addBinding(view, 'follow', { label: 'follow camera' });
const ml = pane.addFolder({ title: 'Learned runtime' });
ml.addBinding(learned.settings, 'searchInterval', { label: 'project every', min: 1, max: 30, step: 1 });
ml.addBinding(learned.settings, 'switchRatio', { label: 'switch if cost ×', min: 0.5, max: 1, step: 0.01 });
ml.addBinding(learned.settings, 'inertialize', { label: 'inertialize' });
ml.addBinding(learned.settings, 'halflife', { label: '½-life (s)', min: 0.02, max: 0.4, step: 0.01 });
pane.addButton({ title: 'Reset both' }).on('click', () => {
  database.reset();
  learned.reset(start);
});
const sim = addSimulationFolder(pane, app.loop);
app.start();
