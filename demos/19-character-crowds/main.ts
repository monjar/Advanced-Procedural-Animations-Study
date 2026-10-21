import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createDemoFrame } from '../../src/ui/demoFrame';
import type { Agent, Crowd, Model } from './crowd';
import { buildScenario, SCENARIOS } from './scenarios';
import { WalkerView } from './walkers';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '19',
  writeup,
  hint: 'Click a person to see their velocity space · switch ORCA ↔ social forces · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 60, cameraPosition: [0, 15, 15], cameraTarget: [0, 0, 0] });
frame.attach(app);

const CAMERAS: [number, number, number][] = [
  [0, 15, 15],
  [4, 24, 22],
  [-1, 15, 14],
  [0, 14, 14],
];

// ?scenario=doorway (etc.) opens a scene directly.
const asked = SCENARIOS.findIndex((s) => s.name.startsWith(new URLSearchParams(location.search).get('scenario') ?? '-'));
const settings = { scenario: Math.max(0, asked), model: 'orca' as Model, density: 1, hurry: 1, timeHorizon: 2, arrows: false, slowMotion: false };
const readout = { agents: 0, time: '', overlap: '', turning: '', cpu: '' };

let crowd: Crowd;
let selected: Agent | null = null;
let doneFor = 0;
let cpu = 0;
const walkers = new WalkerView(400);
app.scene.add(walkers.group);
const wallGroup = new THREE.Group();
app.scene.add(wallGroup);
const wallMat = new THREE.MeshStandardMaterial({ color: 0x59606e, roughness: 0.8 });
const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 32), new THREE.MeshBasicMaterial({ color: 0xffd166, side: THREE.DoubleSide }));
ring.rotation.x = -Math.PI / 2;
ring.visible = false;
app.scene.add(ring);

function restart(moveCamera = false): void {
  const s = SCENARIOS[settings.scenario];
  crowd = buildScenario(s, { model: settings.model, timeHorizon: settings.timeHorizon }, settings.density, 7, settings.hurry);
  walkers.reset(crowd.agents);
  wallGroup.clear();
  for (const [x0, y0, x1, y1] of crowd.boxes) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 1.1, y1 - y0), wallMat);
    m.position.set((x0 + x1) / 2, 0.55, (y0 + y1) / 2);
    m.castShadow = m.receiveShadow = true;
    wallGroup.add(m);
  }
  selected = crowd.agents[Math.floor(crowd.agents.length / 3)];
  doneFor = 0;
  readout.agents = crowd.agents.length;
  if (moveCamera) {
    app.camera.position.set(...CAMERAS[settings.scenario]);
    app.controls.target.set(0, 0, 0);
  }
}

app.onFixedUpdate((dt) => {
  const h = settings.slowMotion ? dt * 0.25 : dt;
  const t0 = performance.now();
  crowd.step(h);
  cpu += (performance.now() - t0 - cpu) * 0.05;
  walkers.update(crowd.agents, h);
  const m = crowd.metrics;
  const done = m.arrived === crowd.agents.length || m.time > SCENARIOS[settings.scenario].timeout;
  if (done) {
    doneFor += h;
    if (doneFor > 3) restart();
  }
});

// ---------------------------------------------------------------------------------------- picking

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let downAt = { x: 0, y: 0 };
app.renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
app.renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const r = app.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, app.camera);
  // Nearest agent to the ray at body height.
  let best: Agent | null = null;
  let bestD = 0.8;
  const p = new THREE.Vector3();
  for (const a of crowd.agents) {
    const d = raycaster.ray.distanceToPoint(p.set(a.position.x, 1, a.position.y));
    if (d < bestD) (bestD = d), (best = a);
  }
  if (!best && raycaster.ray.intersectPlane(ground, p)) {
    for (const a of crowd.agents) {
      const d = Math.hypot(a.position.x - p.x, a.position.y - p.z);
      if (d < bestD) (bestD = d), (best = a);
    }
  }
  if (best) selected = best;
});

// ---------------------------------------------------------------------------------------- velocity space

/**
 * The selected agent's velocity space: each neighbour's ORCA half-plane (forbidden side shaded), obstacle
 * half-planes in red, the max-speed disc, the preferred velocity (yellow) and the chosen one (green).
 */
const vsBody = frame.addPanel('Velocity space of the selected person');
const vs = document.createElement('canvas');
vs.style.width = '100%';
vs.style.height = '220px';
vsBody.appendChild(vs);
const vctx = vs.getContext('2d')!;

