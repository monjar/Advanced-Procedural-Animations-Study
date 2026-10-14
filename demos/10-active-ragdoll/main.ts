import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import type { ClipData } from '../../src/anim/clip';
import { FixedStepper, initRapier, RAPIER } from '../../src/physics/rapier';
import { SegmentBatch } from '../../src/rig/segments';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import { Ragdoll, type TargetMode } from './ragdoll';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '10',
  writeup,
  hint: 'Click a body part to hit it · Shove button for a repeatable push · Orbit: drag',
});

const app = createApp(frame.viewport, { rate: 60, cameraPosition: [3.2, 1.8, 2.6], cameraTarget: [0, 0.9, 0] });
frame.attach(app);

await initRapier();
const clip = (await (await fetch(new URL('../../assets/mocap/cmu-02_01-walk.json', document.baseURI))).json()) as ClipData;
const ragdoll = new Ragdoll(clip);

const view = { mode: 'walk' as TargetMode, ghost: true, follow: true, hitStrength: 120, shoveSide: true };
ragdoll.setMode(view.mode);
ragdoll.reset();

// ---------------------------------------------------------------------------
// Physics at a fixed 240 Hz under the display-synced loop, rendered interpolated.

let alpha = 0;
const stepper = new FixedStepper(ragdoll.dt, () => ragdoll.step());
app.onFixedUpdate((dt) => {
  alpha = stepper.advance(dt);
});

// ---------------------------------------------------------------------------
// Rendering: capsules coloured by how much strength each body has left.

const batch = new SegmentBatch(64, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }));
app.scene.add(batch);
const FULL = new THREE.Color(0xd5d9e0);
const WEAK = new THREE.Color(0xff5d5d);
const LIMP = new THREE.Color(0x7d8592);
const col = new THREE.Color();
const pos = new THREE.Vector3();
const rot = new THREE.Quaternion();
const curPos = new THREE.Vector3();
const curRot = new THREE.Quaternion();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const follow = createFollow(app, 0.35);

app.onFrame((_alpha, frameDt) => {
  batch.begin();
  for (const body of ragdoll.bodies) {
    const t = body.rb.translation();
    const r = body.rb.rotation();
    pos.lerpVectors(body.prevPos, curPos.set(t.x, t.y, t.z), alpha);
    rot.slerpQuaternions(body.prevRot, curRot.set(r.x, r.y, r.z, r.w), alpha);
    a.copy(body.a).applyQuaternion(rot).add(pos);
    b.copy(body.b).applyQuaternion(rot).add(pos);
    const strength = Math.min(body.pin, body.muscle);
    col.copy(ragdoll.state === 'fallen' ? LIMP : WEAK).lerp(FULL, ragdoll.state === 'fallen' ? 0 : strength);
    batch.segment(a, b, body.def.radius, col);
    batch.joint(a, body.def.radius, col);
    batch.joint(b, body.def.radius, col);
  }
  batch.commit();

  const d = app.debug;
  if (view.ghost) {
    const p = ragdoll.target;
    p.bones.forEach((bone, i) => {
      const parent = clip.joints[i].parent;
      if (parent < 0) return;
      d.line(bone.getWorldPosition(a), p.bones[parent].getWorldPosition(b), 0x5fb3ff);
    });
  }
  const pelvis = ragdoll.bodies[0].rb.translation();
  pos.set(pelvis.x, 0.9, pelvis.z);
  if (view.follow) follow.update(pos, frameDt);
  app.focusShadow(pos);

  // Pelvis tracking error history.
  plotTimer += frameDt;
  if (plotTimer >= 1 / 30) {
    plotTimer = 0;
    errors.push(ragdoll.targetPosition(0, b).distanceTo(pelvis as THREE.Vector3Like));
    if (errors.length > 300) errors.shift();
    plot.draw([{ values: errors, dx: 1 / 30, color: '#ff8a3d' }], 10);
    status.textContent =
      `state   ${ragdoll.state}${ragdoll.state !== 'active' ? ` (${ragdoll.stateTime.toFixed(1)} s)` : ''}\n` +
      `pelvis  ${(errors[errors.length - 1] * 100).toFixed(1)} cm off target\n` +
      `joints  ${(ragdoll.jointDrift() * 1000).toFixed(1)} mm max drift`;
  }
});

