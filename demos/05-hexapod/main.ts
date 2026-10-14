import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { Keyboard } from '../../src/input/keyboard';
import { SegmentBatch } from '../../src/rig/segments';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { GaitChart } from '../../src/ui/gaitChart';
import { Spider, DEFAULT_SETTINGS, type Gait } from './spider';
import { World } from './world';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '05',
  writeup,
  hint: 'Manual mode: W / S walk · A / D turn · Orbit: drag · Zoom: scroll',
});

const app = createApp(frame.viewport, {
  rate: 60,
  ground: false,
  cameraPosition: [4.5, 4.2, 7.5],
  cameraTarget: [0, 0.5, 0],
});
frame.attach(app);

const world = new World('playground');
app.scene.add(world.group);

const settings = {
  mode: 'auto' as 'auto' | 'manual',
  camera: 'chase' as 'chase' | 'follow' | 'free',
  showTargets: true,
  showProbes: false,
  showPlane: false,
};

const spider = new Spider(world.rays, new THREE.Vector3(0, 0, 3), { ...DEFAULT_SETTINGS });

// ---------------------------------------------------------------------------
// Visuals

const carapace = new THREE.MeshStandardMaterial({ color: 0x24282f, roughness: 0.35, metalness: 0.2 });
const accent = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.4 });
const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0xffb020, emissiveIntensity: 0.8 });

const body = new THREE.Group();
{
  const thorax = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), carapace);
  thorax.scale.set(0.22, 0.11, 0.3);
  const abdomen = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), carapace);
  abdomen.scale.set(0.27, 0.22, 0.36);
  abdomen.position.set(0, 0.1, -0.52);
  const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.025, 8, 32), accent);
  stripe.position.set(0, 0.14, -0.52);
  stripe.rotation.x = Math.PI / 2 - 0.35;
  stripe.scale.set(1.05, 1.3, 1);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), carapace);
  head.position.set(0, 0.03, 0.3);
  body.add(thorax, abdomen, stripe, head);
  for (const [x, y, r] of [
    [0.045, 0.08, 0.025],
    [-0.045, 0.08, 0.025],
    [0.08, 0.06, 0.016],
    [-0.08, 0.06, 0.016],
  ]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), eyeMat);
    eye.position.set(x, y, 0.39);
    body.add(eye);
  }
  body.traverse((o) => (o.castShadow = true));
}
app.scene.add(body);

const legBatch = new SegmentBatch(32, carapace, accent);
app.scene.add(legBatch);

// ---------------------------------------------------------------------------
// Control

const keys = new Keyboard();
const waypoints = [
  [3.5, 1.5],
  [3.5, -3.5],
  [-1, -4.5],
  [-1, -10],
  [-7, -8],
  [-7, -1],
  [-4.5, 2.5],
  [-4.5, 6],
  [5.5, 4.5],
  [6, 0],
].map(([x, z]) => new THREE.Vector3(x, 0, z));
let wp = 0;
const steer = new THREE.Vector3();

app.onFixedUpdate((dt) => {
  if (settings.mode === 'manual') {
    const move = keys.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    const turn = keys.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    spider.update(dt, move, turn);
  } else {
    const target = waypoints[wp];
    const dx = target.x - spider.position.x;
    const dz = target.z - spider.position.z;
    if (Math.hypot(dx, dz) < 1.0) wp = (wp + 1) % waypoints.length;
    // On steep surfaces keep walking straight: steering toward a point behind a wall would turn the
    // spider back down. Over the top it re-acquires the waypoint.
    if (spider.up.y > 0.7) spider.update(dt, 1, 0, steer.set(dx, 0, dz));
    else spider.update(dt, 1, 0);
  }
  chart.push(spider.legs.map((l) => !l.stepping));
});

// ---------------------------------------------------------------------------
// Rendering

const follow = createFollow(app, 0.25);
const chaseDir = new THREE.Vector3(0, 0, 1);
const chasePos = new THREE.Vector3();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const PROBE_COLORS = [0x5fb3ff, 0x4fd18b, 0xffd166];

