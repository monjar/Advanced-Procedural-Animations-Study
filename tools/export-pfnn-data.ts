// Export training data for the phase-functioned network (study 26):
//
//   npx rolldown tools/export-pfnn-data.ts --platform node -o /tmp/export-pfnn.mjs && node /tmp/export-pfnn.mjs
//
// For every usable frame f of the study 09 database (mirrored takes included), in the simulation bone's frame:
//   X (input, 176):  trajectory 30/20/10 frames back and 10/20/30 ahead — position (x, z) and facing (sin, cos)
//                    — a walk/run label, then the 25 joints' positions and velocities at f
//   Y (output, 309): frame f+1's pose vector (study 16's 158: hips, 6-D rotations, root motion, contacts), its
//                    joint positions and velocities in its own bone frame, and the phase change
//   phase:           0 at each left touch-down, 0.5 at each right one, linear between (frames outside the first
//                    and last touch-down of a take, and idle takes, are dropped)
// Writes training/pfnn/data/ (not committed) and public/assets/pfnn/model.json (skeleton, layout).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { forwardKinematics, skeletonDef } from '../src/anim/fk';
import { parseMotionDB } from '../src/anim/mmdb';
import { buildFeatures, wrapAngle } from '../src/anim/mmfeatures';
import { encodePose, Y_DIMS } from '../demos/16-learned-motion-matching/pose';

const TRAJ = [-30, -20, -10, 10, 20, 30];
const bytes = readFileSync('public/assets/mocap/cmu16-mm.bin');
const db = parseMotionDB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
const mf = buildFeatures(db);
const J = db.joints.length;
const skel = skeletonDef(db.joints);
const X_DIMS = TRAJ.length * 4 + 2 + J * 6;
const OUT_DIMS = Y_DIMS + J * 6 + 1;

// World joint positions for every frame.
const world = new Float32Array(db.frames * J * 3);
const pos = new Float32Array(J * 3);
const rot = new Float32Array(J * 4);
for (let f = 0; f < db.frames; f++) {
  forwardKinematics(skel, db.root, f * 3, db.rot, f * J * 4, pos, rot);
  world.set(pos, f * J * 3);
}
/** World (dx, dz) into the bone frame of frame f (yaw about +y; yaw 0 faces +z). */
const toBone = (f: number, dx: number, dz: number): [number, number] => {
  const y = mf.simYaw[f];
  const c = Math.cos(y);
  const s = Math.sin(y);
  return [c * dx - s * dz, s * dx + c * dz];
};
function jointsInBone(f: number, out: Float32Array, o: number): void {
  const fps = db.fps;
  for (let j = 0; j < J; j++) {
    const k = (f * J + j) * 3;
    const [x, z] = toBone(f, world[k] - mf.simPos[f * 2], world[k + 2] - mf.simPos[f * 2 + 1]);
    out[o + j * 3] = x;
    out[o + j * 3 + 1] = world[k + 1];
    out[o + j * 3 + 2] = z;
    const p = ((f - 1) * J + j) * 3;
    const [vx, vz] = toBone(f, (world[k] - world[p]) * fps, (world[k + 2] - world[p + 2]) * fps);
    out[o + J * 3 + j * 3] = vx;
    out[o + J * 3 + j * 3 + 1] = (world[k + 1] - world[p + 1]) * fps;
    out[o + J * 3 + j * 3 + 2] = vz;
  }
}

const Xs: number[] = [];
const Ys: number[] = [];
const phases: number[] = [];
const takeOf: number[] = [];
const x = new Float32Array(X_DIMS);
const y = new Float32Array(OUT_DIMS);
let used = 0;
db.takes.forEach((take, ti) => {
  const a = take.start;
  const b = take.start + take.frames;
  // Touch-down events → phase anchors.
  const events: { f: number; side: 0 | 1 }[] = [];
  for (let f = a + 1; f < b; f++)
    for (const side of [0, 1] as const) if (db.contacts[f * 2 + side] && !db.contacts[(f - 1) * 2 + side]) events.push({ f, side });
  if (events.length < 3) return;
  const anchors: { f: number; v: number }[] = [];
  let v = events[0].side === 0 ? 0 : 0.5;
  anchors.push({ f: events[0].f, v });
  for (const e of events.slice(1)) {
    // The next value with this foot's parity: left at integers, right at halves.
    const target = e.side === 0 ? Math.floor(v) + 1 : Math.floor(v - 0.5) + 1.5;
    v = target <= v ? target + 1 : target;
    anchors.push({ f: e.f, v });
  }
  const phaseAt = (f: number): number => {
    for (let i = 0; i < anchors.length - 1; i++)
      if (f >= anchors[i].f && f <= anchors[i + 1].f) return anchors[i].v + ((f - anchors[i].f) / (anchors[i + 1].f - anchors[i].f)) * (anchors[i + 1].v - anchors[i].v);
    return NaN;
  };
  for (let f = Math.max(a + 31, anchors[0].f); f < Math.min(b - 31, anchors[anchors.length - 1].f); f++) {
    const p0 = phaseAt(f);
    const p1 = phaseAt(f + 1);
    if (!Number.isFinite(p0) || !Number.isFinite(p1)) continue;
    let k = 0;
    for (const o of TRAJ) {
      const g = f + o;
      const [px, pz] = toBone(f, mf.simPos[g * 2] - mf.simPos[f * 2], mf.simPos[g * 2 + 1] - mf.simPos[f * 2 + 1]);
      const d = wrapAngle(mf.simYaw[g] - mf.simYaw[f]);
      x[k++] = px;
      x[k++] = pz;
      x[k++] = Math.sin(d);
      x[k++] = Math.cos(d);
    }
    // Gait label from the take (the paper's gait input): walking vs running/jogging.
    const running = /run|jog/.test(take.description);
    x[k++] = running ? 0 : 1;
    x[k++] = running ? 1 : 0;
    jointsInBone(f, x, k);
    encodePose(mf, f + 1, y, 0);
    jointsInBone(f + 1, y, Y_DIMS);
    y[OUT_DIMS - 1] = p1 - p0;
    for (const v2 of x) Xs.push(v2);
    for (const v2 of y) Ys.push(v2);
    phases.push(p0 - Math.floor(p0));
    takeOf.push(ti);
    used++;
  }
});

const out = 'training/pfnn/data';
mkdirSync(out, { recursive: true });
const write = (name: string, a: ArrayBufferView) => writeFileSync(`${out}/${name}`, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
write('X.f32', Float32Array.from(Xs));
write('Y.f32', Float32Array.from(Ys));
write('phase.f32', Float32Array.from(phases));
write('take.i32', Int32Array.from(takeOf));
writeFileSync(`${out}/meta.json`, JSON.stringify({ frames: used, xDims: X_DIMS, yDims: OUT_DIMS, poseDims: Y_DIMS, joints: J, traj: TRAJ, takes: db.takes.length }));
mkdirSync('public/assets/pfnn', { recursive: true });
writeFileSync(
  'public/assets/pfnn/model.json',
  JSON.stringify({ traj: TRAJ, xDims: X_DIMS, yDims: OUT_DIMS, poseDims: Y_DIMS, joints: J, parents: db.joints.map((j) => j.parent), offsets: db.joints.map((j) => j.offset), names: db.joints.map((j) => j.name), fps: db.fps }),
);
console.log(`exported ${used} frames (${X_DIMS} → ${OUT_DIMS}) from ${db.takes.length} takes`);
