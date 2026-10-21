import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createNoise2D } from '../../src/math/noise';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import { AudioIn } from './audio';
import { Face, type FaceState } from './face';
import { GazeModel, type GazeMode } from './gaze';
import { analyze, createMapper, dominant, emptyWeights, mapToVisemes, VisemeSmoother, vowelCoordinates, type Features } from './lipsync';
import { synthesize, VISEMES, type Viseme } from './voice';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '15',
  writeup,
  hint: 'Move the cursor (follow mode) · Say it: the face lip-syncs to its own voice · Orbit: drag',
});

const app = createApp(frame.viewport, {
  rate: 120,
  ground: false,
  cameraPosition: [0.4, 0.2, 4.6],
  cameraTarget: [0, 0.05, 0],
  background: 0x14161b,
});
frame.attach(app);
app.controls.minDistance = 2;
app.controls.maxDistance = 9;
app.sun.position.set(2.5, 4, 6);

const face = new Face();
app.scene.add(face.root);
const fill = new THREE.PointLight(0xffd9c0, 6, 10);
fill.position.set(-3, 0.5, 3);
app.scene.add(fill);

const settings = {
  gaze: 'listening' as 'listening' | 'track' | 'idle',
  text: 'Hello there. I am a face made of code, and I can say almost anything you type.',
  voice: 'low' as 'low' | 'high',
  lipsync: 'analysis' as 'analysis' | 'truth',
  smile: 0.15,
  brow: 0,
  pupil: 0.45,
  showGaze: false,
};

const gaze = new GazeModel(11);
const audio = new AudioIn();
const mapper = createMapper();
const smoother = new VisemeSmoother();
smoother.reset();
const { noise } = createNoise2D(4);
let lastFeatures: Features | null = null;

// ---------------------------------------------------------------------------------------- input

const pointer = new THREE.Vector2(0, 0);
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -1.4);
const cursorPoint = new THREE.Vector3(0, 0.1, 3);
app.renderer.domElement.addEventListener('pointermove', (e) => {
  const r = app.renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, app.camera);
  raycaster.ray.intersectPlane(plane, cursorPoint);
});

const tmp = new THREE.Vector3();
const mid = new THREE.Vector3();
/** Direction from between the eyes to `p`, as yaw/pitch (degrees) in the body frame, plus its distance. */
function anglesTo(p: THREE.Vector3): { yaw: number; pitch: number; dist: number } {
  face.root.updateMatrixWorld(true);
  face.eyeMid(mid);
  tmp.subVectors(p, mid);
  return {
    yaw: THREE.MathUtils.radToDeg(Math.atan2(tmp.x, tmp.z)),
    pitch: THREE.MathUtils.radToDeg(Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z))),
    dist: tmp.length(),
  };
}

// ---------------------------------------------------------------------------------------- simulation

let fixationDistance = 4;
app.onFixedUpdate((dt) => {
  const partner = anglesTo(app.camera.position);
  gaze.partner.yaw = partner.yaw;
  gaze.partner.pitch = partner.pitch;
  const speaking = audio.source === 'voice' || audio.source === 'file';
  const mode: GazeMode = settings.gaze === 'track' ? 'track' : speaking ? 'talking' : settings.gaze;
  gaze.mode = mode;
  if (mode === 'track') {
    const t = anglesTo(cursorPoint);
    gaze.target.yaw = t.yaw;
    gaze.target.pitch = t.pitch;
    fixationDistance = t.dist;
  } else {
    fixationDistance = mode === 'idle' ? 3 : partner.dist;
  }
  gaze.update(dt);
  face.breathing += dt * 2 * Math.PI * 0.25;
});

// ---------------------------------------------------------------------------------------- panels