app.onFrame((_alpha, frameDt) => {
  body.position.copy(spider.position);
  body.quaternion.copy(spider.quaternion);

  legBatch.begin();
  for (const leg of spider.legs) {
    const hipBase = spider.toWorld(leg.hipLocal, tmp);
    legBatch.segment(hipBase, leg.hip, 0.032);
    legBatch.joint(leg.hip, 0.04);
    legBatch.segment(leg.hip, leg.ik.mid, 0.03);
    legBatch.joint(leg.ik.mid, 0.034);
    legBatch.segment(leg.ik.mid, leg.ik.end, 0.02);
    legBatch.joint(leg.ik.end, 0.022);
  }
  legBatch.commit();

  const d = app.debug;
  if (settings.showTargets) {
    for (const leg of spider.legs) {
      d.point(leg.target, leg.targetFound ? 0x4fd18b : 0xff4d4d);
      if (!leg.stepping) d.line(leg.planted, leg.target, 0x6b7280);
      else d.line(leg.foot, leg.to, 0xffd166);
    }
  }
  if (settings.showProbes) {
    for (const leg of spider.legs) {
      if (leg.probe >= 0) d.line(spider.toWorld(leg.hipLocal, tmp), leg.target, PROBE_COLORS[leg.probe]);
    }
    if (spider.probes.ground) d.line(spider.position, spider.probes.ground, 0x9b87ff);
    if (spider.probes.wall) d.line(spider.position, spider.probes.wall, 0xff4d4d);
  }
  if (settings.showPlane) {
    d.polyline(spider.legs.map((l) => l.foot), 0x5fb3ff, true);
    d.arrow(spider.position, tmp2.copy(spider.position).addScaledVector(spider.up, 0.8), 0x5fb3ff);
  }

  if (settings.camera === 'chase') {
    // Stay behind the spider's horizontal heading; on walls keep the last heading.
    tmp.set(spider.forward.x, 0, spider.forward.z);
    if (tmp.lengthSq() > 0.09 && spider.up.y > 0.6) chaseDir.lerp(tmp.normalize(), 1 - Math.exp(-frameDt * 2)).normalize();
    chasePos.copy(spider.position).addScaledVector(chaseDir, -4.2).add(tmp.set(0, 2.8, 0));
    const k = 1 - Math.exp(-frameDt * 2.5);
    app.camera.position.lerp(chasePos, k);
    app.controls.target.lerp(spider.position, 1 - Math.exp(-frameDt * 6));
  } else {
    follow.enabled = settings.camera === 'follow';
    follow.update(spider.position, frameDt);
  }
  app.focusShadow(spider.position);
  chart.draw();
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------
// Controls

const chartBody = frame.addPanel('Footfalls (filled = stance)');
const chart = new GaitChart(chartBody, ['L1', 'L2', 'L3', 'R3', 'R2', 'R1'], 240, [
  '#ff8a3d',
  '#5fb3ff',
  '#ff8a3d',
  '#5fb3ff',
  '#ff8a3d',
  '#5fb3ff',
]);

const pane = createPane(frame.controls);
const ctl = pane.addFolder({ title: 'Control' });
ctl.addBinding(settings, 'mode', { options: { 'auto wander': 'auto', 'manual (WASD)': 'manual' } });
ctl.addBinding(settings, 'camera', { options: { chase: 'chase', 'follow (keep orbit)': 'follow', free: 'free' } });
ctl.addButton({ title: 'Reset position' }).on('click', () => {
  spider.reset(new THREE.Vector3(0, 0, 3));
  wp = 0;
});

const gait = pane.addFolder({ title: 'Gait' });
gait.addBinding(spider.settings, 'gait', { options: { tripod: 'tripod', ripple: 'ripple', wave: 'wave' } as Record<Gait, Gait> });
gait.addBinding(spider.settings, 'speed', { min: 0.2, max: 3, step: 0.05 });
gait.addBinding(spider.settings, 'turnRate', { label: 'turn rate', min: 0.5, max: 5, step: 0.1 });
gait.addBinding(spider.settings, 'stepThreshold', { label: 'step threshold', min: 0.08, max: 0.5, step: 0.01 });
gait.addBinding(spider.settings, 'stepHeight', { label: 'step height', min: 0, max: 0.5, step: 0.01 });
gait.addBinding(spider.settings, 'overshoot', { min: 0, max: 1.5, step: 0.05 });
gait.addBinding(spider.settings, 'bodyHeight', { label: 'body height', min: 0.2, max: 0.6, step: 0.01 });

const dbg = pane.addFolder({ title: 'Debug', expanded: false });
dbg.addBinding(settings, 'showTargets', { label: 'foot targets' });
dbg.addBinding(settings, 'showProbes', { label: 'raycast probes' });
dbg.addBinding(settings, 'showPlane', { label: 'foot plane' });

const sim = addSimulationFolder(pane, app.loop);
app.start();
