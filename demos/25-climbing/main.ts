import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { createTwoBoneResult, solveTwoBone } from '../../src/ik/twoBone';
import { Rng } from '../../src/math/random';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { BODY, makeWall, placeTorso, planRoute, reach, root, type Hold, type Plan } from './climb';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '25',
  writeup,
  hint: 'Watch it plan and climb · new wall for another route · tilt the wall into an overhang · Orbit: right-drag',
});
const app = createApp(frame.viewport, { rate: 60, cameraPosition: [2.6, 2.2, 4.4], cameraTarget: [0, 2, 0] });
frame.attach(app);

const WIDTH = 2.4;
const HEIGHT = 4;
const settings = { seed: 1, spacing: 0.32, overhang: 0, speed: 1, plan: true };
const readout = { route: '', search: '' };

// ---------------------------------------------------------------------------------------- wall geometry

/** Wall frame: u across, v up the (possibly overhanging) face, n out toward the climber. */
const wallU = new THREE.Vector3(1, 0, 0);
const wallV = new THREE.Vector3(0, 1, 0);
const wallN = new THREE.Vector3(0, 0, 1);
function setTilt(deg: number): void {
  const a = THREE.MathUtils.degToRad(deg);
  wallV.set(0, Math.cos(a), Math.sin(a));
  wallN.set(0, -Math.sin(a), Math.cos(a));
}
const onWall = (u: number, v: number, out = new THREE.Vector3(), off = 0) => out.set(0, 0, 0).addScaledVector(wallU, u).addScaledVector(wallV, v).addScaledVector(wallN, off);

const wallGroup = new THREE.Group();
app.scene.add(wallGroup);
const holdColors = [0xff8a3d, 0x5fb3ff, 0x4fd18b, 0xffd166, 0xc6a7ff, 0xff5c8a];

let holds: Hold[] = [];
let plan: Plan | null = null;
let top = 0;
function buildWall(): void {
  setTilt(settings.overhang);
  const w = makeWall(settings.seed, WIDTH, HEIGHT, settings.spacing);
  holds = w.holds;
  top = w.top;
  const t0 = performance.now();
  plan = planRoute(holds, w.start, w.top);
  readout.search = plan ? `${plan.expanded} stances searched in ${(performance.now() - t0).toFixed(0)} ms` : 'no route found';
  readout.route = plan ? `${plan.stances.length - 1} moves` : '—';
  wallGroup.clear();
  const panel = new THREE.Mesh(new THREE.BoxGeometry(WIDTH + 0.4, HEIGHT + 0.3, 0.12), new THREE.MeshStandardMaterial({ color: 0x8c7b67, roughness: 0.9 }));
  onWall(0, HEIGHT / 2 - 0.05, panel.position, -0.06);
  panel.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(wallU, wallV, wallN));
  panel.receiveShadow = true;
  wallGroup.add(panel);
  const rng = new Rng(settings.seed * 7 + 1);
  holds.forEach((h, i) => {
    const geo = new THREE.SphereGeometry(h.size, 12, 8);
    // Lumpy holds: squash and jitter the sphere a little.
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const f = 1 + 0.25 * Math.sin(pos.getX(k) * 60 + i) * Math.cos(pos.getY(k) * 50);
      pos.setXYZ(k, pos.getX(k) * f, pos.getY(k) * f * 0.8, pos.getZ(k) * 0.55);
    }
    geo.computeVertexNormals();
    const color = i === top ? 0xffffff : i < 4 ? 0x8a93a6 : holdColors[rng.int(holdColors.length)];
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.7, emissive: i === top ? 0x333333 : 0 }));
    onWall(h.u, h.v, m.position, 0.01);
    m.quaternion.copy(panel.quaternion);
    m.castShadow = true;
    wallGroup.add(m);
  });
  moveIndex = 0;
  moveTime = 0;
  pauseAt = 0;
}

// ---------------------------------------------------------------------------------------- climber

