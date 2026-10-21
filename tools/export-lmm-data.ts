// Export the study 09 database as training data for Learned Motion Matching (study 16):
//
//   npx rolldown tools/export-lmm-data.ts --platform node -o /tmp/export-lmm.mjs && node /tmp/export-lmm.mjs
//
// Writes training/lmm/data/: per frame the normalised matching features X (study 09's, 27-D) and the pose Y
// (see Y_LAYOUT in demos/16-learned-motion-matching/pose.ts), plus take indices, matchability, the skeleton and
// the feature statistics. The networks are trained on exactly what study 09 searches and plays.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseMotionDB } from '../src/anim/mmdb';
import { buildFeatures, DIMS, DEFAULT_WEIGHTS, dimWeights, GROUPS, GROUP_START } from '../src/anim/mmfeatures';
import { encodePose, Y_DIMS } from '../demos/16-learned-motion-matching/pose';

const bytes = readFileSync('public/assets/mocap/cmu16-mm.bin');
const db = parseMotionDB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
const mf = buildFeatures(db);
const N = db.frames;
const J = db.joints.length;

const Y = new Float32Array(N * Y_DIMS);
for (let f = 0; f < N; f++) encodePose(mf, f, Y, f * Y_DIMS);

const out = 'training/lmm/data';
mkdirSync(out, { recursive: true });
const write = (name: string, a: ArrayBufferView) => writeFileSync(`${out}/${name}`, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
write('X.f32', mf.features);
write('Y.f32', Y);
write('take.i32', db.take);
write('matchable.u8', mf.matchable);
writeFileSync(
  `${out}/meta.json`,
  JSON.stringify({
    frames: N,
    joints: J,
    xDims: DIMS,
    yDims: Y_DIMS,
    fps: db.fps,
    parents: db.joints.map((j) => j.parent),
    offsets: db.joints.map((j) => j.offset),
    names: db.joints.map((j) => j.name),
    featureWeights: Array.from(dimWeights(DEFAULT_WEIGHTS)),
    takes: db.takes.map((t) => ({ start: t.start, frames: t.frames, description: t.description })),
  }),
);
// What the learned runtime needs besides its networks: the skeleton, and how to normalise a query (the same
// per-dimension mean and per-group scale as study 09, expanded to one value per dimension).
const scaleDims = new Float32Array(DIMS);
const idleStart = (db.takes.find((t) => t.description === 'idle') ?? db.takes[0]).start;
GROUPS.forEach((g, gi) => scaleDims.fill(mf.scale[gi], GROUP_START[gi], GROUP_START[gi] + g.size));
mkdirSync('public/assets/lmm', { recursive: true });
writeFileSync(
  'public/assets/lmm/model.json',
  JSON.stringify({
    fps: db.fps,
    joints: db.joints,
    featureMean: Array.from(mf.mean),
    featureScale: Array.from(scaleDims),
    featureWeights: Array.from(dimWeights(DEFAULT_WEIGHTS)),
    startX: Array.from(mf.features.subarray((idleStart + 20) * DIMS, (idleStart + 21) * DIMS)),
    leftFoot: mf.leftFoot,
    rightFoot: mf.rightFoot,
    attribution: db.attribution,
  }),
);
console.log(`exported ${N} frames: X ${DIMS}, Y ${Y_DIMS} → ${out}, and public/assets/lmm/model.json`);
