import * as THREE from 'three';
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { createApp } from '../../src/core/app';
import { createPane } from '../../src/core/gui';
import { parseMotionDB } from '../../src/anim/mmdb';
import { SegmentBatch } from '../../src/rig/segments';
import { LinePlot } from '../../src/ui/plot';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { COUNT, fromMediaPipe, LM, record, TRACKER_NOISE, USED, type Landmarks, type Recording } from './landmarks';
import { ADULT, Ema, Locomotion, measure, OneEuro, PUPPET, retarget, type Proportions } from './puppet';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '28',
  writeup,
  hint: 'Turn on your webcam, or watch a mocap take seen through a simulated tracker · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 30, cameraPosition: [2.6, 1.6, 3.6], cameraTarget: [0, 0.9, 0] });
frame.attach(app);

const buf = await fetch(new URL('../../assets/mocap/cmu16-mm.bin', document.baseURI)).then((r) => r.arrayBuffer());
const db = parseMotionDB(buf, false);

// ---------------------------------------------------------------------------------------- settings

/** The synthetic person's playlist: walks, turns, a stop, standing, runs. */
const PLAYLIST = ['16_32', '16_17', '16_33', '16_02', '16_13', '16_35', '16_57', '16_09', '16_19'];

const BODIES: Record<string, Proportions> = {
  adult: ADULT,
  child: { hipHalf: 0.07, thigh: 0.26, shin: 0.27, foot: 0.09, spine: 0.32, neck: 0.18, shoulderHalf: 0.12, upperArm: 0.18, forearm: 0.15 },
  'long legs': { ...ADULT, thigh: 0.56, shin: 0.62, foot: 0.16, spine: 0.38 },
  giant: Object.fromEntries(Object.entries(ADULT).map(([k, v]) => [k, v * 1.7])) as unknown as Proportions,
};

const settings = {
  source: 'mocap' as 'mocap' | 'webcam',
  filter: 'oneEuro' as 'none' | 'ema' | 'oneEuro',
  minCutoff: 1.5,
  beta: 4,
  alpha: 0.35,
  noise: 1,
  body: 'measured' as keyof typeof BODIES | 'measured',
  locomotion: true,
  mirror: true,
  ghost: true,
  raw: true,
};
const readout = { status: 'mocap take, simulated tracker', error: '', jitter: '', walked: '' };

let oneEuro = new OneEuro(COUNT * 3, settings.minCutoff, settings.beta);
let ema = new Ema(COUNT * 3, settings.alpha);
const filtered = new Float64Array(COUNT * 3);
function resetFilters(): void {
  oneEuro = new OneEuro(COUNT * 3, settings.minCutoff, settings.beta);
  ema = new Ema(COUNT * 3, settings.alpha);
}
function applyFilter(raw: Landmarks, dt: number): Landmarks {
  if (settings.filter === 'oneEuro') return oneEuro.filter(raw, dt, filtered);
  if (settings.filter === 'ema') return ema.filter(raw, dt, filtered);
  filtered.set(raw);
  return filtered;
}

// ---------------------------------------------------------------------------------------- synthetic source

let takes: Recording[] = [];
let measured: Proportions = ADULT;
/** The mocap subject's true proportions, for drawing the real person. */
let subject: Proportions = ADULT;
function recordTakes(): void {
  const k = settings.noise;
  const noise = { ...TRACKER_NOISE, jitter: TRACKER_NOISE.jitter * k, outlier: k > 0 ? TRACKER_NOISE.outlier : 0, outlierSize: TRACKER_NOISE.outlierSize * Math.min(1, k) };
  takes = PLAYLIST.map((id, i) => record(db, [id], noise, 3 + i));
  // The person's proportions as a tracker would estimate them: medians over the noisy landmarks.
  measured = measure(takes.flatMap((t) => t.noisy));
  subject = measure(takes.flatMap((t) => t.truth));
}
recordTakes();

const loco = new Locomotion();
const play = { take: 0, frame: 0, anchor: [0, 0] as [number, number], walked: 0 };
function startTake(i: number): void {
  play.take = i % takes.length;
  play.frame = 0;
  play.anchor = [loco.root[0], loco.root[2]];
  play.walked = 0;
  loco.cut();
  resetFilters();
}

// ---------------------------------------------------------------------------------------- tracking

