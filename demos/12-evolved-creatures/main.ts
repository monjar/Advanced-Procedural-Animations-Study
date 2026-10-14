import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import { DEFAULT_GA, GeneticAlgorithm } from './ga.ts';
import { validate, type Genome } from './genome.ts';
import { EVAL } from './phenotype.ts';
import { WorkerPool, type Recording } from './pool.ts';
import writeup from './README.md?raw';

interface Champion {
  name: string;
  fitness: number;
  duration: number;
  generations: number;
  genome: Genome;
}

const frame = createDemoFrame({
  id: '12',
  writeup,
  hint: 'Evolution runs in background workers — watch the chart · Pick what to show in the controls · Orbit: drag',
});

const app = createApp(frame.viewport, { rate: 60, cameraPosition: [4, 2.6, 5], cameraTarget: [0, 0.4, 0] });
frame.attach(app);

const champions = (await (await fetch(new URL('../../assets/creatures/champions.json', document.baseURI))).json()) as Champion[];
const pool = new WorkerPool();
let ga = new GeneticAlgorithm({ ...DEFAULT_GA, seed: (Math.random() * 2 ** 31) | 0 });

const SHOW_BEST = -1;
const settings = {
  evolve: true,
  show: champions.length ? 0 : SHOW_BEST,
  population: DEFAULT_GA.population,
  mutation: DEFAULT_GA.mutationRate,
  trail: true,
};

// ---------------------------------------------------------------------------
// Playback of recorded runs (the physics happens in a worker).

const MAX_BODIES = 16;
const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ roughness: 0.55 }), MAX_BODIES);
boxes.castShadow = true;
boxes.receiveShadow = true;
boxes.count = 0;
app.scene.add(boxes);
const ROOT = new THREE.Color(0xff8a3d);
const LIMB = new THREE.Color(0x5fb3ff);
const m4 = new THREE.Matrix4();
const pos = new THREE.Vector3();
const rot = new THREE.Quaternion();
const scl = new THREE.Vector3();
const com = new THREE.Vector3();
const follow = createFollow(app, 0.25);
const lastCom = new THREE.Vector3();
let lastFrame = -1;
let recording: Recording | null = null;
let recordingLabel = '';
let playTime = 0;
const trail: THREE.Vector3[] = [];

function show(r: Recording, label: string): void {
  recording = r;
  recordingLabel = label;
  playTime = 0;
  lastFrame = -1;
  trail.length = 0;
  boxes.count = Math.min(MAX_BODIES, r.bodies);
  for (let i = 0; i < boxes.count; i++) boxes.setColorAt(i, i === 0 ? ROOT : LIMB);
  if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
}

app.onFixedUpdate((dt) => {
  playTime += dt;
});

app.onFrame((_a, frameDt) => {
  if (!recording) return;
  const r = recording;
  const frames = r.frames.length / (r.bodies * 7);
  const f = Math.floor(playTime * 60) % frames;
  if (f === 0) trail.length = 0;
  com.set(0, 0, 0);
  let mass = 0;
  for (let i = 0; i < boxes.count; i++) {
    const o = (f * r.bodies + i) * 7;
    pos.set(r.frames[o], r.frames[o + 1], r.frames[o + 2]);
    rot.set(r.frames[o + 3], r.frames[o + 4], r.frames[o + 5], r.frames[o + 6]);
    scl.set(r.sizes[i * 3], r.sizes[i * 3 + 1], r.sizes[i * 3 + 2]);
    boxes.setMatrixAt(i, m4.compose(pos, rot, scl));
    const m = scl.x * scl.y * scl.z;
    com.addScaledVector(pos, m);
    mass += m;
  }
  boxes.instanceMatrix.needsUpdate = true;
  com.divideScalar(mass);
  // When the recording loops, carry the camera back with the creature instead of panning across.
  if (f < lastFrame) {
    const jump = pos.set(com.x - lastCom.x, 0, com.z - lastCom.z);
    app.camera.position.add(jump);
    app.controls.target.add(jump);
  }
  lastFrame = f;
  lastCom.copy(com);
  if (settings.trail) {
    if (!trail.length || trail[trail.length - 1].distanceTo(com) > 0.05) trail.push(com.clone().setY(0.01));
    app.debug.polyline(trail, 0xffd166);
  }
  follow.update(pos.set(com.x, 0.4, com.z), frameDt);
  app.focusShadow(com);
  const t = f / 60;
  status.textContent =
    `showing  ${recordingLabel}\n` +
    `time     ${t.toFixed(1)} s${t < EVAL.settle ? ' (settling)' : ''}\n` +
    `fitness  ${r.evaluation.fitness.toFixed(2)} m in ${EVAL.duration} s (${(r.evaluation.fitness / EVAL.duration).toFixed(2)} m/s)\n` +
    `bodies   ${r.bodies}\n\n` +
    `generation ${ga.generation} · ${pool.workers.length} workers\n` +
    `best so far ${ga.best ? ga.best.fitness.toFixed(2) : '—'} m · ${evalRate.toFixed(0)} evaluations/s`;
});