// ---------------------------------------------------------------------------
// Hitting: a click (not a drag) raycasts the colliders and applies an impulse along the ray.

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down: { x: number; y: number } | null = null;
app.renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
app.renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  down = null;
  const rect = app.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, app.camera);
  const o = raycaster.ray.origin;
  const dir = raycaster.ray.direction;
  // Ragdoll colliders only (membership any, filter group 1), not the floor.
  const hit = ragdoll.world.castRay(new RAPIER.Ray(o, dir), 100, true, undefined, 0xffff0001);
  if (!hit) return;
  const body = ragdoll.bodies.findIndex((bd) => bd.rb.handle === hit.collider.parent()?.handle);
  if (body < 0) return;
  const point = new THREE.Vector3().copy(o).addScaledVector(dir, hit.timeOfImpact);
  ragdoll.hit(body, point, dir.clone().setY(Math.max(0, dir.y)).normalize().multiplyScalar(view.hitStrength));
});

function shove(): void {
  const chest = ragdoll.bodies[2].rb.translation();
  const r = ragdoll.bodies[0].rb.rotation();
  // From the character's side (or front): along its local x (z).
  const dir = new THREE.Vector3(view.shoveSide ? 1 : 0, 0, view.shoveSide ? 0 : -1).applyQuaternion(rot.set(r.x, r.y, r.z, r.w)).setY(0).normalize();
  ragdoll.hit(2, new THREE.Vector3(chest.x, chest.y, chest.z), dir.multiplyScalar(view.hitStrength));
}

// ---------------------------------------------------------------------------
// Panels and controls

const status = frame.addPanel('Ragdoll');
status.style.fontFamily = 'var(--mono)';
status.style.whiteSpace = 'pre';
const plotPanel = frame.addPanel('Pelvis off target (m), last 10 s');
const plot = new LinePlot(plotPanel, { height: 90, yMin: 0, yMax: 0.5, yTicks: [0, 0.25, 0.5], xTickStep: 2, formatX: (x) => `${x.toFixed(0)}s` });
const errors: number[] = [];
let plotTimer = 0;

const pane = createPane(frame.controls);
const target = pane.addFolder({ title: 'Target' });
target.addBinding(view, 'mode', { options: { 'walk (CMU 02)': 'walk', stand: 'stand' } }).on('change', () => {
  ragdoll.setMode(view.mode);
});
target.addButton({ title: 'Reset' }).on('click', () => {
  ragdoll.targetOffset.set(0, 0, 0);
  ragdoll.target.time = 0;
  ragdoll.reset();
  errors.length = 0;
});

const strength = pane.addFolder({ title: 'Strength' });
strength.addBinding(ragdoll.settings, 'muscle', { label: 'muscles', min: 0, max: 1.5, step: 0.05 });
strength.addBinding(ragdoll.settings, 'pin', { label: 'pins (assist)', min: 0, max: 1, step: 0.05 });
strength.addBinding(ragdoll.settings, 'regain', { label: 'regain (s)', min: 0.3, max: 5, step: 0.1 });

const hits = pane.addFolder({ title: 'Hits' });
hits.addBinding(view, 'hitStrength', { label: 'impulse N·s', min: 10, max: 400, step: 5 });
hits.addBinding(view, 'shoveSide', { label: 'shove from side' });
hits.addButton({ title: 'Shove' }).on('click', shove);
hits.addBinding(ragdoll.settings, 'autoFall', { label: 'fall when down' });
hits.addBinding(ragdoll.settings, 'limpTime', { label: 'limp (s)', min: 0.5, max: 6, step: 0.1 });
hits.addBinding(ragdoll.settings, 'recoverTime', { label: 'get up (s)', min: 0.3, max: 4, step: 0.1 });

const viewFolder = pane.addFolder({ title: 'View' });
viewFolder.addBinding(view, 'ghost', { label: 'target pose' });
viewFolder.addBinding(view, 'follow', { label: 'follow camera' });
addSimulationFolder(pane, app.loop);
app.start();