type V = [number, number, number];
let world: V[] = [];
let prevWorld: V[] = [];
let ghost: V[] | null = null;
let rawWorld: V[] = [];
let lastRaw: Landmarks = new Float64Array(COUNT * 3);
let legsVisible = true;
const errStat = { err: 0, jit: 0, n: 0 };
const history: Landmarks[] = [];

const PLOT_N = 120;
const plotRaw = new Float64Array(PLOT_N);
const plotFilt = new Float64Array(PLOT_N);
const plotTruth = new Float64Array(PLOT_N);
function pushPlot(raw: Landmarks, f: Landmarks, truth: Landmarks | null): void {
  plotRaw.copyWithin(0, 1);
  plotFilt.copyWithin(0, 1);
  plotTruth.copyWithin(0, 1);
  const i = LM.leftWrist * 3 + 1;
  plotRaw[PLOT_N - 1] = raw[i];
  plotFilt[PLOT_N - 1] = f[i];
  plotTruth[PLOT_N - 1] = truth ? truth[i] : NaN;
}

function body(): Proportions {
  return settings.body === 'measured' ? measured : BODIES[settings.body];
}

/** One tracker frame: filter, retarget, locomotion. `truth` is known only for the synthetic source. */
function track(raw: Landmarks, truth: Landmarks | null, dt: number): void {
  lastRaw = raw;
  const f = applyFilter(raw, dt);
  if (!legsVisible) standIn(f);
  const pose = retarget(f, body());
  loco.enabled = settings.locomotion && legsVisible;
  prevWorld = world.map((p) => [...p] as V);
  world = loco.update(pose, dt).map((p) => [...p] as V);
  if (prevWorld.length !== world.length) prevWorld = world;
  // Raw landmarks drawn around the puppet's hips, for scale against the filtered pose.
  rawWorld = USED.map((lm) => [loco.root[0] + raw[lm * 3], loco.root[1] + raw[lm * 3 + 1], loco.root[2] + raw[lm * 3 + 2]] as V);
  pushPlot(raw, f, truth);
  if (truth) {
    history.push(Float64Array.from(f));
    if (history.length > 3) history.shift();
    for (const lm of USED)
      for (let c = 0; c < 3; c++) {
        const i = lm * 3 + c;
        errStat.err += (f[i] - truth[i]) ** 2;
        if (history.length === 3) errStat.jit += (history[2][i] - 2 * history[1][i] + history[0][i]) ** 2;
        errStat.n++;
      }
  }
}

// Synthetic source, at the tracker's 30 Hz.
app.onFixedUpdate((dt) => {
  if (settings.source !== 'mocap') return;
  let t = takes[play.take];
  if (play.frame >= t.frames) {
    startTake(play.take + 1);
    t = takes[play.take];
  }
  const k = play.frame++;
  const before = [loco.root[0], loco.root[2]];
  track(t.noisy[k], t.truth[k], dt);
  if (k > 0) play.walked += Math.hypot(loco.root[0] - before[0], loco.root[2] - before[1]);
  // The real person, placed where the take started from the puppet.
  if (settings.ghost) {
    const lm = t.truth[k];
    const pose = retarget(lm, subject);
    const floor = -Math.min(...[3, 4, 7, 8].map((j) => pose[j][1])) + 0.02;
    const rx = play.anchor[0] + t.rootPath[k][0] - t.rootPath[0][0];
    const rz = play.anchor[1] + t.rootPath[k][1] - t.rootPath[0][1];
    ghost = pose.map((p) => [rx + p[0], floor + p[1], rz + p[2]] as V);
  } else ghost = null;
  const truthWalked = t.rootPath.slice(1, k + 1).reduce((s, p, i) => s + Math.hypot(p[0] - t.rootPath[i][0], p[1] - t.rootPath[i][1]), 0);
  readout.walked = `${play.walked.toFixed(2)} m · person ${truthWalked.toFixed(2)} m`;
  if (errStat.n > 0) {
    readout.error = `${(Math.sqrt(errStat.err / errStat.n) * 100).toFixed(2)} cm RMS`;
    readout.jitter = `${(Math.sqrt(errStat.jit / errStat.n) * 1000).toFixed(1)} mm/frame²`;
  }
  readout.status = `${PLAYLIST[play.take]} · ${db.takes.find((x) => x.name === PLAYLIST[play.take])!.description}`;
});

