import * as THREE from 'three';
import loadMujoco from '@mujoco/mujoco';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { readGamepad } from '../../src/input/gamepad';
import { Keyboard } from '../../src/input/keyboard';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { GaitChart } from '../../src/ui/gaitChart';
import { LinePlot } from '../../src/ui/plot';
import { Mlp, type PolicyFile } from './policy';
import { NUM_ACT, NUM_OBS, QuadrupedSim } from './sim';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '13',
  writeup,
  hint: 'Manual: W / S speed · A / D turn · Q / E sidestep · Drag the robot to pull it · Orbit: right-drag or drag the floor',
});

const app = createApp(frame.viewport, { rate: 120, cameraPosition: [1.6, 1.0, 2.0], cameraTarget: [0, 0.25, 0] });
frame.attach(app);

const [mj, policy, xml] = await Promise.all([
  loadMujoco(),
  fetch(new URL('../../assets/rl/policy.json', document.baseURI)).then((r) => r.json() as Promise<PolicyFile>),
  fetch(new URL('../../assets/rl/quadruped.xml', document.baseURI)).then((r) => r.text()),
]);
const sim = new QuadrupedSim(mj, xml, policy);
const mlp = new Mlp(policy);
const CONTROL_DT = policy.dt * policy.decimation; // 50 Hz

// ---------------------------------------------------------------------------------------- rendering

// MuJoCo is z-up; render its geoms in a group rotated so that z → three's y.
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
app.scene.add(world);
const model = sim.model;
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2d333d, roughness: 0.45, metalness: 0.35 });
const legMat = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.5 });
const footMat = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.7 });
const geoms: { index: number; mesh: THREE.Mesh }[] = [];
const types = model.geom_type as Int32Array;
const sizes = model.geom_size as Float64Array;
for (let g = 0; g < model.ngeom; g++) {
  const t = types[g];
  const [s0, s1, s2] = [sizes[g * 3], sizes[g * 3 + 1], sizes[g * 3 + 2]];
  let geo: THREE.BufferGeometry | null = null;
  let mat = legMat;
  if (t === 6) {
    geo = new THREE.BoxGeometry(2 * s0, 2 * s1, 2 * s2);
    mat = bodyMat;
  } else if (t === 2) {
    geo = new THREE.SphereGeometry(s0, 16, 12);
    mat = footMat;
  } else if (t === 3) geo = new THREE.CapsuleGeometry(s0, 2 * s1, 6, 12).rotateX(Math.PI / 2);
  else if (t === 5) {
    geo = new THREE.CylinderGeometry(s0, s0, 2 * s1, 20).rotateX(Math.PI / 2);
    mat = bodyMat;
  }
  if (!geo) continue; // the floor plane: the app's ground stands in for it
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.matrixAutoUpdate = false;
  world.add(mesh);
  geoms.push({ index: g, mesh });
}
// A face on the trunk so the heading reads at a glance.
const visor = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.05), new THREE.MeshStandardMaterial({ color: 0x5fb3ff, emissive: 0x1d4f80 }));
visor.position.set(0.19, 0, 0.01);
geoms.find((g) => types[g.index] === 6)!.mesh.add(visor);

// Render interpolation between 50 Hz control steps.
const prevPos = new Float64Array(model.ngeom * 3);
const prevMat = new Float64Array(model.ngeom * 9);
const snapshot = () => {
  prevPos.set(sim.data.geom_xpos as Float64Array);
  prevMat.set(sim.data.geom_xmat as Float64Array);
};
snapshot();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const m4 = new THREE.Matrix4();
const pa = new THREE.Vector3();
const pb = new THREE.Vector3();
const toQuat = (m: ArrayLike<number>, o: number, q: THREE.Quaternion) =>
  q.setFromRotationMatrix(m4.set(m[o], m[o + 1], m[o + 2], 0, m[o + 3], m[o + 4], m[o + 5], 0, m[o + 6], m[o + 7], m[o + 8], 0, 0, 0, 0, 1));
function drawRobot(alpha: number): void {
  const pos = sim.data.geom_xpos as Float64Array;
  const mat = sim.data.geom_xmat as Float64Array;
  for (const { index: g, mesh } of geoms) {
    pa.set(prevPos[g * 3], prevPos[g * 3 + 1], prevPos[g * 3 + 2]);
    pb.set(pos[g * 3], pos[g * 3 + 1], pos[g * 3 + 2]);
    toQuat(prevMat, g * 9, qa);
    toQuat(mat, g * 9, qb);
    mesh.matrix.compose(pa.lerp(pb, alpha), qa.slerp(qb, alpha), mesh.scale);
  }
}

// ---------------------------------------------------------------------------------------- control