const skin = new THREE.MeshStandardMaterial({ color: 0xd9a383, roughness: 0.6 });
const shirt = new THREE.MeshStandardMaterial({ color: 0x3a86ff, roughness: 0.7 });
const pants = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.8 });
const cap = (r: number, len: number, m: THREE.Material) => {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), m);
  mesh.castShadow = true;
  app.scene.add(mesh);
  return mesh;
};
const torsoMesh = cap(0.15, 0.32, shirt);
torsoMesh.scale.set(1, 1, 0.65);
const pelvisMesh = cap(0.12, 0.08, pants);
pelvisMesh.scale.set(1.15, 1, 0.7);
const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), skin);
headMesh.castShadow = true;
app.scene.add(headMesh);
const upper = [0, 1].map(() => cap(0.05, BODY.arm * 0.5, shirt));
const lower = [0, 1].map(() => cap(0.042, BODY.arm * 0.5, skin));
const thigh = [0, 1].map(() => cap(0.07, BODY.leg * 0.5, pants));
const shin = [0, 1].map(() => cap(0.055, BODY.leg * 0.5, pants));
const ends = [0, 1, 2, 3].map((l) => {
  const m = new THREE.Mesh(l < 2 ? new THREE.SphereGeometry(0.05, 12, 8) : new THREE.BoxGeometry(0.09, 0.07, 0.22), l < 2 ? skin : new THREE.MeshStandardMaterial({ color: 0xe2b53e }));
  m.castShadow = true;
  app.scene.add(m);
  return m;
});
const Y = new THREE.Vector3(0, 1, 0);
const place = (m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) => {
  m.position.lerpVectors(a, b, 0.5);
  m.quaternion.setFromUnitVectors(Y, new THREE.Vector3().subVectors(b, a).normalize());
};

/** Pose the climber: torso (u, v) on the wall and the four limb ends in world space. */
const ik = createTwoBoneResult();
function pose(torso: [number, number], limbEnds: THREE.Vector3[]): void {
  const chestTop = onWall(torso[0], torso[1] + 0.26, new THREE.Vector3(), 0.24);
  place(torsoMesh, onWall(torso[0], torso[1] - 0.05, new THREE.Vector3(), 0.24), chestTop);
  onWall(torso[0], torso[1] - 0.2, pelvisMesh.position, 0.22);
  pelvisMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(wallU, wallV, wallN));
  // Head: above the shoulders, looking up the wall toward the next holds.
  onWall(torso[0], torso[1] + 0.5, headMesh.position, 0.3);
  for (let limb = 0; limb < 4; limb++) {
    const [ru, rv] = root(limb, torso);
    const r = onWall(ru, rv, new THREE.Vector3(), limb < 2 ? 0.24 : 0.2);
    const end = limbEnds[limb];
    const side = limb % 2 === 0 ? -1 : 1;
    // Elbows down and out, knees out to the side (frog) and away from the wall.
    const pole = limb < 2 ? r.clone().addScaledVector(wallU, side * 0.5).addScaledVector(wallN, 0.3).addScaledVector(wallV, -0.4) : r.clone().addScaledVector(wallU, side * 0.3).addScaledVector(wallN, 0.4).addScaledVector(wallV, -0.15);
    const len = limb < 2 ? BODY.arm * 0.5 : BODY.leg * 0.5;
    solveTwoBone(r, end, pole, len, len, { softness: 0.02 }, ik);
    if (limb < 2) {
      place(upper[limb], r, ik.mid);
      place(lower[limb], ik.mid, ik.end);
    } else {
      place(thigh[limb - 2], r, ik.mid);
      place(shin[limb - 2], ik.mid, ik.end);
    }
    ends[limb].position.copy(ik.end);
    if (limb >= 2) ends[limb].quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(wallU, wallN.clone().cross(wallU).negate(), wallN));
  }
}

// ---------------------------------------------------------------------------------------- the climb

const PHASE_A = 0.35; // shift the weight onto the other three
const PHASE_B = 0.55; // move the limb
const PHASE_C = 0.15; // settle
let moveIndex = 0;
let moveTime = 0;
let pauseAt = 0;
const smooth = (x: number) => x * x * (3 - 2 * x);
const holdPoint = (i: number, out = new THREE.Vector3()) => onWall(holds[i].u, holds[i].v, out, 0.04);