// ---------------------------------------------------------------------------------------- webcam source

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
let landmarker: PoseLandmarker | null = null;
let stream: MediaStream | null = null;
let lastVideoTime = -1;
let lastDetect = 0;
let imagePoints: { x: number; y: number }[] | null = null;
const camRaw = new Float64Array(COUNT * 3);
const camSamples: Landmarks[] = [];

async function startWebcam(): Promise<void> {
  readout.status = 'asking for the camera…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.srcObject = stream;
    await video.play();
    readout.status = 'loading the pose model (~9 MB)…';
    if (!landmarker) {
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    }
    settings.source = 'webcam';
    camSamples.length = 0;
    loco.reset();
    resetFilters();
    ghost = null;
    errStat.err = errStat.jit = errStat.n = 0;
    readout.error = readout.jitter = '— (no ground truth for a webcam)';
    readout.walked = '';
    readout.status = 'step back until your whole body is in view';
    webcamButton.title = 'Stop webcam';
  } catch (e) {
    stopWebcam();
    readout.status = `webcam unavailable: ${(e as Error).message}`;
  }
  pane.refresh();
}

function stopWebcam(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  imagePoints = null;
  settings.source = 'mocap';
  legsVisible = true;
  webcamButton.title = 'Use my webcam';
  loco.reset();
  startTake(0);
  readout.status = 'mocap take, simulated tracker';
  pane.refresh();
}

/** Swap the person's left and right (and x), so the puppet moves like a mirror image. */
function mirror(lm: Landmarks): void {
  for (let i = 11; i < COUNT; i += 2)
    for (let c = 0; c < 3; c++) {
      const a = lm[i * 3 + c];
      lm[i * 3 + c] = lm[(i + 1) * 3 + c];
      lm[(i + 1) * 3 + c] = a;
    }
  for (let i = 0; i < COUNT; i++) lm[i * 3] = -lm[i * 3];
}

/** Legs out of view (sitting at a desk): stand the puppet on straight legs, under its hips. */
function standIn(lm: Landmarks): void {
  for (const [hip, knee, ankle, heel, toe] of [
    [LM.leftHip, LM.leftKnee, LM.leftAnkle, LM.leftHeel, LM.leftFootIndex],
    [LM.rightHip, LM.rightKnee, LM.rightAnkle, LM.rightHeel, LM.rightFootIndex],
  ]) {
    const set = (j: number, dy: number, dz: number) => {
      lm[j * 3] = lm[hip * 3];
      lm[j * 3 + 1] = lm[hip * 3 + 1] + dy;
      lm[j * 3 + 2] = lm[hip * 3 + 2] + dz;
    };
    set(knee, -0.4, 0.01);
    set(ankle, -0.8, 0);
    set(heel, -0.85, -0.05);
    set(toe, -0.86, 0.12);
  }
}

