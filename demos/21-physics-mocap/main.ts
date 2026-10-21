import * as THREE from 'three';
import loadMujoco from '@mujoco/mujoco';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { MujocoView, mjToThree } from '../../src/physics/mujocoView';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import { Mlp } from '../13-rl-locomotion/policy';
import { MimicSim, NUM_ACT, NUM_OBS, Reference, type ClipFile, type MimicPolicyFile } from './mimic';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '21',
  writeup,
  hint: 'Shove it with the buttons or drag it · turn the policy off to see plain mocap tracking fall · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 60, cameraPosition: [3.4, 1.9, 3.8], cameraTarget: [0, 0.9, 0] });
frame.attach(app);

const base = new URL('../../assets/mimic/', document.baseURI);
const [mj, xml, clips] = await Promise.all([
  loadMujoco(),
  fetch(new URL('humanoid.xml', base)).then((r) => r.text()),
  fetch(new URL('clips.json', base)).then((r) => r.json() as Promise<ClipFile>),
]);
const policies: Record<string, MimicPolicyFile> = {};
for (const name of Object.keys(clips.clips)) {
  // A clip without a trained policy has no file (some servers answer with an HTML page instead of a 404).
  const r = await fetch(new URL(`policy-${name}.json`, base)).catch(() => null);
  if (r?.ok && (r.headers.get('content-type') ?? '').includes('json')) policies[name] = (await r.json()) as MimicPolicyFile;
}
const available = Object.keys(policies);

const settings = { clip: available[0], policy: true, shove: 0.6, ghost: true, slowMotion: false };
const readout = { speed: '', tracking: '', falls: 0 };

let ref = new Reference(clips.clips[settings.clip], clips.fps);
let sim = new MimicSim(mj, xml, ref, policies[settings.clip]);
let mlp = new Mlp(policies[settings.clip] as never);
const obs = new Float64Array(NUM_OBS);
const normed = new Float64Array(NUM_OBS);
const zero = new Float64Array(NUM_ACT);

// ---------------------------------------------------------------------------------------- rendering

const skin = new THREE.MeshStandardMaterial({ color: 0xd5d9e0, roughness: 0.45 });
const ghostMat = new THREE.MeshStandardMaterial({ color: 0x5fb3ff, transparent: true, opacity: 0.22, depthWrite: false });
let view = new MujocoView(sim.model, sim.data, () => skin);
app.scene.add(view.group);
let ghostData = new mj.MjData(sim.model);
let ghost = new MujocoView(sim.model, ghostData, () => ghostMat);
for (const m of ghost.meshes) m.mesh.castShadow = false;
app.scene.add(ghost.group);

function setClip(name: string): void {
  app.scene.remove(view.group, ghost.group);
  sim.dispose();
  ghostData.delete();
  ref = new Reference(clips.clips[name], clips.fps);
  sim = new MimicSim(mj, xml, ref, policies[name]);
  mlp = new Mlp(policies[name] as never);
  view = new MujocoView(sim.model, sim.data, () => skin);
  ghostData = new mj.MjData(sim.model);
  ghost = new MujocoView(sim.model, ghostData, () => ghostMat);
  for (const m of ghost.meshes) m.mesh.castShadow = false;
  app.scene.add(view.group, ghost.group);
  fallenFor = 0;
}

// ---------------------------------------------------------------------------------------- control loop

const P = policies[settings.clip];
const CONTROL_DT = P.decimation * P.dt;
let accumulator = 0;
let fallenFor = 0;
const N_TRACE = 300;
const errTrace = new Float32Array(N_TRACE);
let traceHead = 0;

function controlStep(): void {
  const policy = policies[settings.clip];
  sim.observe(obs);
  if (settings.policy) {
    for (let i = 0; i < NUM_OBS; i++) normed[i] = Math.min(5, Math.max(-5, (obs[i] - policy.obsMean[i]) / policy.obsStd[i]));
    sim.applyAction(mlp.act(normed));
  } else sim.applyAction(zero);
}

app.onFixedUpdate((dt) => {
  accumulator += settings.slowMotion ? dt * 0.25 : dt;
  view.snapshot();
  let n = 0;
  while (accumulator >= CONTROL_DT && n < 8) {
    if (dragging) applyDrag();
    controlStep();
    accumulator -= CONTROL_DT;
    n++;
    // Pose tracking error: RMS over the 28 joints against the clip (degrees).
    const r = sim.refAt(sim.t);
    let e = 0;
    for (let i = 7; i < 35; i++) e += (sim.data.qpos[i] - r[i]) ** 2;
    errTrace[traceHead] = (Math.sqrt(e / 28) * 180) / Math.PI;
    traceHead = (traceHead + 1) % N_TRACE;
  }
  // The reference ghost walks along with the character (re-anchored each step: the policy only ever cared about
  // the motion in its own heading frame, not the mocap's place in the world).
  if (!sim.fallen) sim.reanchor();
  if (sim.fallen) {
    fallenFor += dt;
    if (fallenFor > 1.5) {
      // Stand back up where it fell, at the clip's current phase.
      const x = sim.data.qpos[0];
      const y = sim.data.qpos[1];
      sim.offset = [0, 0];
      sim.offsetYaw = 0;
      const t = sim.ref.awayFromSeam(sim.t);
      sim.reset(t);
      const r = sim.refAt(t);
      sim.offset = [x - r[0], y - r[1]];
      sim.reset(t);
      view.snapshot();
      readout.falls++;
      fallenFor = 0;
    }
  } else fallenFor = 0;
});

