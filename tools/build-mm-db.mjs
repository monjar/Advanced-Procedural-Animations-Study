#!/usr/bin/env node
// Build the motion-matching database for study 09 from CMU subject 16 (cgspeed BVH conversion).
//
//   bash tools/fetch-cmu16.sh && node tools/build-mm-db.mjs [.cache/cmu16] [public/assets/mocap/cmu16-mm.bin]
//
// The tool only cleans and packs the data: true CMU scale (metres), 120 → 60 Hz, T-pose frame dropped,
// fingers dropped (25 joints), per-take ground removed, foot contact labels, standing segments cut out of
// the jump takes as idle data. Everything derived (simulation bone, mirroring, features) is computed at load
// time in TypeScript (src/anim/mmdb.ts) so one tested implementation serves the page and the tests.
//
// Binary layout (little endian): 'MMDB' · u32 version · u32 header bytes · header JSON (padded to 4) ·
//   Float32 root positions [N·3] · Float32 hip rotations [N·4] · Int16 joint rotations [N·(J−1)·3]
//   (x, y, z of a unit quaternion with w ≥ 0, scaled by 32767; padded to 4) · Uint8 contacts [N·2].
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';

const [dir = '.cache/cmu16', output = 'public/assets/mocap/cmu16-mm.bin'] = process.argv.slice(2);

/** CMU ASF length unit: inches / 0.45. */
const SCALE = 0.0254 / 0.45;
const DROP = /Finger|Thumb|HandIndex/;
const MAX_QUANT_ERROR_DEG = 0.05;

// Locomotion takes (descriptions from the CMU index) and jump takes whose standing start becomes idle data.
const TAKES = {
  '08': 'run/jog, sudden stop',
  11: 'walk, veer left', 12: 'walk, veer left', 13: 'walk, veer right', 14: 'walk, veer right',
  15: 'walk', 16: 'walk',
  17: 'walk, 90-degree left turn', 18: 'walk, 90-degree left turn',
  19: 'walk, 90-degree right turn', 20: 'walk, 90-degree right turn',
  21: 'walk', 22: 'walk',
  23: 'walk, veer left', 24: 'walk, veer left', 25: 'walk, veer right', 26: 'walk, veer right',
  27: 'walk, 90-degree left turn', 28: 'walk, 90-degree left turn',
  29: 'walk, 90-degree right turn', 30: 'walk, 90-degree right turn',
  31: 'walk', 32: 'walk', 33: 'slow walk, stop', 34: 'slow walk, stop',
  35: 'run/jog', 36: 'run/jog', 37: 'run/jog, veer left', 38: 'run/jog, veer left',
  39: 'run/jog, veer right', 40: 'run/jog, veer right',
  41: 'run/jog, 90-degree left turn', 42: 'run/jog, 90-degree left turn',
  43: 'run/jog, 90-degree right turn', 44: 'run/jog, 90-degree right turn',
  45: 'run/jog', 46: 'run/jog', 47: 'walk', 48: 'run, veer left', 49: 'run, veer right', 50: 'run, veer right',
  51: 'run, 90-degree left turn', 52: 'run, 90-degree left turn',
  53: 'run, 90-degree right turn', 54: 'run, 90-degree right turn',
  55: 'run', 56: 'run/jog', 57: 'run/jog, sudden stop', 58: 'walk',
};
const IDLE_SOURCES = ['02', '06', '09', '10'];

function load(id) {
  const { skeleton, clip } = new BVHLoader().parse(readFileSync(`${dir}/16_${id}.bvh`, 'utf8'));
  const bones = skeleton.bones.filter((b) => !DROP.test(b.name) && !b.name.startsWith('ENDSITE'));
  const tracks = new Map(clip.tracks.map((t) => [t.name, t]));
  const pos = tracks.get(`${bones[0].name}.position`);
  const quats = bones.map((b) => tracks.get(`${b.name}.quaternion`));
  const srcFps = Math.round(1 / (pos.times[1] - pos.times[0]));
  const step = srcFps / 60;
  if (step !== 2) throw new Error(`16_${id}: expected 120 Hz, got ${srcFps}`);
  const byName = Object.fromEntries(bones.map((b) => [b.name, b]));
  const frames = [];
  // Frame 0 is the T-pose Hahne added; resample 120 → 60 Hz.
  for (let f = 1; f < pos.times.length; f += step) {
    bones[0].position.fromArray(pos.values, f * 3);
    bones.forEach((b, j) => b.quaternion.fromArray(quats[j].values, f * 4));
    bones[0].updateMatrixWorld(true);
    const w = (n) => byName[n].getWorldPosition(new THREE.Vector3()).multiplyScalar(SCALE);
    frames.push({
      root: bones[0].position.clone().multiplyScalar(SCALE),
      rots: bones.map((b) => b.quaternion.clone()),
      feet: { left: [w('LeftFoot'), w('LeftToeBase')], right: [w('RightFoot'), w('RightToeBase')] },
    });
  }
  return { bones, frames };
}

/** Lowest toe/ankle height (2nd percentile, robust to marker glitches). */
function groundOf(frames) {
  const h = [];
  for (const f of frames) for (const side of ['left', 'right']) h.push(f.feet[side][0].y, f.feet[side][1].y);
  h.sort((a, b) => a - b);
  return h[Math.floor(h.length * 0.02)];
}

