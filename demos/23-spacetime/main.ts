import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import { BASE_JOINT, centreOfMass, FOOT, jointPositions, SOLE, TOTAL_MASS, G } from './luxo';
import { Jump, keyframed, type JumpSpec } from './spacetime';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '23',
  writeup,
  hint: 'Pick a jump, or set your own and optimise it live · compare with the hand-keyed version · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 60, cameraPosition: [0.25, 0.45, 1.6], cameraTarget: [0.22, 0.25, 0] });
frame.attach(app);
app.camera.near = 0.02;
app.camera.updateProjectionMatrix();
app.sun.shadow.camera.left = app.sun.shadow.camera.bottom = -1.5;
app.sun.shadow.camera.right = app.sun.shadow.camera.top = 1.5;
app.sun.shadow.camera.updateProjectionMatrix();

interface Stored {
  name: string;
  spec: JumpSpec;
  p: number[];
  terms: Record<string, number>;
}
const stored: Stored[] = await fetch(new URL('../../assets/spacetime/jumps.json', document.baseURI)).then((r) => r.json());

const settings = { preset: 0, mode: 'physics' as 'physics' | 'keyframed', speed: 1, onion: true, forces: true, distance: 0.35, rise: 0, hurdle: 0, flight: 0.34 };
const readout = { status: '', effort: '', ground: '', invisible: '' };

let jump: Jump;
let keyed: ReturnType<typeof keyframed>;
let worker: Worker | null = null;
function load(spec: JumpSpec, p: ArrayLike<number> | null): void {
  jump = new Jump(spec);
  if (p) jump.set(p);
  keyed = keyframed(spec);
  buildSet(spec);
  buildTraces();
}

// ---------------------------------------------------------------------------------------- the lamp

const metal = new THREE.MeshStandardMaterial({ color: 0xd9dde4, roughness: 0.35, metalness: 0.6 });
const dark = new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.6, metalness: 0.3 });
function makeLamp(material: THREE.Material, ghost = false) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(FOOT, FOOT * 1.05, 0.05, 40), material);
  const arm1 = new THREE.Group();
  const arm2 = new THREE.Group();
  const head = new THREE.Group();
  for (const [grp, len] of [
    [arm1, 0.28],
    [arm2, 0.28],
  ] as const) {
    for (const z of [-0.018, 0.018]) {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, len, 10), material);
      rod.position.set(0, len / 2, z);
      grp.add(rod);
    }
    const knuckle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.05, 14).rotateX(Math.PI / 2), dark);
    grp.add(knuckle);
  }
  // Head: a shade (open cone) pointing along the link's +y from the neck, with a glowing bulb.
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.13, 32, 1, true).rotateZ(Math.PI), material);
  (shade.material as THREE.Material).side = THREE.DoubleSide;
  shade.position.set(0, 0.1, 0);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), material);
  cap.position.set(0, 0.03, 0);
  head.add(shade, cap);
  if (!ghost) {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffe08a, emissiveIntensity: 2 }));
    bulb.position.set(0, 0.13, 0);
    head.add(bulb);
    const light = new THREE.SpotLight(0xffe7a8, 3, 3, 0.6, 0.6, 1.5);
    light.position.set(0, 0.12, 0);
    light.target.position.set(0, 1, 0);
    head.add(light, light.target);
  }
  for (const m of [base, ...arm1.children, ...arm2.children, ...head.children]) if (m instanceof THREE.Mesh) m.castShadow = !ghost;
  g.add(base, arm1, arm2, head);
  return {
    group: g,
    set(q: ArrayLike<number>) {
      const pts = jointPositions(q);
      base.position.set(q[0], q[1], 0);
      base.rotation.z = q[2];
      let a = q[2];
      [arm1, arm2, head].forEach((grp, i) => {
        a += q[3 + i];
        grp.position.set(pts[i + 1][0], pts[i + 1][1], 0);
        grp.rotation.z = a;
      });
    },
  };
}
const lamp = makeLamp(metal);
app.scene.add(lamp.group);
const ghostMat = new THREE.MeshBasicMaterial({ color: 0x8a93a6, transparent: true, opacity: 0.1, depthWrite: false });
const ghosts = Array.from({ length: 9 }, () => {
  const l = makeLamp(ghostMat, true);
  app.scene.add(l.group);
  return l;
});

// ---------------------------------------------------------------------------------------- set dressing