// ---------------------------------------------------------------------------------------- drag

let dragging = false;
const dragPoint = new THREE.Vector3();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const setRay = (e: PointerEvent) => {
  const r = app.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, app.camera);
};
app.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  setRay(e);
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
  setRay(e);
  raycaster.ray.intersectPlane(dragPlane, dragPoint);
});
window.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  app.controls.enabled = true;
  sim.data.xfrc_applied.fill(0);
});
function applyDrag(): void {
  // A spring on the pelvis toward the drag point (three (x, y, z) → MuJoCo (x, −z, y)), capped at 300 N.
  const p = sim.data.xpos;
  const v = sim.data.qvel;
  let fx = 500 * (dragPoint.x - p[3]) - 60 * v[0];
  let fy = 500 * (-dragPoint.z - p[4]) - 60 * v[1];
  let fz = 500 * (dragPoint.y - p[5]) - 60 * v[2];
  const m = Math.hypot(fx, fy, fz);
  if (m > 300) (fx *= 300 / m), (fy *= 300 / m), (fz *= 300 / m);
  const f = sim.data.xfrc_applied;
  f[6] = fx;
  f[7] = fy;
  f[8] = fz;
}

// ---------------------------------------------------------------------------------------- frame

const plot = new LinePlot(frame.addPanel('Pose tracking error vs the mocap (RMS over 28 joints, °)'), { height: 90, yMin: 0, yMax: 30, yTicks: [0, 10, 20, 30], xTickStep: 3, formatX: (x) => `${(x - N_TRACE * CONTROL_DT).toFixed(0)}s` });
const follow = createFollow(app, 0.4);
const pelvis = new THREE.Vector3();
app.onFrame((_a, frameDt) => {
  view.update(Math.min(1, accumulator / CONTROL_DT));
  ghost.group.visible = settings.ghost;
  if (settings.ghost) {
    const r = sim.refAt(sim.t);
    for (let i = 0; i < 35; i++) ghostData.qpos[i] = r[i];
    mj.mj_kinematics(sim.model, ghostData);
    ghost.snapshot();
    ghost.update(1);
  }
  const p = sim.data.xpos;
  mjToThree(p[3], p[4], p[5], pelvis);
  follow.update(pelvis, frameDt);
  app.focusShadow(pelvis);
  if (dragging) app.debug.line(pelvis, dragPoint, 0xffd166);
  const v = sim.data.qvel;
  readout.speed = `${Math.hypot(v[0], v[1]).toFixed(2)} m/s (clip: ${(Math.hypot(clips.clips[settings.clip].cycle.dx, clips.clips[settings.clip].cycle.dy) / ref.period).toFixed(2)})`;
  const ordered = Float32Array.from({ length: N_TRACE }, (_, i) => errTrace[(traceHead + i) % N_TRACE]);
  plot.draw([{ values: ordered, dx: CONTROL_DT, color: '#ffd166' }], N_TRACE * CONTROL_DT);
  let recent = 0;
  for (let i = 1; i <= 30; i++) recent += errTrace[(traceHead - i + N_TRACE) % N_TRACE];
  readout.tracking = `${(recent / 30).toFixed(1)}° RMS`;
  simHooks.end();
  simHooks.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
if (available.length > 1) pane.addBinding(settings, 'clip', { options: Object.fromEntries(available.map((k) => [`${k} (CMU ${clips.clips[k].take})`, k])) }).on('change', (ev) => setClip(ev.value));
pane.addBinding(settings, 'policy', { label: 'learned policy' });
const push = pane.addFolder({ title: 'Shove' });
push.addBinding(settings, 'shove', { min: 0.1, max: 1.5, step: 0.05, label: 'strength (m/s)' });
const shove = (angle: number) => {
  const q = sim.data.qpos;
  const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6])) + angle;
  sim.data.qvel[0] += Math.cos(yaw) * settings.shove;
  sim.data.qvel[1] += Math.sin(yaw) * settings.shove;
};
push.addButton({ title: 'from behind' }).on('click', () => shove(0));
push.addButton({ title: 'from the front' }).on('click', () => shove(Math.PI));
push.addButton({ title: 'from the left' }).on('click', () => shove(-Math.PI / 2));
push.addButton({ title: 'from the right' }).on('click', () => shove(Math.PI / 2));
const viewF = pane.addFolder({ title: 'View' });
viewF.addBinding(settings, 'ghost', { label: 'mocap reference' });
viewF.addBinding(settings, 'slowMotion', { label: 'slow motion ×¼' });
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'speed', { readonly: true });
info.addBinding(readout, 'tracking', { readonly: true });
info.addBinding(readout, 'falls', { readonly: true, format: (v: number) => v.toFixed(0) });
pane.addButton({ title: 'Restart' }).on('click', () => {
  sim.offset = [0, 0];
  sim.offsetYaw = 0;
  sim.reset(sim.ref.awayFromSeam(0));
  view.snapshot();
});
const simHooks = addSimulationFolder(pane, app.loop);
app.start();