function detect(): void {
  if (settings.source !== 'webcam' || !landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();
  const res = landmarker.detectForVideo(video, now);
  const dt = lastDetect ? Math.min(0.2, (now - lastDetect) / 1000) : 1 / 30;
  lastDetect = now;
  const w = res.worldLandmarks[0];
  if (!w) {
    imagePoints = null;
    readout.status = 'no one in view';
    return;
  }
  imagePoints = res.landmarks[0];
  fromMediaPipe(w, camRaw);
  if (settings.mirror) mirror(camRaw);
  const legs = [LM.leftKnee, LM.rightKnee, LM.leftAnkle, LM.rightAnkle, LM.leftFootIndex, LM.rightFootIndex];
  legsVisible = Math.min(...legs.map((j) => w[j].visibility ?? 0)) > 0.5;
  readout.status = legsVisible ? 'tracking, whole body' : 'tracking, legs out of view: standing in';
  // Your proportions: medians over the first two seconds with the whole body in view.
  if (legsVisible && camSamples.length < 60) {
    camSamples.push(Float64Array.from(camRaw));
    if (camSamples.length === 60) measured = measure(camSamples);
  }
  track(camRaw, null, dt);
}

// ---------------------------------------------------------------------------------------- rendering

const batch = new SegmentBatch(64, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
app.scene.add(batch);
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const lerped: V[] = [];
const SIDE: Record<number, number> = {};
for (const j of [1, 2, 3, 4, 12, 13, 14]) SIDE[j] = 0x5fb3ff;
for (const j of [5, 6, 7, 8, 15, 16, 17]) SIDE[j] = 0xff8a3d;

function drawFigure(points: V[], scaleR: number): void {
  for (let j = 1; j < points.length; j++) {
    const p = PUPPET.parents[j];
    if (j === 10 || j === 11) continue;
    a.set(...points[p]);
    b.set(...points[j]);
    const torso = j === 9 || j === 1 || j === 5 || j === 12 || j === 15;
    batch.segment(a, b, (torso ? 0.055 : 0.04) * scaleR, SIDE[j] ?? 0xe6e6e6);
  }
  a.set(...points[9]);
  b.set(...points[11]);
  batch.segment(a, a.clone().lerp(b, 0.35), 0.035 * scaleR, 0xe6e6e6);
  batch.joint(b, 0.11 * scaleR, 0xe6e6e6);
}

const follow = new THREE.Vector3(0, 0.9, 0);
const planted = new THREE.Vector3();
app.onFrame((alpha, frameDt) => {
  detect();
  if (!world.length) return;
  const t = settings.source === 'mocap' ? alpha : 1;
  lerped.length = 0;
  for (let j = 0; j < world.length; j++) lerped.push(world[j].map((v, c) => prevWorld[j][c] + (v - prevWorld[j][c]) * t) as V);
  batch.begin();
  drawFigure(lerped, Math.max(0.6, body().neck / ADULT.neck));
  batch.commit();
  if (ghost)
    for (let j = 1; j < ghost.length; j++) {
      if (j === 10) continue;
      app.debug.line(a.set(...ghost[PUPPET.parents[j]]), b.set(...ghost[j]), 0x8a93a6);
    }
  if (settings.raw) for (const p of rawWorld) app.debug.point(a.set(...p), 0xff5c5c);
  if (loco.enabled) {
    const s = loco.stance ? 8 : 4;
    const ankle = loco.stance ? 7 : 3;
    planted.set((lerped[s][0] + lerped[ankle][0]) / 2, 0.005, (lerped[s][2] + lerped[ankle][2]) / 2);
    app.debug.circle(planted, new THREE.Vector3(0, 1, 0), 0.09, 0xffd166, 20);
  }
  // Follow the puppet across the floor.
  const goal = a.set(lerped[0][0], 0.9, lerped[0][2]);
  const k = 1 - Math.exp(-frameDt * 2.5);
  const delta = b.copy(goal).sub(follow).multiplyScalar(k);
  follow.add(delta);
  app.controls.target.add(delta);
  app.camera.position.add(delta);
  app.focusShadow(follow);
  drawPanels();
});

// ---------------------------------------------------------------------------------------- panels

const plot = new LinePlot(frame.addPanel('Left wrist height (m): raw · filtered · true'), { height: 100, yMin: -0.6, yMax: 0.6, formatY: (y) => y.toFixed(2), xTickStep: 1, formatX: (x) => `${(x - 4).toFixed(0)}s` });
const viewBody = frame.addPanel('Tracker view');
const view = document.createElement('canvas');
view.style.width = '100%';
view.style.height = '170px';
viewBody.appendChild(view);
const BONES_2D: [number, number][] = [
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftShoulder, LM.leftElbow],
  [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow],
  [LM.rightElbow, LM.rightWrist],
  [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip],
  [LM.leftHip, LM.rightHip],
  [LM.leftHip, LM.leftKnee],
  [LM.leftKnee, LM.leftAnkle],
  [LM.leftAnkle, LM.leftFootIndex],
  [LM.rightHip, LM.rightKnee],
  [LM.rightKnee, LM.rightAnkle],
  [LM.rightAnkle, LM.rightFootIndex],
];

function drawPanels(): void {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = Math.max(1, view.clientWidth);
  const h = 170;
  if (view.width !== w * dpr) (view.width = w * dpr), (view.height = h * dpr);
  const g = view.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (settings.source === 'webcam' && video.readyState >= 2) {
    // The camera image (mirrored, as people expect to see themselves) with the tracker's image landmarks.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const s = Math.min(w / vw, h / vh);
    const ox = (w - vw * s) / 2;
    g.save();
    g.translate(ox + vw * s, 0);
    g.scale(-s, s);
    g.drawImage(video, 0, 0);
    g.restore();
    if (imagePoints) {
      const P = (i: number) => [ox + (1 - imagePoints![i].x) * vw * s, imagePoints![i].y * vh * s];
      g.strokeStyle = '#ffd166';
      g.lineWidth = 2;
      for (const [i, j] of BONES_2D) {
        g.beginPath();
        g.moveTo(...(P(i) as [number, number]));
        g.lineTo(...(P(j) as [number, number]));
        g.stroke();
      }
    }
  } else {
    // Front view of the landmarks: raw (dots) and filtered (lines), hip-centred.
    const P = (lm: Landmarks, i: number) => [w / 2 - lm[i * 3] * 85, h * 0.47 - lm[i * 3 + 1] * 85] as [number, number];
    g.fillStyle = '#ff5c5c';
    for (const i of USED) {
      const [x, y] = P(lastRaw, i);
      g.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    g.strokeStyle = '#ffd166';
    g.lineWidth = 2;
    for (const [i, j] of BONES_2D) {
      g.beginPath();
      g.moveTo(...P(filtered, i));
      g.lineTo(...P(filtered, j));
      g.stroke();
    }
    g.fillStyle = '#8a93a6';
    g.font = '10px system-ui, sans-serif';
    g.fillText('red: tracker landmarks · yellow: filtered', 6, h - 6);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const arr of [plotRaw, plotFilt]) for (const v of arr) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  const pad = Math.max(0.05, (hi - lo) * 0.15);
  plot.setRange(lo - pad, hi + pad);
  plot.draw(
    [
      { values: plotRaw, dx: 1 / 30, color: '#ff5c5c' },
      { values: plotFilt, dx: 1 / 30, color: '#ffd166' },
      ...(settings.source === 'mocap' ? [{ values: plotTruth, dx: 1 / 30, color: '#e6e6e6', dashed: true }] : []),
    ],
    PLOT_N / 30,
  );
}

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
const webcamButton = pane.addButton({ title: 'Use my webcam' });
webcamButton.on('click', () => (settings.source === 'webcam' ? stopWebcam() : void startWebcam()));
pane.addBinding(readout, 'status', { readonly: true, label: 'source' });
const fFolder = pane.addFolder({ title: 'Filter' });
const resetStats = () => (errStat.err = errStat.jit = errStat.n = 0);
fFolder.addBinding(settings, 'filter', { options: { none: 'none', 'moving average (EMA)': 'ema', 'One Euro': 'oneEuro' } }).on('change', () => {
  resetFilters();
  resetStats();
  syncFilter();
});
const mc = fFolder.addBinding(settings, 'minCutoff', { min: 0.1, max: 5, step: 0.1, label: 'min cutoff (Hz)' }).on('change', () => ((oneEuro.minCutoff = settings.minCutoff), resetStats()));
const be = fFolder.addBinding(settings, 'beta', { min: 0, max: 20, step: 0.5, label: 'speed coefficient β' }).on('change', () => ((oneEuro.beta = settings.beta), resetStats()));
const al = fFolder.addBinding(settings, 'alpha', { min: 0.05, max: 1, step: 0.05, label: 'EMA α' }).on('change', () => ((ema.alpha = settings.alpha), resetStats()));
function syncFilter(): void {
  mc.hidden = be.hidden = settings.filter !== 'oneEuro';
  al.hidden = settings.filter !== 'ema';
}
syncFilter();
fFolder.addBinding(settings, 'noise', { min: 0, max: 2, step: 0.25, label: 'tracker noise ×' }).on('change', () => {
  recordTakes();
  startTake(play.take);
  resetStats();
});
const cFolder = pane.addFolder({ title: 'Character' });
cFolder.addBinding(settings, 'body', { options: { 'your proportions (measured)': 'measured', ...Object.fromEntries(Object.keys(BODIES).map((k) => [k, k])) } });
cFolder.addBinding(settings, 'locomotion', { label: 'walk from the feet' });
cFolder.addBinding(settings, 'mirror', { label: 'mirror webcam' });
cFolder.addBinding(settings, 'ghost', { label: 'show real person' });
cFolder.addBinding(settings, 'raw', { label: 'show raw landmarks' });
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'error', { readonly: true, label: 'filter error' });
info.addBinding(readout, 'jitter', { readonly: true, label: 'jitter' });
info.addBinding(readout, 'walked', { readonly: true, label: 'walked (take)' });

startTake(0);
app.start();