const visemeBody = frame.addPanel('Visemes: audio analysis vs phoneme truth');
const strip = document.createElement('canvas');
strip.style.width = '100%';
strip.style.height = '64px';
visemeBody.appendChild(strip);
const STRIP_SECONDS = 5;
const stripHistory: { t: number; analysis: Viseme; truth: Viseme | null }[] = [];
const COLORS: Record<Viseme, string> = {
  sil: '#2a2f38', PP: '#ff4d4d', FF: '#ff8a3d', TH: '#ffb46b', DD: '#c08bff', kk: '#9b87ff', CH: '#ff6bd5', SS: '#ff9ee6',
  RR: '#7aa2ff', aa: '#4fd18b', E: '#a3e36b', I: '#ffd166', O: '#5fb3ff', U: '#3ad1d1',
};
const legend = document.createElement('div');
legend.className = 'legend';
legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 10px;font:11px ui-monospace,monospace;color:#9aa3ad;margin-top:6px';
for (const v of VISEMES) legend.insertAdjacentHTML('beforeend', `<span><i style="display:inline-block;width:9px;height:9px;background:${COLORS[v]};margin-right:4px;border-radius:2px"></i>${v}</span>`);
visemeBody.appendChild(legend);

function drawStrip(now: number): void {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = strip.clientWidth || 280;
  const h = 64;
  if (strip.width !== w * dpr) {
    strip.width = w * dpr;
    strip.height = h * dpr;
  }
  const g = strip.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.font = '10px ui-monospace, monospace';
  g.fillStyle = '#7d8590';
  g.fillText('audio', 2, 18);
  g.fillText('truth', 2, 48);
  const x0 = 40;
  for (let i = 0; i < stripHistory.length - 1; i++) {
    const a = stripHistory[i];
    const b = stripHistory[i + 1];
    const xa = x0 + ((a.t - (now - STRIP_SECONDS)) / STRIP_SECONDS) * (w - x0);
    const xb = x0 + ((b.t - (now - STRIP_SECONDS)) / STRIP_SECONDS) * (w - x0);
    g.fillStyle = COLORS[a.analysis];
    g.fillRect(xa, 6, xb - xa + 0.5, 20);
    if (a.truth) {
      g.fillStyle = COLORS[a.truth];
      g.fillRect(xa, 36, xb - xa + 0.5, 20);
    }
  }
}

const vowelBody = frame.addPanel('Vowel space: F1 (jaw) vs F2 (lips)');
const chart = document.createElement('canvas');
chart.style.width = '100%';
chart.style.height = '150px';
vowelBody.appendChild(chart);
const trail: [number, number][] = [];
const PROTOTYPES: [Viseme, number, number][] = [
  ['aa', 1.0, 0.18],
  ['E', 0.6, 0.75],
  ['I', 0.0, 1.0],
  ['O', 0.67, 0.0],
  ['U', 0.07, 0.02],
];
function drawVowels(): void {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = chart.clientWidth || 280;
  const h = 150;
  if (chart.width !== w * dpr) {
    chart.width = w * dpr;
    chart.height = h * dpr;
  }
  const g = chart.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  // Phonetic convention: F2 decreasing left → right (front vowels left), F1 increasing downward (open at bottom).
  const px = (spread: number) => 24 + (1 - spread) * (w - 40);
  const py = (open: number) => 12 + open * (h - 30);
  g.strokeStyle = '#3a3f48';
  g.strokeRect(px(1.1), py(-0.1), px(-0.1) - px(1.1), py(1.1) - py(-0.1));
  g.font = '10px ui-monospace, monospace';
  g.fillStyle = '#7d8590';
  g.fillText('spread ← F2 → rounded', 26, h - 4);
  g.save();
  g.translate(10, h / 2 + 30);
  g.rotate(-Math.PI / 2);
  g.fillText('open ↓ F1', 0, 0);
  g.restore();
  for (const [v, open, spread] of PROTOTYPES) {
    g.fillStyle = COLORS[v];
    g.beginPath();
    g.arc(px(spread), py(open), 9, 0, Math.PI * 2);
    g.globalAlpha = 0.25;
    g.fill();
    g.globalAlpha = 1;
    g.fillText(v, px(spread) - 5, py(open) + 3);
  }
  trail.forEach(([open, spread], i) => {
    g.fillStyle = `rgba(255,255,255,${(i + 1) / trail.length})`;
    g.fillRect(px(spread) - 1.5, py(open) - 1.5, 3, 3);
  });
}