const settings = {
  mode: 'auto' as 'auto' | 'manual',
  maxSpeed: 1.0,
  showCommand: true,
  pushStrength: 1.0,
};
const command = [0, 0, 0];
const target = [0, 0, 0];
const keys = new Keyboard();
// Autopilot programme: [vx, vy, yaw rate, seconds].
const PROGRAMME: [number, number, number, number][] = [
  [0, 0, 0, 2],
  [0.6, 0, 0, 4],
  [1.0, 0, 0.5, 5],
  [0.4, 0, -0.9, 4],
  [0, 0.4, 0, 3],
  [-0.5, 0, 0, 3],
  [0, 0, 1.0, 4],
  [0.8, 0, 0, 4],
];
let programmeT = 0;
let programmeStep = 0;
const last = new Float64Array(NUM_ACT);
const obs = new Float64Array(NUM_OBS);
let action: Float64Array = new Float64Array(NUM_ACT);
let accumulator = 0;
let falls = 0;
let fallenFor = 0;

// Mouse drag: a spring from the trunk to the cursor on a horizontal plane at the grab height.
let dragging = false;
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragPoint = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const trunkWorld = new THREE.Vector3();
function setNdc(e: PointerEvent): void {
  const r = app.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, app.camera);
}
app.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  setNdc(e);
  const hit = raycaster.intersectObjects(geoms.map((g) => g.mesh), false)[0];
  if (!hit) return;
  dragging = true;
  app.controls.enabled = false;
  dragPlane.constant = -hit.point.y;
  dragPoint.copy(hit.point);
});
app.renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  setNdc(e);
  raycaster.ray.intersectPlane(dragPlane, dragPoint);
});
window.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  app.controls.enabled = true;
  sim.setTrunkForce(0, 0, 0);
});

function controlStep(): void {
  // Command: autopilot programme or keyboard / gamepad, eased so steps in the command are not jolts.
  if (settings.mode === 'auto') {
    programmeT += CONTROL_DT;
    if (programmeT >= PROGRAMME[programmeStep][3]) {
      programmeT = 0;
      programmeStep = (programmeStep + 1) % PROGRAMME.length;
    }
    [target[0], target[1], target[2]] = PROGRAMME[programmeStep];
  } else {
    const pad = readGamepad();
    const fwd = keys.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']) + pad.y;
    const turn = keys.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']) - pad.x;
    const side = keys.axis(['KeyE'], ['KeyQ']);
    target[0] = THREE.MathUtils.clamp(fwd, -1, 1) * (fwd < 0 ? 0.6 : settings.maxSpeed);
    target[1] = side * 0.5;
    target[2] = THREE.MathUtils.clamp(turn, -1, 1) * 1.2;
  }
  const k = 1 - Math.exp(-CONTROL_DT / 0.25);
  for (let i = 0; i < 3; i++) command[i] += (target[i] - command[i]) * k;

  if (dragging) {
    // Spring-damper on the trunk (MuJoCo world frame), capped so it pulls rather than throws.
    const p = sim.data.xpos as Float64Array;
    const v = sim.data.qvel as Float64Array;
    const o = sim.trunkBody * 3;
    const tx = dragPoint.x;
    const ty = -dragPoint.z;
    const tz = dragPoint.y;
    let fx = 400 * (tx - p[o]) - 40 * v[0];
    let fy = 400 * (ty - p[o + 1]) - 40 * v[1];
    let fz = 400 * (tz - p[o + 2]) - 40 * v[2];
    const m = Math.hypot(fx, fy, fz);
    if (m > 250) {
      fx *= 250 / m;
      fy *= 250 / m;
      fz *= 250 / m;
    }
    sim.setTrunkForce(fx, fy, fz);
  }

  snapshot();
  sim.observe(command, last, obs);
  action = mlp.act(obs, action);
  sim.applyAction(action);
  last.set(action);

  // A robot on its back stays there; after a second, stand it up again.
  if (sim.upright < 0.3 || sim.height < 0.12) {
    fallenFor += CONTROL_DT;
    if (fallenFor > 1.2) {
      falls++;
      const x = sim.data.qpos[0];
      const y = sim.data.qpos[1];
      sim.reset([x, y, 0.33, 1, 0, 0, 0, ...policy.defaultPose]);
      last.fill(0);
      snapshot();
      fallenFor = 0;
    }
  } else fallenFor = 0;

  // Telemetry.
  const q = sim.data.qpos as Float64Array;
  const qv = sim.data.qvel as Float64Array;
  const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
  const vxBody = Math.cos(yaw) * qv[0] + Math.sin(yaw) * qv[1];
  speedCmd[speedHead] = command[0];
  speedAct[speedHead] = vxBody;
  yawCmd[speedHead] = command[2];
  yawAct[speedHead] = qv[5];
  speedHead = (speedHead + 1) % SPEED_N;
  const pos = sim.data.geom_xpos as Float64Array;
  gait.push(feet.map((g) => pos[g * 3 + 2] < 0.022 + 0.008));
}

