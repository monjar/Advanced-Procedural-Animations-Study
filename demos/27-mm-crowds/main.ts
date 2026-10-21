import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { parseMotionDB } from '../../src/anim/mmdb';
import { buildFeatures } from '../../src/anim/mmfeatures';
import { SegmentBatch } from '../../src/rig/segments';
import { drawSkeleton } from '../../src/rig/skeletonView';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { Networks, type NetworksFile } from '../16-learned-motion-matching/networks';
import type { LmmModel } from '../16-learned-motion-matching/learned';
import { buildScenario, SCENARIOS } from '../19-character-crowds/scenarios';
import { MMCrowd, type Coupling, type Driver } from './mmcrowd';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '27',
  writeup,
  hint: 'Switch how avoidance and animation are coupled, and how hard bodies are pulled to their agents · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 60, cameraPosition: [0, 15, 15], cameraTarget: [0, 0, 0] });
frame.attach(app);

const [dbBuffer, netFile, model] = await Promise.all([
  fetch(new URL('../../assets/mocap/cmu16-mm.bin', document.baseURI)).then((r) => r.arrayBuffer()),
  fetch(new URL('../../assets/lmm/networks.json', document.baseURI)).then((r) => r.json() as Promise<NetworksFile>),
  fetch(new URL('../../assets/lmm/model.json', document.baseURI)).then((r) => r.json() as Promise<LmmModel>),
]);
const db = parseMotionDB(dbBuffer);
const mf = buildFeatures(db);
const nets = new Networks(netFile);
const start = nets.project(Float32Array.from(model.startX), new Float32Array(nets.X + nets.Z));

const SCENES = SCENARIOS.filter((s) => s.name !== 'doorway');
const asked = SCENES.findIndex((s) => s.name.startsWith(new URLSearchParams(location.search).get('scenario') ?? '-'));
const settings = { scenario: Math.max(0, asked), density: 0.6, driver: 'database' as Driver, coupling: 'simulation' as Coupling, pull: 4, lock: true, agents: false };
const readout = { people: '', bodies: '', feet: '', cpu: '' };

let mm: MMCrowd;
const wallGroup = new THREE.Group();
app.scene.add(wallGroup);
function restart(moveCamera = false): void {
  const s = SCENES[settings.scenario];
  // Learned bodies cost ~20× more per agent: keep their crowds small.
  const density = settings.driver === 'learned' ? Math.min(settings.density, 0.5) : settings.density;
  const crowd = buildScenario(s, { model: 'orca' }, density, 7);
  mm = new MMCrowd(crowd, settings.driver, { mf, nets, model, start }, settings.lock);
  mm.coupling = settings.coupling;
  mm.pull = settings.pull;
  wallGroup.clear();
  for (const [x0, y0, x1, y1] of crowd.boxes) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 1.1, y1 - y0), new THREE.MeshStandardMaterial({ color: 0x59606e, roughness: 0.8 }));
    m.position.set((x0 + x1) / 2, 0.55, (y0 + y1) / 2);
    m.castShadow = m.receiveShadow = true;
    wallGroup.add(m);
  }
  if (moveCamera) {
    app.camera.position.set(0, 15, 15);
    app.controls.target.set(0, 0, 0);
  }
  doneFor = 0;
}

let doneFor = 0;
app.onFixedUpdate((dt) => {
  mm.step(dt);
  const m = mm.crowd.metrics;
  if (m.arrived === mm.crowd.agents.length || m.time > SCENES[settings.scenario].timeout) {
    doneFor += dt;
    if (doneFor > 3) restart();
  }
});

// ---------------------------------------------------------------------------------------- rendering

const COLORS = [0xff8a3d, 0x5fb3ff, 0x4fd18b, 0xffd166, 0xc6a7ff, 0xff5c8a, 0xe6e6e6];
const batch = new SegmentBatch(24 * 140, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }));
app.scene.add(batch);
const agentMark = new THREE.Vector3();
const agentTo = new THREE.Vector3();
app.onFrame(() => {
  batch.begin();
  mm.chars.forEach((c, i) => {
    if (mm.crowd.agents[i].gone) return;
    const col = COLORS[i % COLORS.length];
    drawSkeleton(batch, db.joints, c.world, { color: (n) => (/^Left|^LHip|^Right|^RHip/.test(n) ? 0x3a3f4a : col) });
  });
  batch.commit();
  if (settings.agents) {
    // Where ORCA has each agent (rings) versus where its body is.
    for (const [i, a] of mm.crowd.agents.entries()) {
      if (a.gone) continue;
      agentMark.set(a.position.x, 0.03, a.position.y);
      app.debug.circle(agentMark, new THREE.Vector3(0, 1, 0), a.radius, 0xffd166, 16);
      const c = mm.chars[i];
      agentTo.set(c.root.x, 0.03, c.root.z);
      app.debug.line(agentMark, agentTo, 0xff5c5c);
    }
  }
  const m = mm.crowd.metrics;
  const st = mm.stats;
  readout.people = `${mm.crowd.agents.length} · ${m.time.toFixed(1)} s · ${m.arrived} arrived`;
  readout.bodies = `${st.bodyOverlap.toFixed(1)} pair·s · deepest ${(Math.max(0, st.bodyDeepest) * 100).toFixed(0)} cm`;
  readout.feet = `${((st.slipSum / Math.max(1, st.slipSamples)) * 100).toFixed(1)} cm/s while planted`;
  readout.cpu = `${st.cpu.toFixed(2)} ms/step · ${((st.cpu / Math.max(1, mm.crowd.agents.length)) * 1000).toFixed(0)} µs per person`;
  simHooks.end();
  simHooks.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
pane.addBinding(settings, 'scenario', { options: Object.fromEntries(SCENES.map((s, i) => [s.name, i])) }).on('change', () => restart(true));
pane.addBinding(settings, 'density', { label: 'people ×', min: 0.25, max: 1.5, step: 0.05 }).on('change', () => restart());
pane.addBinding(settings, 'driver', { options: { 'motion matching (database, study 09)': 'database', 'learned motion matching (study 16)': 'learned' }, label: 'bodies' }).on('change', () => restart());
pane.addBinding(settings, 'coupling', { options: { 'simulation-driven (ORCA moves, bodies follow)': 'simulation', 'animation-driven (bodies move, ORCA plans)': 'animation' } }).on('change', () => restart());
pane.addBinding(settings, 'pull', { min: 0, max: 6, step: 0.25, label: 'pull (× own speed)' }).on('change', (ev) => (mm.pull = ev.value));
pane.addBinding(settings, 'lock', { label: 'foot locking' }).on('change', () => restart());
pane.addBinding(settings, 'agents', { label: 'show agents' });
pane.addButton({ title: 'Restart' }).on('click', () => restart());
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'people', { readonly: true });
info.addBinding(readout, 'bodies', { readonly: true, label: 'bodies overlap' });
info.addBinding(readout, 'feet', { readonly: true, label: 'feet slide' });
info.addBinding(readout, 'cpu', { readonly: true, label: 'animation CPU' });
const simHooks = addSimulationFolder(pane, app.loop);

restart(true);
app.start();
