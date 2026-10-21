import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { createFollow } from '../../src/core/follow';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { LinePlot } from '../../src/ui/plot';
import { Inchworm, Sidewinder, SNAKE_SKIN, Undulation, Worm } from './gaits';
import { Slither, type Gait } from './slither';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '20',
  writeup,
  hint: 'Click the ground to steer (snake, worm) · try equal friction in every direction · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 60, ground: false, cameraPosition: [0.9, 1.1, 1.3], cameraTarget: [0, 0, 0] });
frame.attach(app);
app.camera.near = 0.005;
app.camera.updateProjectionMatrix();
app.controls.minDistance = 0.08;

// ---------------------------------------------------------------------------------------- creatures

const creatures = {
  snake: {
    label: 'snake: lateral undulation',
    gait: new Undulation({ amplitude: 0.8, waves: 1.5, frequency: 1, lift: 0.6, turn: 0, friction: { ...SNAKE_SKIN } }),
    length: 1,
    camera: 1.6,
    steer: true,
  },
  sidewinder: {
    label: 'sidewinder',
    gait: new Sidewinder({ amplitude: 0.9, waves: 1.2, frequency: 1, liftPhase: Math.PI / 2, lift: 1, friction: { muF: 0.5, muB: 0.5, muN: 0.5 } }),
    length: 1,
    camera: 1.8,
    steer: false,
  },
  worm: {
    label: 'earthworm: peristalsis',
    gait: new Worm({ stretch: 0.3, waves: 1.5, frequency: 1, direction: 1, turn: 0, friction: { muF: 0.1, muB: 0.6, muN: 0.4 } }),
    length: 0.18,
    camera: 0.32,
    steer: true,
  },
  inchworm: {
    label: 'inchworm',
    gait: new Inchworm({ frequency: 1, reach: 0.4, grip: 2, slip: 0.05 }),
    length: 0.08,
    camera: 0.22,
    steer: false,
  },
};
type Kind = keyof typeof creatures;
// ?creature=sidewinder (etc.) opens that one directly.
const asked = new URLSearchParams(location.search).get('creature') as Kind | null;
const settings = { creature: (asked && asked in creatures ? asked : 'snake') as Kind, slowMotion: false, tracks: true };

let sim: Slither;
let target: THREE.Vector3 | null = null;

// ---------------------------------------------------------------------------------------- ground

function sandTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6b583d';
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9000; i++) {
    const v = 85 + rnd() * 60;
    g.fillStyle = `rgba(${v}, ${v * 0.84}, ${v * 0.6}, ${0.25 + rnd() * 0.3})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(60, 60);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: sandTexture(), roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
app.scene.add(ground);
app.sun.shadow.camera.left = app.sun.shadow.camera.bottom = -2;
app.sun.shadow.camera.right = app.sun.shadow.camera.top = 2;
app.sun.shadow.camera.updateProjectionMatrix();

// Tracks: where a point rests on the ground, it leaves a mark (sidewinders leave separate J-shaped ones).
const MAX_MARKS = 5000;
const marks = new THREE.InstancedMesh(
  new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x6e5636, transparent: true, opacity: 0.35, depthWrite: false }),
  MAX_MARKS,
);
marks.count = 0;
marks.frustumCulled = false;
app.scene.add(marks);
let markHead = 0;
const _m = new THREE.Matrix4();
function addMark(x: number, z: number, r: number): void {
  _m.makeScale(r, 1, r).setPosition(x, 0.0008, z);
  marks.setMatrixAt(markHead, _m);
  markHead = (markHead + 1) % MAX_MARKS;
  marks.count = Math.min(MAX_MARKS, marks.count + 1);
  marks.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------------------------- body mesh

/** A tube through the body points (Catmull-Rom subdivided), capped at both ends, vertex-coloured per creature. */
class Tube {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly ring = 14;
  private readonly sub = 4;
  private rows = 0;
  private readonly pts: THREE.Vector3[] = [];
  private readonly rad: number[] = [];

  constructor(private n: number) {
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.build(n);
  }

  build(n: number): void {
    this.n = n;
    const caps = 4;
    this.rows = (n - 1) * this.sub + 1 + 2 * caps;
    const R = this.ring;
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.rows * R * 3), 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.rows * R * 3), 3));
    const idx: number[] = [];
    for (let r = 0; r < this.rows - 1; r++)
      for (let k = 0; k < R; k++) {
        const a = r * R + k;
        const b = r * R + ((k + 1) % R);
        idx.push(a, a + R, b, b, a + R, b + R);
      }
    this.geo.setIndex(idx);
  }

  update(points: THREE.Vector3[], radii: number[], color: (u: number, around: number) => [number, number, number], flatten = 0.85): void {
    // Subdivide.
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const S = (this.n - 1) * this.sub + 1;
    this.pts.length = 0;
    this.rad.length = 0;
    for (let j = 0; j < S; j++) {
      const u = j / (S - 1);
      this.pts.push(curve.getPoint(u));
      const f = u * (this.n - 1);
      const i = Math.min(this.n - 2, Math.floor(f));
      this.rad.push(radii[i] + (radii[i + 1] - radii[i]) * (f - i));
    }
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.geo.getAttribute('color') as THREE.BufferAttribute;
    const R = this.ring;
    const up = new THREE.Vector3(0, 1, 0);
    const T = new THREE.Vector3();
    const side = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const p = new THREE.Vector3();
    let row = 0;
    const writeRing = (c: THREE.Vector3, r: number, u: number) => {
      for (let k = 0; k < R; k++) {
        const a = (k / R) * Math.PI * 2;
        p.copy(c)
          .addScaledVector(side, Math.cos(a) * r)
          .addScaledVector(nrm, Math.sin(a) * r * flatten);
        pos.setXYZ(row * R + k, p.x, p.y, p.z);
        const [cr, cg, cb] = color(u, Math.sin(a));
        col.setXYZ(row * R + k, cr, cg, cb);
      }
      row++;
    };
    const frameAt = (j: number) => {
      T.subVectors(this.pts[Math.min(S - 1, j + 1)], this.pts[Math.max(0, j - 1)]).normalize();
      side.crossVectors(T, up).normalize();
      nrm.crossVectors(side, T);
    };
    const caps = [0.45, 0.75, 0.93, 1.0];
    frameAt(0);
    for (let c = caps.length - 1; c >= 0; c--) {
      const k = caps[c];
      writeRing(this.pts[0].clone().addScaledVector(T, -k * this.rad[0]), this.rad[0] * Math.sqrt(Math.max(0.0025, 1 - k * k)), 0);
    }
    for (let j = 0; j < S; j++) {
      frameAt(j);
      writeRing(this.pts[j], this.rad[j], j / (S - 1));
    }
    frameAt(S - 1);
    for (const k of caps) writeRing(this.pts[S - 1].clone().addScaledVector(T, k * this.rad[S - 1]), this.rad[S - 1] * Math.sqrt(Math.max(0.0025, 1 - k * k)), 1);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

const tube = new Tube(48);
app.scene.add(tube.mesh);
const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.2 });
const eyes = [0, 1].map(() => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), eyeMat);
  app.scene.add(m);
  return m;
});

const lerp3 = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const PALETTES: Record<Kind, (u: number, around: number) => [number, number, number]> = {
  // Corn-snake saddles: red-orange blotches on tan, a pale belly.
  snake: (u, a) => {
    if (a < -0.55) return [0.92, 0.88, 0.78];
    const band = Math.sin(u * 2 * Math.PI * 14) > 0.15;
    return band ? lerp3([0.75, 0.25, 0.12], [0.55, 0.15, 0.08], (a + 1) / 2) : [0.82, 0.58, 0.36];
  },
  // Sidewinder: sandy with darker dorsal spots.
  sidewinder: (u, a) => {
    if (a < -0.55) return [0.9, 0.86, 0.75];
    const spot = Math.sin(u * 2 * Math.PI * 18) > 0.4 && a > 0.3;
    return spot ? [0.48, 0.38, 0.26] : [0.78, 0.68, 0.5];
  },
  // Earthworm: pink with segment rings and the saddle (clitellum) a third of the way back.
  worm: (u, a) => {
    const ring = Math.abs(Math.sin(u * Math.PI * 60)) < 0.18;
    const saddle = u > 0.62 && u < 0.72;
    const base: [number, number, number] = saddle ? [0.82, 0.42, 0.4] : [0.86, 0.55, 0.52];
    const shade = a < -0.5 ? 1.08 : 1;
    return ring ? [base[0] * 0.8, base[1] * 0.75, base[2] * 0.75] : [base[0] * shade, base[1] * shade, base[2] * shade];
  },
  // Looper caterpillar: green with a pale side stripe.
  inchworm: (_u, a) => (Math.abs(a) < 0.18 ? [0.85, 0.92, 0.6] : a < -0.5 ? [0.55, 0.72, 0.3] : [0.38, 0.62, 0.2]),
};

// ---------------------------------------------------------------------------------------- simulation

function start(kind: Kind): void {
  const c = creatures[kind];
  sim = new Slither(c.gait as Gait);
  tube.build(c.gait.n);
  target = null;
  targetMarker.visible = false;
  marks.count = 0;
  markHead = 0;
  traceLen = 0;
  const d = c.camera;
  app.controls.target.set(0, 0, 0);
  app.camera.position.set(d * 0.55, d * 0.65, d * 0.8);
  eyes.forEach((e) => (e.visible = kind === 'snake' || kind === 'sidewinder'));
}

const N_TRACE = 300;
const speedTrace = new Float32Array(N_TRACE);
let traceLen = 0;
let traceTimer = 0;
let markTimer = 0;
const SUB = 4;

app.onFixedUpdate((dt) => {
  const c = creatures[settings.creature];
  const h = (settings.slowMotion ? dt * 0.25 : dt) / SUB;
  // Steering: bend the body toward the clicked point.
  if (c.steer && target) {
    const f = sim.frame;
    const head = [sim.wx[f.n - 1], sim.wy[f.n - 1]];
    const tail = [sim.wx[0], sim.wy[0]];
    const heading = Math.atan2(head[1] - tail[1], head[0] - tail[0]);
    const want = Math.atan2(-target.z - head[1], target.x - head[0]);
    const err = Math.atan2(Math.sin(want - heading), Math.cos(want - heading));
    const g = c.gait as Undulation | Worm;
    g.p.turn = THREE.MathUtils.clamp(err * 2.5, -1.6, 1.6) / c.length;
    if (Math.hypot(target.x - head[0], -target.z - head[1]) < 0.1 * c.length) {
      target = null;
      targetMarker.visible = false;
      g.p.turn = 0;
    }
  }
  for (let k = 0; k < SUB; k++) sim.step(h);
  const speed = Math.hypot(sim.vx, sim.vy);
  traceTimer += h * SUB;
  if (traceTimer > 1 / 30) {
    traceTimer = 0;
    if (traceLen === N_TRACE) speedTrace.copyWithin(0, 1);
    speedTrace[Math.min(traceLen, N_TRACE - 1)] = (speed / c.length) * 100;
    traceLen = Math.min(N_TRACE, traceLen + 1);
  }
  if (settings.tracks) {
    markTimer += h * SUB;
    if (markTimer > 1 / 20) {
      markTimer = 0;
      const f = sim.frame;
      for (let i = 0; i < f.n; i += 2) {
        if (f.weight[i] * f.n < 0.3) continue;
        if (Math.hypot(sim.wvx[i], sim.wvy[i]) > 0.08 * c.length) continue;
        addMark(sim.wx[i], -sim.wy[i], f.radius[i] * 0.8);
      }
    }
  }
  readout.speed = `${(speed * 100).toFixed(1)} cm/s · ${(speed / c.length).toFixed(2)} lengths/s`;
});

// ---------------------------------------------------------------------------------------- picking

const targetMarker = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 32), new THREE.MeshBasicMaterial({ color: 0xffd166, side: THREE.DoubleSide }));
targetMarker.rotation.x = -Math.PI / 2;
targetMarker.visible = false;
app.scene.add(targetMarker);
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt = { x: 0, y: 0 };
app.renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
app.renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5 || !creatures[settings.creature].steer) return;
  const r = app.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, app.camera);
  const p = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) {
    target = p;
    const s = creatures[settings.creature].length * 0.05;
    targetMarker.scale.setScalar(s);
    targetMarker.position.set(p.x, 0.002, p.z);
    targetMarker.visible = true;
  }
});

// ---------------------------------------------------------------------------------------- frame

const speedPlot = new LinePlot(frame.addPanel('Speed (body lengths per second × 100)'), { height: 90, yMin: 0, yMax: 60, yTicks: [0, 20, 40, 60], xTickStep: 2, formatX: (x) => `${(x - 10).toFixed(0)}s` });

/** Speed against the sideways / lengthwise friction ratio, measured at load: the slithering result in one chart. */
const sweepBody = frame.addPanel('Undulation speed vs friction anisotropy μₙ / μₜ (m/s)');
const sweepCanvas = document.createElement('canvas');
sweepCanvas.style.width = '100%';
sweepCanvas.style.height = '110px';
sweepBody.appendChild(sweepCanvas);
const RATIOS = [1, 1.5, 2, 3, 5, 8];
const sweep = { flat: [] as number[], lifted: [] as number[] };
for (const lift of [0, 1]) {
  for (const ratio of RATIOS) {
    const s = new Slither(new Undulation({ amplitude: 0.8, waves: 1.5, frequency: 1, lift, turn: 0, friction: { muF: 0.1, muB: 0.1, muN: 0.1 * ratio } }));
    for (let i = 0; i < 240 * 4; i++) s.step(1 / 240);
    const x0 = s.X;
    const y0 = s.Y;
    for (let i = 0; i < 240 * 4; i++) s.step(1 / 240);
    (lift ? sweep.lifted : sweep.flat).push(((s.X - x0) * Math.cos(0) + (s.Y - y0) * 0) / 4);
  }
}
function drawSweep(): void {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = Math.max(1, sweepCanvas.clientWidth);
  const h = 110;
  if (sweepCanvas.width !== w * dpr) (sweepCanvas.width = w * dpr), (sweepCanvas.height = h * dpr);
  const g = sweepCanvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const pad = { l: 30, r: 8, t: 6, b: 18 };
  const maxV = Math.max(0.05, ...sweep.lifted, ...sweep.flat) * 1.1;
  const minV = Math.min(0, ...sweep.flat, ...sweep.lifted);
  const X = (i: number) => pad.l + (i / (RATIOS.length - 1)) * (w - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - minV) / (maxV - minV)) * (h - pad.t - pad.b);
  g.strokeStyle = '#3a404c';
  g.beginPath();
  g.moveTo(pad.l, Y(0));
  g.lineTo(w - pad.r, Y(0));
  g.stroke();
  g.fillStyle = '#8a93a6';
  g.font = '10px system-ui, sans-serif';
  RATIOS.forEach((r, i) => g.fillText(`${r}×`, X(i) - 6, h - 4));
  g.fillText(maxV.toFixed(2), 2, Y(maxV) + 8);
  g.fillText('0', 18, Y(0) + 3);
  for (const [series, color] of [
    [sweep.flat, '#5fb3ff'],
    [sweep.lifted, '#ff8a3d'],
  ] as const) {
    g.strokeStyle = g.fillStyle = color;
    g.beginPath();
    series.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
    g.stroke();
    series.forEach((v, i) => g.fillRect(X(i) - 2, Y(v) - 2, 4, 4));
  }
  g.fillStyle = '#5fb3ff';
  g.fillText('flat', w - 70, 14);
  g.fillStyle = '#ff8a3d';
  g.fillText('lifting', w - 40, 14);
}

const follow = createFollow(app, 0.6);
const points: THREE.Vector3[] = [];
const radii: number[] = [];
const com = new THREE.Vector3();
let clock = 0;
app.onFrame((_a, frameDt) => {
  clock += frameDt;
  const f = sim.frame;
  points.length = 0;
  radii.length = 0;
  for (let i = 0; i < f.n; i++) {
    points.push(new THREE.Vector3(sim.wx[i], f.z[i] + f.radius[i] * 0.85, -sim.wy[i]));
    radii.push(f.radius[i]);
  }
  tube.update(points, radii, PALETTES[settings.creature], settings.creature === 'worm' || settings.creature === 'inchworm' ? 0.95 : 0.8);
  // Eyes and a flicking tongue for the snakes.
  if (eyes[0].visible) {
    const head = points[f.n - 1];
    const T = new THREE.Vector3().subVectors(head, points[f.n - 3]).normalize();
    const side = new THREE.Vector3().crossVectors(T, new THREE.Vector3(0, 1, 0)).normalize();
    const r = radii[f.n - 1];
    eyes.forEach((e, k) => {
      e.scale.setScalar(r * 0.32);
      e.position.copy(head).addScaledVector(T, r * 0.35).addScaledVector(side, (k ? 1 : -1) * r * 0.62).add(new THREE.Vector3(0, r * 0.45, 0));
    });
    const flick = Math.max(0, Math.sin(clock * 9)) * (Math.sin(clock * 0.9) > 0.3 ? 1 : 0);
    if (flick > 0.05) {
      const mouth = head.clone().addScaledVector(T, r * 1.05).add(new THREE.Vector3(0, -r * 0.2, 0));
      const tip = mouth.clone().addScaledVector(T, r * 2.2 * flick);
      app.debug.line(mouth, tip, 0xd02040);
      for (const k of [-1, 1]) app.debug.line(tip, tip.clone().addScaledVector(T, r * 0.7 * flick).addScaledVector(side, k * r * 0.45 * flick), 0xd02040);
    }
  }
  com.set(sim.X, 0, -sim.Y);
  follow.update(com, frameDt);
  app.focusShadow(com);
  speedPlot.draw([{ values: speedTrace.subarray(0, traceLen), dx: 10 / N_TRACE, color: '#4fd18b' }], 10);
  drawSweep();
  simHooks.end();
  simHooks.begin();
});

// ---------------------------------------------------------------------------------------- controls

const readout = { speed: '' };
const pane = createPane(frame.controls);
pane.addBinding(settings, 'creature', { options: Object.fromEntries(Object.entries(creatures).map(([k, v]) => [v.label, k])) }).on('change', (ev) => {
  start(ev.value);
  rebuildFolder();
});
let folder = pane.addFolder({ title: 'Body' });
function rebuildFolder(): void {
  folder.dispose();
  folder = pane.addFolder({ title: 'Body', index: 1 } as never);
  const k = settings.creature;
  if (k === 'snake') {
    const p = creatures.snake.gait.p;
    folder.addBinding(p, 'amplitude', { min: 0.1, max: 1.4, step: 0.05, label: 'wave amplitude (rad)' });
    folder.addBinding(p, 'waves', { min: 0.5, max: 3, step: 0.1, label: 'waves on the body' });
    folder.addBinding(p, 'frequency', { min: 0.2, max: 3, step: 0.1, label: 'frequency (Hz)' });
    folder.addBinding(p, 'lift', { min: 0, max: 1, step: 0.05, label: 'lift the bends' });
    frictionBindings(p.friction);
    folder.addButton({ title: 'Equal friction every way' }).on('click', () => {
      Object.assign(p.friction, { muF: 0.15, muB: 0.15, muN: 0.15 });
      pane.refresh();
    });
    folder.addButton({ title: 'Snake skin (Hu et al.)' }).on('click', () => {
      Object.assign(p.friction, SNAKE_SKIN);
      pane.refresh();
    });
  } else if (k === 'sidewinder') {
    const p = creatures.sidewinder.gait.p;
    folder.addBinding(p, 'amplitude', { min: 0.1, max: 1.4, step: 0.05, label: 'wave amplitude (rad)' });
    folder.addBinding(p, 'frequency', { min: 0.2, max: 3, step: 0.1, label: 'frequency (Hz)' });
    folder.addBinding(p, 'lift', { min: 0, max: 1, step: 0.05, label: 'lifting wave' });
    folder.addBinding(p, 'liftPhase', { min: -Math.PI, max: Math.PI, step: 0.05, label: 'lift phase (rad)' });
    frictionBindings(p.friction);
  } else if (k === 'worm') {
    const p = creatures.worm.gait.p;
    folder.addBinding(p, 'stretch', { min: 0, max: 0.5, step: 0.02, label: 'segment stretch' });
    folder.addBinding(p, 'waves', { min: 0.5, max: 4, step: 0.1, label: 'waves on the body' });
    folder.addBinding(p, 'frequency', { min: 0.2, max: 3, step: 0.1, label: 'frequency (Hz)' });
    folder.addBinding(p, 'direction', { options: { 'head → tail (retrograde)': 1, 'tail → head (direct)': -1 }, label: 'wave runs' });
    frictionBindings(p.friction, 'bristles: ');
  } else {
    const p = creatures.inchworm.gait.p;
    folder.addBinding(p, 'frequency', { min: 0.2, max: 3, step: 0.1, label: 'frequency (Hz)' });
    folder.addBinding(p, 'reach', { min: 0.05, max: 0.6, step: 0.05, label: 'reach (of length)' });
    folder.addBinding(p, 'grip', { min: 0.05, max: 3, step: 0.05, label: 'planted grip μ' });
    folder.addBinding(p, 'slip', { min: 0, max: 1, step: 0.01, label: 'sliding μ' });
  }
}
function frictionBindings(fr: { muF: number; muB: number; muN: number }, prefix = ''): void {
  folder.addBinding(fr, 'muF', { min: 0, max: 1, step: 0.01, label: `${prefix}μ forward` });
  folder.addBinding(fr, 'muB', { min: 0, max: 1, step: 0.01, label: `${prefix}μ backward` });
  folder.addBinding(fr, 'muN', { min: 0, max: 1, step: 0.01, label: `${prefix}μ sideways` });
}
pane.addBinding(settings, 'tracks', { label: 'leave tracks' });
pane.addBinding(settings, 'slowMotion', { label: 'slow motion ×¼' });
pane.addButton({ title: 'Restart' }).on('click', () => start(settings.creature));
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'speed', { readonly: true });
const simHooks = addSimulationFolder(pane, app.loop);

start(settings.creature);
rebuildFolder();
app.start();