async function showSelected(): Promise<void> {
  if (settings.show === SHOW_BEST) {
    if (ga.best) show(await pool.record(ga.best.genome, EVAL.settle + EVAL.duration), `best of this run (gen ${ga.generation})`);
  } else {
    const c = champions[settings.show];
    show(await pool.record(c.genome, EVAL.settle + c.duration), `shipped champion: ${c.name}`);
  }
}

// ---------------------------------------------------------------------------
// Evolution loop: one generation at a time across the worker pool.

let evalRate = 0;
let shownBest = -1;
async function evolve(): Promise<void> {
  for (;;) {
    if (!settings.evolve) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const t0 = performance.now();
    const results = await pool.evaluate(ga.population, EVAL.duration);
    evalRate = ga.population.length / ((performance.now() - t0) / 1000);
    ga.advance(results.map((r) => r.fitness));
    drawChart();
    if (settings.show === SHOW_BEST && ga.best && ga.best.fitness !== shownBest) {
      shownBest = ga.best.fitness;
      await showSelected();
    }
  }
}

// ---------------------------------------------------------------------------
// Panels, chart, persistence

const status = frame.addPanel('Creature');
status.style.fontFamily = 'var(--mono)';
status.style.whiteSpace = 'pre';
const chartPanel = frame.addPanel('Fitness per generation (m in 8 s): best · mean');
const chart = new LinePlot(chartPanel, { height: 110, yMin: 0, yMax: 4, xTickStep: 10, formatX: (x) => x.toFixed(0) });
function drawChart(): void {
  const best = ga.history.map((h) => h.best);
  const mean = ga.history.map((h) => h.mean);
  chart.setRange(0, Math.max(2, Math.ceil(Math.max(...best, 1) * 1.2)));
  chart.draw(
    [
      { values: best, dx: 1, color: '#ff8a3d' },
      { values: mean, dx: 1, color: '#5fb3ff' },
    ],
    Math.max(20, ga.history.length),
  );
}

const STORAGE_KEY = 'pas.creature';
function save(g: Genome): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(g));
  } catch {
    // storage unavailable
  }
}
function loadSaved(): Genome | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? (JSON.parse(s) as Genome) : null;
  } catch {
    return null;
  }
}
async function showGenome(g: Genome, label: string): Promise<void> {
  if (validate(g).length) {
    recordingLabel = `invalid genome: ${validate(g)[0]}`;
    return;
  }
  show(await pool.record(g, EVAL.settle + EVAL.duration), label);
}

const pane = createPane(frame.controls);
const evo = pane.addFolder({ title: 'Evolution' });
evo.addBinding(settings, 'evolve', { label: 'running' });
evo.addBinding(settings, 'population', { min: 8, max: 128, step: 8 });
evo.addBinding(settings, 'mutation', { label: 'mutation rate', min: 0.05, max: 0.8, step: 0.05 });
evo.addButton({ title: 'Restart' }).on('click', () => {
  ga = new GeneticAlgorithm({ ...DEFAULT_GA, population: settings.population, mutationRate: settings.mutation, seed: (Math.random() * 2 ** 31) | 0 });
  shownBest = -1;
  drawChart();
});

const showFolder = pane.addFolder({ title: 'Show' });
showFolder
  .addBinding(settings, 'show', {
    options: Object.fromEntries([['best of this run', SHOW_BEST], ...champions.map((c, i) => [`${c.name} (${c.fitness.toFixed(1)} m)`, i])]),
  })
  .on('change', () => void showSelected());
showFolder.addBinding(settings, 'trail', { label: 'path' });

const io = pane.addFolder({ title: 'Save / load' });
io.addButton({ title: 'Save shown' }).on('click', () => {
  const g = settings.show === SHOW_BEST ? ga.best?.genome : champions[settings.show]?.genome;
  if (g) save(g);
});
io.addButton({ title: 'Load saved' }).on('click', () => {
  const g = loadSaved();
  if (g) void showGenome(g, 'saved creature');
});
io.addButton({ title: 'Export JSON' }).on('click', () => {
  const g = settings.show === SHOW_BEST ? ga.best?.genome : champions[settings.show]?.genome;
  if (!g) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(g, null, 1)], { type: 'application/json' }));
  a.download = 'creature.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'application/json';
fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    await showGenome(JSON.parse(await f.text()) as Genome, `imported: ${f.name}`);
  } catch {
    recordingLabel = 'could not read that file';
  }
};
io.addButton({ title: 'Import JSON' }).on('click', () => fileInput.click());
addSimulationFolder(pane, app.loop);

// Debug hook for the e2e test: re-simulate a shipped champion in a worker.
(window as unknown as { __creatures: unknown }).__creatures = {
  champions: champions.map((c) => c.fitness),
  replay: async (i: number) => (await pool.record(champions[i].genome, EVAL.settle + champions[i].duration)).evaluation.fitness,
};

app.start();
void showSelected();
void evolve();
