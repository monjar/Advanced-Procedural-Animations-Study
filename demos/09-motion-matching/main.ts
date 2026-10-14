import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { parseMotionDB } from '../../src/anim/mmdb';
import { aabbEvaluated, buildFeatures, GROUPS, searchAABB, searchBrute, TRAJ_FRAMES } from '../../src/anim/mmfeatures';
import { readGamepad } from '../../src/input/gamepad';
import { Keyboard } from '../../src/input/keyboard';
import { SegmentBatch } from '../../src/rig/segments';
import { drawSkeleton } from '../../src/rig/skeletonView';
import { createDemoFrame } from '../../src/ui/demoFrame';
import type { ControlInput } from './controller';
import { FootLocker, plantedFeet } from './footlock';
import { MotionMatcher } from './matcher';
import { drawTimeline } from './timeline';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '09',
  writeup,
  hint: 'WASD / arrows or a gamepad to walk · Shift or right trigger: run · autopilot until you take over · Orbit: drag',
});

const app = createApp(frame.viewport, { rate: 60, cameraPosition: [3.6, 2.3, -4.2], cameraTarget: [0, 0.9, 0] });
frame.attach(app);

const buffer = await (await fetch(new URL('../../assets/mocap/cmu16-mm.bin', document.baseURI))).arrayBuffer();
const db = parseMotionDB(buffer);
const mf = buildFeatures(db);
const matcher = new MotionMatcher(mf, { search: searchAABB });
const locker = new FootLocker(db.joints);

const LEFT = 0xff8a3d;
const RIGHT = 0x5fb3ff;
const BODY = 0xd5d9e0;
const DESIRED = 0xffd166;
const MATCHED = 0x7ee0a1;

const view = { trajectories: true, follow: true, autopilot: true, search: 'aabb' as 'aabb' | 'brute' };

// ---------------------------------------------------------------------------
// Input: keyboard / gamepad relative to the camera, or a looping autopilot.

const keyboard = new Keyboard();
const input: ControlInput = { x: 0, z: 0, run: false };

/** Autopilot programme: [seconds, heading change (deg) at the start, speed]. Four 90° turns close the loop. */
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
const AUTOPILOT_LENGTH = AUTOPILOT.reduce((s, [d]) => s + d, 0);
let autoTime = 0;

function autopilot(dt: number): void {
  autoTime = (autoTime + dt) % AUTOPILOT_LENGTH;
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
  // Screen right = forward × up = (−f.z, 0, f.x).
  let x = camForward.x * fwd - camForward.z * side;
  let z = camForward.z * fwd + camForward.x * side;
  const m = Math.hypot(x, z);
  if (m > 1) (x /= m), (z /= m);
  input.x = x;
  input.z = z;
  input.run = run;
  return true;
}

// ---------------------------------------------------------------------------
// Rendering

const batch = new SegmentBatch(64, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
app.scene.add(batch);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), new THREE.MeshStandardMaterial({ color: BODY, roughness: 0.45 }));
head.castShadow = true;
app.scene.add(head);
const headIndex = db.joints.findIndex((j) => j.name === 'Head');
const follow = createFollow(app, 0.3);

app.onFixedUpdate((dt) => {
  if (manual()) view.autopilot = false;
  if (view.autopilot) autopilot(dt);
  matcher.update(input, dt);
  locker.apply(matcher.world, plantedFeet(matcher), dt);
});

const p = new THREE.Vector3();
const q = new THREE.Vector3();
const pred = { x: 0, z: 0, yaw: 0 };
const matched = TRAJ_FRAMES.map(() => ({ x: 0, z: 0 }));
const desiredPts = [0, ...TRAJ_FRAMES].map(() => new THREE.Vector3());
const matchedPts = [0, ...TRAJ_FRAMES].map(() => new THREE.Vector3());
let searchMs = 0;