app.onFixedUpdate((dt) => {
  if (!plan) return;
  if (moveIndex >= plan.stances.length - 1) {
    pauseAt += dt;
    if (pauseAt > 2.5) {
      moveIndex = 0;
      moveTime = 0;
      pauseAt = 0;
    }
    return;
  }
  moveTime += dt * settings.speed;
  if (moveTime > PHASE_A + PHASE_B + PHASE_C) {
    moveTime = 0;
    moveIndex++;
  }
});

const ends3 = [0, 1, 2, 3].map(() => new THREE.Vector3());
app.onFrame(() => {
  if (!plan) return;
  const k = Math.min(moveIndex, plan.stances.length - 1);
  const s0 = plan.stances[k];
  const t0 = plan.torsos[k];
  if (k >= plan.stances.length - 1) {
    for (let l = 0; l < 4; l++) holdPoint(s0[l], ends3[l]);
    pose(t0, ends3);
  } else {
    const s1 = plan.stances[k + 1];
    const t1 = plan.torsos[k + 1];
    const limb = [0, 1, 2, 3].find((l) => s0[l] !== s1[l])!;
    const during = s0.slice();
    during[limb] = -1;
    const hang = placeTorso(holds, during, t0).torso;
    let torso: [number, number];
    for (let l = 0; l < 4; l++) holdPoint(s0[l], ends3[l]);
    if (moveTime < PHASE_A) {
      const a = smooth(moveTime / PHASE_A);
      torso = [t0[0] + (hang[0] - t0[0]) * a, t0[1] + (hang[1] - t0[1]) * a];
    } else {
      const a = smooth(Math.min(1, (moveTime - PHASE_A) / PHASE_B));
      torso = [hang[0] + (t1[0] - hang[0]) * a, hang[1] + (t1[1] - hang[1]) * a];
      // The moving limb arcs away from the wall between holds.
      const from = holdPoint(s0[limb]);
      const to = holdPoint(s1[limb]);
      ends3[limb].lerpVectors(from, to, a).addScaledVector(wallN, 0.15 * Math.sin(Math.PI * a));
    }
    pose(torso, ends3);
    // The route ahead: the moving limb's path.
    if (settings.plan) app.debug.line(holdPoint(s0[limb]), holdPoint(s1[limb]), 0xffd166);
  }
  if (settings.plan) {
    // The hands' route through the whole plan.
    for (const hand of [0, 1]) {
      for (let i = 1; i < plan.stances.length; i++) {
        const a = plan.stances[i - 1][hand];
        const b = plan.stances[i][hand];
        if (a !== b) app.debug.line(holdPoint(a), holdPoint(b), hand === 0 ? 0xff8a3d : 0x5fb3ff);
      }
    }
    // Reach circles of the limbs from the current torso.
    const [u, v] = plan.torsos[k];
    for (let limb = 0; limb < 4; limb++) {
      const [ru, rv] = root(limb, [u, v]);
      const pts: THREE.Vector3[] = [];
      for (let a = 0; a <= 40; a++) pts.push(onWall(ru + reach(limb) * Math.cos((a / 40) * Math.PI * 2), rv + reach(limb) * Math.sin((a / 40) * Math.PI * 2), new THREE.Vector3(), 0.02));
      app.debug.polyline(pts, limb < 2 ? 0x8a93a6 : 0x4a5160);
    }
  }
  simHooks.end();
  simHooks.begin();
});

// ---------------------------------------------------------------------------------------- controls

const pane = createPane(frame.controls);
pane.addButton({ title: 'New wall' }).on('click', () => {
  settings.seed++;
  buildWall();
  pane.refresh();
});
pane.addBinding(settings, 'spacing', { min: 0.26, max: 0.5, step: 0.01, label: 'hold spacing (m)' }).on('change', () => buildWall());
pane.addBinding(settings, 'overhang', { min: 0, max: 30, step: 1, label: 'overhang (°)' }).on('change', () => buildWall());
pane.addBinding(settings, 'speed', { min: 0.2, max: 3, step: 0.1 });
pane.addBinding(settings, 'plan', { label: 'show route & reach' });
const info = pane.addFolder({ title: 'Readout' });
info.addBinding(readout, 'route', { readonly: true });
info.addBinding(readout, 'search', { readonly: true, label: 'A*' });
const simHooks = addSimulationFolder(pane, app.loop);

buildWall();
app.start();