const gazeBody = frame.addPanel('Gaze yaw (°): world (gaze) vs in head (eyes) · blinks');
const gazePlot = new LinePlot(gazeBody, { height: 110, yMin: -45, yMax: 45, yTicks: [-30, 0, 30], xTickStep: 2, formatX: (x) => `${x - 6}s` });
const GAZE_N = 360;
const gazeYaw = new Float32Array(GAZE_N);
const eyeYaw = new Float32Array(GAZE_N);
const blinkTrace = new Float32Array(GAZE_N);
let gazeHead = 0;

// ---------------------------------------------------------------------------------------- frame

const state: FaceState = {
  visemes: emptyWeights(),
  smile: 0,
  brow: 0,
  blink: 0,
  eyeYaw: 0,
  eyePitch: 0,
  fixationDistance: 4,
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  pupil: 0.5,
};
let clock = 0;
let browProsody = 0;
let nod = 0;
let prevDb = -90;
const fixMarker = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
app.scene.add(fixMarker);

app.onFrame((_alpha, frameDt) => {
  const dt = Math.min(0.1, frameDt);
  clock += dt;

  // --- Lip-sync.
  const samples = audio.frame();
  let target = emptyWeights();
  target.sil = 1;
  const truth = audio.truth();
  if (samples) {
    const f = analyze(samples);
    lastFeatures = f;
    target = mapToVisemes(f, mapper, dt);
    if (f.voiced && f.f1 && f.f2) {
      trail.push(vowelCoordinates(f.f1, f.f2, mapper.scale));
      if (trail.length > 50) trail.shift();
    }
    // Prosody: brows lift with pitch rises (Cavé et al. 1996); the head nods on loudness onsets.
    const level = Math.max(0, f.db - mapper.floor - 8) / 22;
    if (f.voiced && f.f0 > 0) browProsody += ((f.f0 / (audio.source === 'voice' && settings.voice === 'high' ? 210 : 120) - 1) * 3 - browProsody) * Math.min(1, dt * 6);
    else browProsody *= Math.exp(-dt * 3);
    if (f.db - prevDb > 6 && level > 0.3) nod = Math.min(1, nod + 0.6);
    prevDb = f.db;
    if (settings.lipsync === 'truth' && truth) {
      target = emptyWeights();
      target[truth] = 1;
    }
  } else {
    lastFeatures = null;
    browProsody *= Math.exp(-dt * 3);
  }
  nod *= Math.exp(-dt * 5);
  const w = smoother.update(target, dt);
  for (const v of VISEMES) state.visemes[v] = w[v];
  if (samples) {
    stripHistory.push({ t: clock, analysis: dominant(target), truth });
  }
  while (stripHistory.length && stripHistory[0].t < clock - STRIP_SECONDS) stripHistory.shift();

  // --- Gaze, head, lids.
  const n = (k: number, speed: number) => noise(clock * speed, k * 17.3);
  state.eyeYaw = gaze.eye.yaw;
  state.eyePitch = gaze.eye.pitch;
  state.blink = gaze.blink;
  state.fixationDistance = fixationDistance;
  // Head: the gaze model's head plus slow idle sway and speech nods. The eyes compensate only for the gaze
  // model's head, so sway moves the gaze slightly, as it does in people.
  state.headYaw = gaze.head.yaw + 2.2 * n(1, 0.18);
  state.headPitch = gaze.head.pitch + 1.6 * n(2, 0.22) - 3 * nod;
  state.headRoll = 1.5 * n(3, 0.15) + 0.06 * gaze.head.yaw;
  state.smile = settings.smile;
  state.brow = THREE.MathUtils.clamp(settings.brow + Math.max(0, browProsody) * 0.6, -1, 1);
  state.pupil = settings.pupil;
  face.update(state);

  if (settings.showGaze) {
    face.root.updateMatrixWorld(true);
    face.eyeMid(mid);
    const yaw = THREE.MathUtils.degToRad(gaze.gaze.yaw);
    const pitch = THREE.MathUtils.degToRad(gaze.gaze.pitch);
    tmp.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    fixMarker.position.copy(mid).addScaledVector(tmp, fixationDistance);
    for (const eye of face.eyes) app.debug.line(eye.getWorldPosition(new THREE.Vector3()), fixMarker.position, 0xffd166);
  }
  fixMarker.visible = settings.showGaze;

  // --- Panels.
  gazeYaw[gazeHead] = gaze.gaze.yaw - gaze.partner.yaw * (gaze.mode === 'track' ? 0 : 1);
  eyeYaw[gazeHead] = gaze.eye.yaw;
  blinkTrace[gazeHead] = -40 + gaze.blink * 15;
  gazeHead = (gazeHead + 1) % GAZE_N;
  const ordered = (a: Float32Array) => Float32Array.from({ length: GAZE_N }, (_, i) => a[(gazeHead + i) % GAZE_N]);
  gazePlot.draw(
    [
      { values: ordered(gazeYaw), dx: 6 / GAZE_N, color: '#5fb3ff' },
      { values: ordered(eyeYaw), dx: 6 / GAZE_N, color: '#ff8a3d' },
      { values: ordered(blinkTrace), dx: 6 / GAZE_N, color: '#7d8590', dashed: true },
    ],
    6,
  );
  drawStrip(clock);
  drawVowels();
  status.refresh();
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
const look = pane.addFolder({ title: 'Gaze' });
look.addBinding(settings, 'gaze', {
  label: 'mode',
  options: { 'look at me (listening)': 'listening', 'follow the cursor': 'track', 'look around': 'idle' },
});
look.addBinding(gaze, 'saccadeRate', { label: 'saccade rate', min: 0.3, max: 3, step: 0.05 });
look.addBinding(gaze, 'blinkRate', { label: 'blink rate', min: 0, max: 3, step: 0.05 });
look.addBinding(settings, 'showGaze', { label: 'show fixation' });

const speech = pane.addFolder({ title: 'Speech' });
speech.addBinding(settings, 'text', { label: 'text' });
speech.addBinding(settings, 'voice', { options: { 'low (120 Hz)': 'low', 'high (210 Hz)': 'high' } });
speech.addBinding(settings, 'lipsync', { label: 'lip-sync from', options: { 'audio analysis': 'analysis', 'phoneme timeline': 'truth' } });
speech.addButton({ title: 'Say it' }).on('click', () => {
  const u = synthesize(settings.text, { f0: settings.voice === 'high' ? 210 : 120 });
  mapper.scale = 1;
  audio.speak(u);
});
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'audio/*';
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void audio.playFile(f).catch((e) => console.warn('Could not play that file:', e));
  fileInput.value = '';
});
speech.addButton({ title: 'Play an audio file…' }).on('click', () => fileInput.click());
speech.addButton({ title: 'Use the microphone' }).on('click', () => {
  audio.useMic().catch((e) => console.warn('Microphone unavailable:', e));
});
speech.addButton({ title: 'Stop' }).on('click', () => audio.stop());