app.onFrame((_alpha, frameDt) => {
  const w = matcher.world;
  const contactL = locker.feet[0].locked;
  const contactR = locker.feet[1].locked;
  batch.begin();
  drawSkeleton(batch, db.joints, w, {
    color: (n) => (/^Left|^LHip/.test(n) ? LEFT : /^Right|^RHip/.test(n) ? RIGHT : BODY),
    jointColor: (n) =>
      (n === 'LeftFoot' && contactL) || (n === 'RightFoot' && contactR) ? 0xffffff : /^Left|^LHip/.test(n) ? LEFT : /^Right|^RHip/.test(n) ? RIGHT : BODY,
  });
  batch.commit();
  head.position.set(w[headIndex * 3], w[headIndex * 3 + 1] + 0.08, w[headIndex * 3 + 2]);

  const d = app.debug;
  if (view.trajectories) {
    const c = matcher.controller;
    desiredPts[0].set(c.x.x, 0.02, c.z.x);
    TRAJ_FRAMES.forEach((k, n) => {
      c.predict(k / 60, pred);
      desiredPts[n + 1].set(pred.x, 0.02, pred.z);
      d.arrow(desiredPts[n + 1], q.set(pred.x + Math.sin(pred.yaw) * 0.25, 0.02, pred.z + Math.cos(pred.yaw) * 0.25), DESIRED, 0.06);
    });
    d.polyline(desiredPts, DESIRED);
    matcher.matchedTrajectory(matched);
    matchedPts[0].set(matcher.root.x, 0.03, matcher.root.z);
    matched.forEach((m, n) => matchedPts[n + 1].set(m.x, 0.03, m.z));
    d.polyline(matchedPts, MATCHED);
    for (const m of matchedPts) d.point(m, MATCHED);
    // Character root facing.
    p.set(matcher.root.x, 0.03, matcher.root.z);
    d.arrow(p, q.set(p.x + Math.sin(matcher.root.yaw) * 0.45, 0.03, p.z + Math.cos(matcher.root.yaw) * 0.45), 0xffffff, 0.08);
  }

  const hips = p.set(w[0], 0.9, w[2]);
  if (view.follow) follow.update(hips, frameDt);
  app.focusShadow(hips);

  searchMs += (matcher.lastSearchMs - searchMs) * 0.05;
  readTimer -= frameDt;
  if (readTimer <= 0) {
    readTimer = 0.2;
    const t = db.takes[db.take[matcher.frame]];
    const speed = Math.hypot(mf.rootVel[matcher.frame * 2], mf.rootVel[matcher.frame * 2 + 1]);
    readout.textContent =
      `take    ${t.name}${t.mirrored ? ' (mirrored)' : ''}\n` +
      `        ${t.description}\n` +
      `frame   ${matcher.frame - t.start} / ${t.frames}\n` +
      `cost    continue ${fmt(matcher.currentCost)} · best ${fmt(matcher.bestCost)}\n` +
      `search  ${searchMs.toFixed(2)} ms · ${view.search === 'aabb' ? `${aabbEvaluated} of ` : ''}${candidates} frames\n` +
      `switch  ${matcher.transitions} (${(matcher.transitions / Math.max(1, matcher.time)).toFixed(1)}/s)\n` +
      `speed   ${speed.toFixed(2)} m/s${view.autopilot ? ' · autopilot' : ''}`;
    drawTimeline(timeline, db, matcher.frame);
  }
});

function fmt(c: number): string {
  return Number.isFinite(c) ? c.toFixed(2) : '—';
}

// ---------------------------------------------------------------------------
// Panels and controls

const readout = frame.addPanel('Matching');
readout.style.fontFamily = 'var(--mono)';
readout.style.whiteSpace = 'pre';
let readTimer = 0;
const candidates = mf.matchable.reduce((a, b) => a + b, 0);
const timelinePanel = frame.addPanel('Database (top: captured · bottom: mirrored)');
const timeline = document.createElement('canvas');
timeline.style.width = '100%';
timeline.style.height = '46px';
timelinePanel.appendChild(timeline);

const pane = createPane(frame.controls);
const control = pane.addFolder({ title: 'Control' });
control.addBinding(view, 'autopilot');
control.addBinding(matcher.controller, 'walkSpeed', { label: 'walk m/s', min: 0.8, max: 1.8, step: 0.05 });
control.addBinding(matcher.controller, 'runSpeed', { label: 'run m/s', min: 2, max: 4.2, step: 0.05 });
control.addBinding(matcher.controller, 'velocityHalflife', { label: 'velocity ½-life', min: 0.05, max: 0.8, step: 0.01 });
control.addBinding(matcher.controller, 'facingHalflife', { label: 'facing ½-life', min: 0.05, max: 0.8, step: 0.01 });

const search = pane.addFolder({ title: 'Search' });
search.addBinding(matcher.settings, 'searchInterval', { label: 'every (frames)', min: 1, max: 30, step: 1 });
search
  .addBinding(view, 'search', { label: 'method', options: { 'AABB (exact)': 'aabb', 'brute force': 'brute' } })
  .on('change', () => (matcher.settings.search = view.search === 'aabb' ? searchAABB : searchBrute));
const weights = Object.fromEntries(GROUPS.map((g, i) => [g.name, matcher.settings.weights[i]]));
for (const g of GROUPS) {
  search.addBinding(weights, g.name, { min: 0, max: 3, step: 0.05 }).on('change', () => matcher.setWeights(GROUPS.map((x) => weights[x.name])));
}

const trans = pane.addFolder({ title: 'Transitions' });
trans.addBinding(matcher.settings, 'inertialize', { label: 'inertialize' });
trans.addBinding(matcher.settings, 'halflife', { label: '½-life (s)', min: 0.02, max: 0.4, step: 0.01 });
trans.addBinding(matcher.settings, 'adjust', { label: 'adjust to path' });
trans.addBinding(matcher.settings, 'clamp', { label: 'clamp path' });
trans.addBinding(locker, 'enabled', { label: 'foot locking' }).on('change', () => locker.reset());

const viewFolder = pane.addFolder({ title: 'View' });
viewFolder.addBinding(view, 'trajectories', { label: 'trajectories' });
viewFolder.addBinding(view, 'follow', { label: 'follow camera' });
addSimulationFolder(pane, app.loop);
app.start();