/** Ankle or toe near the ground and slow, then short gaps closed (as tools/bvh-to-clip.mjs). */
function contacts(frames, side, ground) {
  const dt = 1 / 60;
  const c = frames.map((f, i) => {
    if (i === 0) return 0;
    const [a, t] = f.feet[side];
    const [pa, pt] = frames[i - 1].feet[side];
    const va = Math.hypot(a.x - pa.x, a.z - pa.z) / dt;
    const vt = Math.hypot(t.x - pt.x, t.z - pt.z) / dt;
    return (a.y - ground < 0.13 && va < 0.45) || (t.y - ground < 0.05 && vt < 0.45) ? 1 : 0;
  });
  if (c.length > 1) c[0] = c[1];
  for (let i = 1; i + 2 < c.length; i++) if (c[i - 1] && !c[i] && (c[i + 1] || c[i + 2])) c[i] = 1;
  for (let i = 1; i + 2 < c.length; i++) if (!c[i - 1] && c[i] && (!c[i + 1] || !c[i + 2])) c[i] = 0;
  return c;
}

/** Standing start of a jump take: until the hip drops 3 cm or the root moves faster than 0.15 m/s. */
function standingEnd(frames) {
  const h0 = frames[0].root.y;
  for (let i = 1; i < frames.length; i++) {
    const v = Math.hypot(frames[i].root.x - frames[i - 1].root.x, frames[i].root.z - frames[i - 1].root.z) * 60;
    if (frames[i].root.y < h0 - 0.03 || v > 0.15) return i - 10; // stop before the wind-up starts
  }
  return frames.length;
}

const takes = [];
let skeleton;
const all = [];
for (const [id, description] of [...Object.entries(TAKES).map(([k, d]) => [k.padStart(2, '0'), d]), ...IDLE_SOURCES.map((k) => [k, 'idle'])]) {
  const { bones, frames } = load(id);
  if (!skeleton) {
    const index = new Map(bones.map((b, i) => [b, i]));
    skeleton = bones.map((b, i) => ({
      name: b.name,
      parent: i === 0 ? -1 : index.get(b.parent),
      offset: i === 0 ? [0, 0, 0] : b.position.toArray().map((v) => +(v * SCALE).toFixed(6)),
    }));
  } else if (bones.map((b) => b.name).join() !== skeleton.map((j) => j.name).join()) {
    throw new Error(`16_${id}: skeleton differs`);
  }
  const ground = groundOf(frames);
  let used = frames;
  if (description === 'idle') {
    used = frames.slice(0, standingEnd(frames));
    if (used.length < 30) {
      console.warn(`16_${id}: standing start only ${used.length} frames, skipped`);
      continue;
    }
  }
  const left = contacts(used, 'left', ground);
  const right = contacts(used, 'right', ground);
  takes.push({ name: `16_${id}`, description, start: all.length, frames: used.length });
  used.forEach((f, i) => all.push({ ...f, root: f.root.clone().setY(f.root.y - ground), contact: [left[i], right[i]] }));
}

const N = all.length;
const J = skeleton.length;
const header = {
  source: 'CMU Graphics Lab Motion Capture Database, subject 16 (cgspeed BVH conversion by Bruce Hahne)',
  attribution:
    'The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.',
  fps: 60,
  frames: N,
  joints: skeleton,
  takes,
};
const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
const headerPadded = Math.ceil(headerBytes.length / 4) * 4;
const rootBytes = N * 3 * 4;
const hipBytes = N * 4 * 4;
const rotBytes = Math.ceil((N * (J - 1) * 3 * 2) / 4) * 4;
const total = 12 + headerPadded + rootBytes + hipBytes + rotBytes + N * 2;
const buf = Buffer.alloc(total);
buf.write('MMDB', 0, 'ascii');
buf.writeUInt32LE(1, 4);
buf.writeUInt32LE(headerBytes.length, 8);
headerBytes.copy(buf, 12);
let o = 12 + headerPadded;
const root = new Float32Array(buf.buffer, buf.byteOffset + o, N * 3);
o += rootBytes;
const hips = new Float32Array(buf.buffer, buf.byteOffset + o, N * 4);
o += hipBytes;
const rots = new Int16Array(buf.buffer, buf.byteOffset + o, N * (J - 1) * 3);
o += rotBytes;
const cont = new Uint8Array(buf.buffer, buf.byteOffset + o, N * 2);

let maxErr = 0;
const q = new THREE.Quaternion();
all.forEach((f, i) => {
  root.set([f.root.x, f.root.y, f.root.z], i * 3);
  const h = f.rots[0].clone().normalize();
  hips.set([h.x, h.y, h.z, h.w], i * 4);
  for (let j = 1; j < J; j++) {
    q.copy(f.rots[j]).normalize();
    if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    const k = (i * (J - 1) + (j - 1)) * 3;
    rots[k] = Math.round(q.x * 32767);
    rots[k + 1] = Math.round(q.y * 32767);
    rots[k + 2] = Math.round(q.z * 32767);
    const x = rots[k] / 32767;
    const y = rots[k + 1] / 32767;
    const z = rots[k + 2] / 32767;
    const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    const dot = Math.min(1, Math.abs(x * q.x + y * q.y + z * q.z + w * q.w));
    maxErr = Math.max(maxErr, THREE.MathUtils.radToDeg(2 * Math.acos(dot)));
  }
  cont[i * 2] = f.contact[0];
  cont[i * 2 + 1] = f.contact[1];
});
if (maxErr > MAX_QUANT_ERROR_DEG) throw new Error(`quantisation error ${maxErr.toFixed(4)}° > ${MAX_QUANT_ERROR_DEG}°`);
writeFileSync(output, buf);
const idle = takes.filter((t) => t.description === 'idle');
console.log(
  `${takes.length} takes (${idle.length} idle: ${idle.map((t) => `${t.name} ${(t.frames / 60).toFixed(2)} s`).join(', ')}), ` +
    `${N} frames (${(N / 60).toFixed(1)} s), ${J} joints, ${(total / 1024).toFixed(0)} KB, max quantisation error ${maxErr.toFixed(4)}°`,
);