const expr = pane.addFolder({ title: 'Expression' });
expr.addBinding(settings, 'smile', { min: 0, max: 1, step: 0.01 });
expr.addBinding(settings, 'brow', { label: 'brows', min: -1, max: 1, step: 0.01 });
expr.addBinding(settings, 'pupil', { label: 'pupils', min: 0, max: 1, step: 0.01 });

const readout = { source: 'none', f0: '–', formants: '–', viseme: 'sil' };
const status = pane.addFolder({ title: 'Analysis', expanded: false });
status.addBinding(readout, 'source', { readonly: true });
status.addBinding(readout, 'f0', { readonly: true, label: 'pitch' });
status.addBinding(readout, 'formants', { readonly: true, label: 'F1 / F2' });
status.addBinding(readout, 'viseme', { readonly: true });
const origRefresh = status.refresh.bind(status);
status.refresh = () => {
  readout.source = audio.source;
  const f = lastFeatures;
  readout.f0 = f?.voiced ? `${f.f0.toFixed(0)} Hz` : '–';
  readout.formants = f?.voiced && f.f1 ? `${f.f1.toFixed(0)} / ${f.f2.toFixed(0)} Hz` : '–';
  readout.viseme = dominant(state.visemes);
  origRefresh();
};

const sim = addSimulationFolder(pane, app.loop);
app.start();