function drawVelocitySpace(): void {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = Math.max(1, vs.clientWidth);
  const h = 220;
  if (vs.width !== w * dpr) (vs.width = w * dpr), (vs.height = h * dpr);
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.clearRect(0, 0, w, h);
  if (!selected) return;
  const vmax = crowd.params.maxSpeed;
  const S = (h / 2 - 12) / (vmax * 1.15);
  const cx = w / 2;
  const cy = h / 2;
  // Scene x → right, scene z → down (as seen from above, camera looking −z).
  const X = (x: number) => cx + x * S;
  const Y = (y: number) => cy + y * S;
  vctx.strokeStyle = '#3a404c';
  vctx.beginPath();
  vctx.moveTo(0, cy);
  vctx.lineTo(w, cy);
  vctx.moveTo(cx, 0);
  vctx.lineTo(cx, h);
  vctx.stroke();
  vctx.strokeStyle = '#8a93a6';
  vctx.beginPath();
  vctx.arc(cx, cy, vmax * S, 0, Math.PI * 2);
  vctx.stroke();
  if (settings.model === 'orca') {
    const { lines, numObstLines } = crowd.linesFor(selected, 1 / 60);
    lines.forEach((l, i) => {
      const obst = i < numObstLines;
      const far = 10;
      const a = { x: l.point.x - l.direction.x * far, y: l.point.y - l.direction.y * far };
      const b = { x: l.point.x + l.direction.x * far, y: l.point.y + l.direction.y * far };
      // Forbidden side: to the right of the direction (x, y) → (y, −x).
      const nx = l.direction.y;
      const ny = -l.direction.x;
      vctx.fillStyle = obst ? 'rgba(255, 92, 92, 0.1)' : 'rgba(95, 179, 255, 0.05)';
      vctx.beginPath();
      vctx.moveTo(X(a.x), Y(a.y));
      vctx.lineTo(X(b.x), Y(b.y));
      vctx.lineTo(X(b.x + nx * far), Y(b.y + ny * far));
      vctx.lineTo(X(a.x + nx * far), Y(a.y + ny * far));
      vctx.closePath();
      vctx.fill();
      vctx.strokeStyle = obst ? '#ff5c5c' : '#5fb3ff';
      vctx.beginPath();
      vctx.moveTo(X(a.x), Y(a.y));
      vctx.lineTo(X(b.x), Y(b.y));
      vctx.stroke();
    });
  }
  const arrow = (v: { x: number; y: number }, color: string) => {
    vctx.strokeStyle = vctx.fillStyle = color;
    vctx.lineWidth = 2;
    vctx.beginPath();
    vctx.moveTo(cx, cy);
    vctx.lineTo(X(v.x), Y(v.y));
    vctx.stroke();
    vctx.beginPath();
    vctx.arc(X(v.x), Y(v.y), 3.5, 0, Math.PI * 2);
    vctx.fill();
    vctx.lineWidth = 1;
  };
  arrow(selected.preferred, '#ffd166');
  arrow(selected.velocity, '#4fd18b');
  vctx.fillStyle = '#8a93a6';
  vctx.font = '11px system-ui, sans-serif';
  vctx.fillText(`${vmax.toFixed(1)} m/s`, cx + vmax * S * 0.72 + 4, cy - vmax * S * 0.72);
}

// ---------------------------------------------------------------------------------------- frame

const from = new THREE.Vector3();
const to = new THREE.Vector3();
app.onFrame(() => {
  if (selected) {
    ring.visible = true;
    ring.position.set(selected.position.x, 0.02, selected.position.y);
    const g = selected.route[selected.leg].p;
    app.debug.line(from.set(selected.position.x, 0.05, selected.position.y), to.set(g.x, 0.05, g.y), 0xffd166);
  }
  if (settings.arrows) {
    for (const a of crowd.agents) {
      from.set(a.position.x, 0.05, a.position.y);
      app.debug.line(from, to.set(a.position.x + a.velocity.x * 0.6, 0.05, a.position.y + a.velocity.y * 0.6), 0x4fd18b);
    }
  }
  drawVelocitySpace();
  const m = crowd.metrics;
  readout.time = `${m.time.toFixed(1)} s · ${m.arrived}/${crowd.agents.length} arrived`;
  readout.overlap = `${m.overlapSeconds.toFixed(1)} pair·s · deepest ${(m.maxPenetration * 100).toFixed(1)} cm`;
  readout.turning = `${m.turning.toFixed(2)} rad/m`;
  readout.cpu = `${cpu.toFixed(2)} ms/step`;
  simHooks.end();
  simHooks.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
pane.addBinding(settings, 'scenario', { options: Object.fromEntries(SCENARIOS.map((s, i) => [s.name, i])) }).on('change', () => restart(true));
pane.addBinding(settings, 'model', { options: { 'ORCA (velocity obstacles)': 'orca', 'social forces (Helbing)': 'social' } }).on('change', () => restart());
pane.addBinding(settings, 'density', { label: 'people ×', min: 0.25, max: 3, step: 0.25 }).on('change', () => restart());
pane.addBinding(settings, 'hurry', { label: 'hurry ×', min: 0.6, max: 2.5, step: 0.1 }).on('change', () => restart());
pane.addBinding(settings, 'timeHorizon', { label: 'ORCA horizon (s)', min: 0.3, max: 6, step: 0.1 }).on('change', (ev) => (crowd.params.timeHorizon = ev.value));
pane.addButton({ title: 'Restart' }).on('click', () => restart());
const view = pane.addFolder({ title: 'View' });
view.addBinding(settings, 'arrows', { label: 'velocities' });
view.addBinding(settings, 'slowMotion', { label: 'slow motion ×¼' });
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'agents', { readonly: true, format: (v: number) => v.toFixed(0) });
info.addBinding(readout, 'time', { readonly: true });
info.addBinding(readout, 'overlap', { readonly: true, label: 'overlap' });
info.addBinding(readout, 'turning', { readonly: true, label: 'wiggle' });
info.addBinding(readout, 'cpu', { readonly: true, label: 'crowd CPU' });
const simHooks = addSimulationFolder(pane, app.loop);

restart(true);
app.start();
