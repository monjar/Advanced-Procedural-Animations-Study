#!/usr/bin/env node
// Convert a CMU (cgspeed) BVH walk into a compact, loopable clip for study 08.
//
//   node tools/bvh-to-clip.mjs <input.bvh> <output.json> [--source "CMU 02_01"]
//
// Steps: parse → metres (normalised leg length) → 60 Hz → foot contacts → one gait cycle between two
// right-foot contacts → face +Z → loop fix (distribute the end/start mismatch over the cycle) → JSON.
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/bvh-to-clip.mjs <input.bvh> <output.json> [--source name]');
  process.exit(1);
}
const source = rest[rest.indexOf('--source') + 1] ?? input;

const DROP = /Finger|Thumb|HandIndex/;
const TARGET_FPS = 60;
const LEG_LENGTH = 0.88; // metres, hip joint → ankle when straight

const { skeleton, clip } = new BVHLoader().parse(readFileSync(input, 'utf8'));
const bones = skeleton.bones.filter((b) => !DROP.test(b.name) && !b.name.startsWith('ENDSITE'));
const index = new Map(bones.map((b, i) => [b, i]));
const byName = Object.fromEntries(bones.map((b) => [b.name, b]));
const tracks = new Map(clip.tracks.map((t) => [t.name, t]));
const posTrack = tracks.get(`${bones[0].name}.position`);
const quatTracks = bones.map((b) => tracks.get(`${b.name}.quaternion`));
const srcFrames = posTrack.times.length;
const srcFps = Math.round(1 / (posTrack.times[1] - posTrack.times[0]));
const step = Math.max(1, Math.round(srcFps / TARGET_FPS));

// Scale: straight leg length (upper + lower leg bone offsets) → LEG_LENGTH.
const legRaw = byName.LeftLeg.position.length() + byName.LeftFoot.position.length();
const scale = LEG_LENGTH / legRaw;

function pose(frame) {
  const root = bones[0];
  root.position.fromArray(posTrack.values, frame * 3);
  bones.forEach((b, i) => b.quaternion.fromArray(quatTracks[i].values, frame * 4));
  root.updateMatrixWorld(true);
}

// Sample (skip frame 0, Hahne's added T-pose).
const frames = [];
for (let f = 1; f < srcFrames; f += step) frames.push(f);
const N0 = frames.length;
const world = (bone) => bone.getWorldPosition(new THREE.Vector3()).multiplyScalar(scale);
const FEET = { left: ['LeftFoot', 'LeftToeBase'], right: ['RightFoot', 'RightToeBase'] };
const feet = { left: [], right: [] };
const roots = [];
const rotations = [];
for (const f of frames) {
  pose(f);
  roots.push(world(bones[0]));
  rotations.push(bones.map((b) => b.quaternion.clone()));
  for (const side of ['left', 'right']) feet[side].push(FEET[side].map((n) => world(byName[n])));
}

// Ground: the lowest toe/ankle over the clip.
let ground = Infinity;
for (const side of ['left', 'right']) for (const [a, t] of feet[side]) ground = Math.min(ground, a.y, t.y);

// Contacts: ankle or toe near the ground and slow, then close short gaps.
const dt = step / srcFps;
function contacts(side) {
  const c = feet[side].map(([a, t], i) => {
    if (i === 0) return 0;
    const [pa, pt] = feet[side][i - 1];
    const va = Math.hypot(a.x - pa.x, a.z - pa.z) / dt;
    const vt = Math.hypot(t.x - pt.x, t.z - pt.z) / dt;
    const heel = a.y - ground < 0.13 && va < 0.45;
    const toe = t.y - ground < 0.05 && vt < 0.45;
    return heel || toe ? 1 : 0;
  });
  c[0] = c[1];
  for (let i = 1; i + 2 < c.length; i++) if (c[i - 1] && !c[i] && (c[i + 1] || c[i + 2])) c[i] = 1;
  for (let i = 1; i + 2 < c.length; i++) if (!c[i - 1] && c[i] && (!c[i + 1] || !c[i + 2])) c[i] = 0;
  return c;
}
const contact = { left: contacts('left'), right: contacts('right') };
const onsets = [];
for (let i = 1; i < N0; i++) if (contact.right[i] && !contact.right[i - 1]) onsets.push(i);
if (onsets.length < 2) {
  console.error(`need two right-foot contacts, found ${onsets.length}`);
  process.exit(2);
}
// Prefer the cycle nearest the middle of the take (steady-state walking).
let best = 0;
for (let k = 0; k + 1 < onsets.length; k++) {
  const mid = (onsets[k] + onsets[k + 1]) / 2;
  if (Math.abs(mid - N0 / 2) < Math.abs((onsets[best] + onsets[best + 1]) / 2 - N0 / 2)) best = k;
}
const a = onsets[best];
const b = onsets[best + 1];
const N = b - a;

// Face +Z: rotate about Y so the cycle's horizontal displacement points forward.
const disp = roots[b].clone().sub(roots[a]);
const heading = Math.atan2(disp.x, disp.z);
const face = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
const origin = roots[a].clone().setY(0);

const out = {
  source,
  attribution: 'The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.',
  fps: srcFps / step,
  frames: N,
  joints: bones.map((bone) => ({
    name: bone.name,
    parent: bone.parent && index.has(bone.parent) ? index.get(bone.parent) : -1,
    offset: bone.position.toArray().map((v, k) => (bone === bones[0] ? 0 : round(v * scale))),
  })),
  cycle: [round(0), round(0), round(disp.length())],
  root: [],
  rotations: [],
  contacts: { left: [], right: [] },
};

// Loop fix: distribute the rotation mismatch between frame b and frame a across the cycle.
const fixes = bones.map((_, j) => rotations[b][j].clone().multiply(rotations[a][j].clone().invert()).invert());
const heightFix = roots[a].y - roots[b].y;
const lateral = disp.clone().applyQuaternion(face); // ≈ (0, dy, |d|)
for (let i = 0; i < N; i++) {
  const t = i / N;
  const r = roots[a + i].clone().sub(origin).applyQuaternion(face);
  r.y += heightFix * t - ground;
  r.x -= lateral.x * t; // remove residual sideways drift so cycles chain straight
  out.root.push(...r.toArray().map(round));
  rotations[a + i].forEach((q, j) => {
    const fixed = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), fixes[j], t).multiply(q);
    if (j === 0) fixed.premultiply(face);
    out.rotations.push(...fixed.toArray().map(round));
  });
  out.contacts.left.push(contact.left[a + i]);
  out.contacts.right.push(contact.right[a + i]);
}
writeFileSync(output, JSON.stringify(out));

const pct = (c) => Math.round((c.reduce((s, x) => s + x, 0) / c.length) * 100);
console.log(
  `${source}: ${srcFrames} frames @ ${srcFps} Hz → cycle ${a}..${b} (${N} frames @ ${out.fps} Hz, ${(N / out.fps).toFixed(2)} s), ` +
    `stride ${disp.length().toFixed(2)} m, stance L ${pct(out.contacts.left)}% R ${pct(out.contacts.right)}%, scale ${scale.toFixed(4)}, ` +
    `onsets ${onsets.join(',')}, ${bones.length} joints`,
);

function round(v) {
  return Math.round(v * 1e5) / 1e5;
}