const setGroup = new THREE.Group();
app.scene.add(setGroup);
const propMat = new THREE.MeshStandardMaterial({ color: 0x6b7180, roughness: 0.8 });
function buildSet(spec: JumpSpec): void {
  setGroup.clear();
  if (spec.rise > 0) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(0.6, spec.rise, 0.5), propMat);
    step.position.set(spec.distance - 0.15 + 0.3, spec.rise / 2, 0);
    step.castShadow = step.receiveShadow = true;
    setGroup.add(step);
  }
  if (spec.hurdle > 0) {
    const x = spec.distance / 2;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.5, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xff8a3d }));
    bar.position.set(x, spec.hurdle, 0);
    const legs = [-0.22, 0.22].map((z) => {
      const l = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, spec.hurdle, 8), propMat);
      l.position.set(x, spec.hurdle / 2, z);
      return l;
    });
    setGroup.add(bar, ...legs);
  }
  // Landing mark.
  const mark = new THREE.Mesh(new THREE.RingGeometry(FOOT * 0.95, FOOT * 1.1, 40), new THREE.MeshBasicMaterial({ color: 0x4fd18b, side: THREE.DoubleSide }));
  mark.rotation.x = -Math.PI / 2;
  mark.position.set(spec.distance, spec.rise + 0.002, 0);
  setGroup.add(mark);
}

// ---------------------------------------------------------------------------------------- plots

const N_T = 240;
const torque = [new Float32Array(N_T), new Float32Array(N_T), new Float32Array(N_T)];
const groundY = new Float32Array(N_T);
const invisibleY = new Float32Array(N_T);
function buildTraces(): void {
  let maxInvisible = 0;
  for (let k = 0; k < N_T; k++) {
    const t = (jump.T * k) / (N_T - 1);
    const f = jump.forces(t);
    for (let j = 0; j < 3; j++) torque[j][k] = f.tau[j];
    groundY[k] = f.ground[1] / (TOTAL_MASS * G);
    const inv = keyed.invisible(t);
    invisibleY[k] = Math.hypot(inv[0], inv[1]) / (TOTAL_MASS * G);
    maxInvisible = Math.max(maxInvisible, invisibleY[k]);
  }
  const c = jump.contactCheck();
  readout.effort = `${jump.terms.effort?.toFixed(1)} N²·m²·s · lands ${((jump.terms.landingError ?? 0) * 100).toFixed(1)} cm from the mark`;
  readout.ground = `pushes ≥ ${c.minFy.toFixed(1)} N · friction ≤ ${c.maxFriction.toFixed(2)} · CoP ≤ ${(c.maxCop * 100).toFixed(1)} of ${(FOOT * 100).toFixed(0)} cm`;
  readout.invisible = `hand-keyed version needs up to ${maxInvisible.toFixed(1)}× the lamp's weight from nowhere`;
}
const torquePlot = new LinePlot(frame.addPanel('Joint torques (N·m): base · elbow · neck'), { height: 90, yMin: -3, yMax: 3, yTicks: [-2, 0, 2], xTickStep: 0.5, formatX: (x) => `${x.toFixed(1)}s` });
const forcePlot = new LinePlot(frame.addPanel('Ground force (green) vs the hand-keyed jump\'s invisible force (red), × weight'), {
  height: 90,
  yMin: 0,
  yMax: 4,
  yTicks: [0, 1, 2, 3, 4],
  xTickStep: 0.5,
  formatX: (x) => `${x.toFixed(1)}s`,
});

// ---------------------------------------------------------------------------------------- playback

let t = 0;
let hold = 0;
app.onFixedUpdate((dt) => {
  if (hold > 0) {
    hold -= dt;
    if (hold <= 0) t = 0;
    return;
  }
  t += dt * settings.speed;
  if (t >= jump.T) {
    t = jump.T;
    hold = 0.8;
  }
});