app.onFixedUpdate((dt) => {
  accumulator += dt;
  let n = 0;
  while (accumulator >= CONTROL_DT && n < 8) {
    controlStep();
    accumulator -= CONTROL_DT;
    n++;
  }
});

// ---------------------------------------------------------------------------------------- panels

const feet = ['FR_foot', 'FL_foot', 'RR_foot', 'RL_foot'].map((n) => mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, n));
// Panels stack newest on top: add them bottom-up.
const SPEED_N = 300;
const speedCmd = new Float32Array(SPEED_N);
const speedAct = new Float32Array(SPEED_N);
const yawCmd = new Float32Array(SPEED_N);
const yawAct = new Float32Array(SPEED_N);
let speedHead = 0;
const yawPlot = new LinePlot(frame.addPanel('Turn rate (rad/s): command vs actual'), { height: 90, yMin: -1.5, yMax: 1.5, yTicks: [-1, 0, 1], xTickStep: 2, formatX: (x) => `${x - 6}s` });
const speedPlot = new LinePlot(frame.addPanel('Forward speed (m/s): command vs actual'), { height: 100, yMin: -0.8, yMax: 1.4, yTicks: [-0.5, 0, 0.5, 1], xTickStep: 2, formatX: (x) => `${x - 6}s` });
const gaitBody = frame.addPanel('Footfalls (filled = stance)');
const gait = new GaitChart(gaitBody, ['FR', 'FL', 'RR', 'RL'], 200, ['#ff8a3d', '#5fb3ff', '#5fb3ff', '#ff8a3d']);
const ordered = (a: Float32Array) => Float32Array.from({ length: SPEED_N }, (_, i) => a[(speedHead + i) % SPEED_N]);

const follow = createFollow(app, 0.3);
const arrowFrom = new THREE.Vector3();
const arrowTo = new THREE.Vector3();
app.onFrame((_alpha, frameDt) => {
  drawRobot(Math.min(1, accumulator / CONTROL_DT));
  const p = sim.data.xpos as Float64Array;
  const o = sim.trunkBody * 3;
  trunkWorld.set(p[o], p[o + 2], -p[o + 1]);
  follow.update(trunkWorld, frameDt);
  app.focusShadow(trunkWorld);
  if (settings.showCommand) {
    // Commanded velocity in the robot's heading frame, drawn at the trunk.
    const q = sim.data.qpos as Float64Array;
    const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
    const wx = Math.cos(yaw) * command[0] - Math.sin(yaw) * command[1];
    const wy = Math.sin(yaw) * command[0] + Math.cos(yaw) * command[1];
    arrowFrom.copy(trunkWorld).setY(0.02);
    arrowTo.set(arrowFrom.x + wx * 0.6, 0.02, arrowFrom.z - wy * 0.6);
    app.debug.arrow(arrowFrom, arrowTo, 0x4fd18b);
  }
  if (dragging) app.debug.line(trunkWorld, dragPoint, 0xffd166);
  speedPlot.draw([{ values: ordered(speedCmd), dx: 6 / SPEED_N, color: '#7d8590', dashed: true }, { values: ordered(speedAct), dx: 6 / SPEED_N, color: '#4fd18b' }], 6);
  yawPlot.draw([{ values: ordered(yawCmd), dx: 6 / SPEED_N, color: '#7d8590', dashed: true }, { values: ordered(yawAct), dx: 6 / SPEED_N, color: '#5fb3ff' }], 6);
  gait.draw();
  stats.falls = falls;
  sim_.end();
  sim_.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
const ctl = pane.addFolder({ title: 'Control' });
ctl.addBinding(settings, 'mode', { options: { autopilot: 'auto', 'manual (WASD / gamepad)': 'manual' } });
ctl.addBinding(settings, 'maxSpeed', { label: 'max speed', min: 0.3, max: 1.2, step: 0.05 });
ctl.addBinding(settings, 'pushStrength', { label: 'shove (m/s)', min: 0.2, max: 2, step: 0.05 });
ctl.addButton({ title: 'Shove' }).on('click', () => {
  const a = Math.random() * Math.PI * 2;
  sim.shove(Math.cos(a) * settings.pushStrength, Math.sin(a) * settings.pushStrength);
});
ctl.addButton({ title: 'Reset' }).on('click', () => {
  sim.reset();
  last.fill(0);
  snapshot();
});
ctl.addBinding(settings, 'showCommand', { label: 'command arrow' });
const stats = { falls: 0, iteration: policy.iteration };
const info = pane.addFolder({ title: 'Policy', expanded: false });
info.addBinding(stats, 'iteration', { readonly: true, label: 'PPO iterations' });
info.addBinding(stats, 'falls', { readonly: true, format: (v: number) => v.toFixed(0) });
const sim_ = addSimulationFolder(pane, app.loop);
app.start();
