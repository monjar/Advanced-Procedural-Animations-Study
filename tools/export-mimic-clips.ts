// Export mocap takes for physics-based tracking (study 21):
//
//   npx rolldown tools/export-mimic-clips.ts --platform node -o /tmp/export-mimic.mjs && node /tmp/export-mimic.mjs
//
// Writes training/mimic/takes.json: for each take, every frame's world joint positions and rotations (the
// skeleton's own y-up frame, xyzw) from forward kinematics over the study 09 database, plus the rest pose.
// training/mimic/humanoid.py builds the MuJoCo humanoid from the rest pose and retargets these to its joints.
import { readFileSync, writeFileSync } from 'node:fs';
import { forwardKinematics, skeletonDef } from '../src/anim/fk';
import { parseMotionDB } from '../src/anim/mmdb';

const TAKES = { walk: '16_15', run: '16_55' };

const bytes = readFileSync('public/assets/mocap/cmu16-mm.bin');
const db = parseMotionDB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, false);
const skel = skeletonDef(db.joints);
const J = db.joints.length;
const pos = new Float32Array(J * 3);
const rot = new Float32Array(J * 4);
const round = (a: ArrayLike<number>) => Array.from(a, (v) => Math.round(v * 1e5) / 1e5);

const rest = new Float32Array(J * 3);
const identity = new Float32Array(J * 4).map((_, i) => (i % 4 === 3 ? 1 : 0));
forwardKinematics(skel, [0, 0, 0], 0, identity, 0, rest, new Float32Array(J * 4));

const takes: Record<string, { frames: number; positions: number[][]; rotations: number[][] }> = {};
for (const [name, id] of Object.entries(TAKES)) {
  const t = db.takes.find((x) => x.name === id)!;
  const positions: number[][] = [];
  const rotations: number[][] = [];
  for (let f = t.start; f < t.start + t.frames; f++) {
    forwardKinematics(skel, db.root, f * 3, db.rot, f * J * 4, pos, rot);
    positions.push(round(pos));
    rotations.push(round(rot));
  }
  takes[name] = { frames: t.frames, positions, rotations };
}
writeFileSync(
  'training/mimic/takes.json',
  JSON.stringify({ fps: db.fps, source: db.source, attribution: db.attribution, names: db.joints.map((j) => j.name), parents: db.joints.map((j) => j.parent), rest: round(rest), takes: Object.fromEntries(Object.entries(TAKES).map(([k, v]) => [k, { id: v, ...takes[k] }])) }),
);
console.log('wrote training/mimic/takes.json');