const from = new THREE.Vector3();
const to = new THREE.Vector3();
app.onFrame(() => {
  const physics = settings.mode === 'physics';
  const state = (time: number) => (physics ? jump.state(time) : keyed.state(time));
  lamp.set(state(t));
  ghosts.forEach((g, i) => {
    g.group.visible = settings.onion;
    if (settings.onion) g.set(state((jump.T * (i + 0.5)) / ghosts.length));
  });
  if (settings.forces) {
    // Centre-of-mass path: a parabola in flight for the real jump.
    let prev: THREE.Vector3 | null = null;
    for (let k = 0; k <= 60; k++) {
      const c = centreOfMass(state((jump.T * k) / 60));
      const p = new THREE.Vector3(c[0], c[1], 0);
      if (prev) app.debug.line(prev, p, physics ? 0xffd166 : 0xff5c5c);
      prev = p;
    }
    const q = state(t);
    if (physics) {
      const g = jump.forces(t).ground;
      if (g[1] > 0.01) {
        // Ground force at the centre of pressure, 1 N → 1 cm.
        const cop = (g[2] + SOLE * g[0]) / g[1];
        from.set(q[0] + cop, q[1] + SOLE, 0);
        to.set(from.x + g[0] * 0.01, from.y + g[1] * 0.01, 0);
        app.debug.arrow(from, to, 0x4fd18b, 0.03);
      }
    } else {
      const inv = keyed.invisible(t);
      if (Math.hypot(inv[0], inv[1]) > 0.1) {
        from.set(q[0], q[1] + BASE_JOINT, 0);
        to.set(from.x + inv[0] * 0.01, from.y + inv[1] * 0.01, 0);
        app.debug.arrow(from, to, 0xff5c5c, 0.03);
      }
    }
  }
  torquePlot.draw(
    torque.map((v, j) => ({ values: v, dx: jump.T / (N_T - 1), color: ['#ff8a3d', '#5fb3ff', '#c6a7ff'][j] })),
    jump.T,
  );
  forcePlot.draw(
    [
      { values: groundY, dx: jump.T / (N_T - 1), color: '#4fd18b' },
      { values: invisibleY, dx: jump.T / (N_T - 1), color: '#ff5c5c' },
    ],
    jump.T,
  );
  simHooks.end();
  simHooks.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
pane.addBinding(settings, 'preset', { options: Object.fromEntries(stored.map((s, i) => [s.name, i])) }).on('change', (ev) => {
  worker?.terminate();
  worker = null;
  const s = stored[ev.value];
  load(s.spec, s.p);
  readout.status = 'optimised offline (CMA-ES + Levenberg–Marquardt)';
  t = 0;
});
pane.addBinding(settings, 'mode', { options: { 'optimised (physics)': 'physics', 'hand-keyed (no physics)': 'keyframed' }, label: 'play' });
pane.addBinding(settings, 'speed', { min: 0.1, max: 1.5, step: 0.05, label: 'playback speed' });
const custom = pane.addFolder({ title: 'Optimise your own', expanded: false });
custom.addBinding(settings, 'distance', { min: 0.1, max: 0.5, step: 0.01, label: 'distance (m)' });
custom.addBinding(settings, 'rise', { min: 0, max: 0.12, step: 0.01, label: 'step up (m)' });
custom.addBinding(settings, 'hurdle', { min: 0, max: 0.12, step: 0.01, label: 'hurdle (m)' });
custom.addBinding(settings, 'flight', { min: 0.2, max: 0.5, step: 0.01, label: 'flight time (s)' });
custom.addButton({ title: 'Optimise (≈ 1 min, in a worker)' }).on('click', () => {
  worker?.terminate();
  const spec: JumpSpec = { distance: settings.distance, rise: settings.rise, stance1: 0.6, flight: settings.flight, stance2: 0.5, hurdle: settings.hurdle, friction: 0.8 };
  load(spec, null);
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ done: boolean; stage: string; step: number; p: number[]; cost: number }>) => {
    jump.set(e.data.p);
    buildTraces();
    readout.status = e.data.done ? `done · cost ${e.data.cost.toFixed(1)}` : `${e.data.stage === 'search' ? 'CMA-ES generation' : 'Levenberg–Marquardt step'} ${e.data.step} · cost ${e.data.cost.toFixed(1)}`;
  };
  worker.postMessage({ spec, seed: 3 });
});
const view = pane.addFolder({ title: 'View' });
view.addBinding(settings, 'onion', { label: 'onion skin' });
view.addBinding(settings, 'forces', { label: 'COM path & forces' });
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'status', { readonly: true });
info.addBinding(readout, 'effort', { readonly: true });
info.addBinding(readout, 'ground', { readonly: true });
info.addBinding(readout, 'invisible', { readonly: true, label: 'hand-keyed' });
const simHooks = addSimulationFolder(pane, app.loop);

load(stored[0].spec, stored[0].p);
readout.status = 'optimised offline (CMA-ES + Levenberg–Marquardt)';
app.start();
