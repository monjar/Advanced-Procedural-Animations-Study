/**
 * Motion-matching database (study 09): decoding of `tools/build-mm-db.mjs` output, quaternion hemisphere
 * repair and left/right mirroring. Poses are stored as local joint rotations (the root rotation is in
 * world space) plus the root position, in metres, at 60 Hz.
 */

export interface MMJoint {
  name: string;
  parent: number;
  offset: [number, number, number];
}

export interface MMTake {
  name: string;
  description: string;
  /** First frame and frame count in the database arrays. */
  start: number;
  frames: number;
  mirrored: boolean;
}

export interface MotionDB {
  fps: number;
  joints: MMJoint[];
  takes: MMTake[];
  /** Total frames (including mirrored copies). */
  frames: number;
  /** Root (hips) world position per frame [frames·3]. */
  root: Float32Array;
  /** Local joint rotations per frame [frames·joints·4], xyzw; joint 0 is the root's world rotation. */
  rot: Float32Array;
  /** Foot contact labels per frame [frames·2] (left, right). */
  contacts: Uint8Array;
  /** Take index per frame. */
  take: Int32Array;
  source: string;
  attribution: string;
}

interface Header {
  source: string;
  attribution: string;
  fps: number;
  frames: number;
  joints: MMJoint[];
  takes: { name: string; description: string; start: number; frames: number }[];
}

/** Name of a joint's mirror partner: Left↔Right, and the CMU short forms LHipJoint↔RHipJoint. */
function partnerName(n: string): string {
  if (n.startsWith('Left')) return 'Right' + n.slice(4);
  if (n.startsWith('Right')) return 'Left' + n.slice(5);
  if (/^L[A-Z]/.test(n)) return 'R' + n.slice(1);
  if (/^R[A-Z]/.test(n)) return 'L' + n.slice(1);
  return n;
}

/** Index of each joint's mirror partner (itself for centre joints). */
export function mirrorPartners(joints: readonly MMJoint[]): Int32Array {
  const names = joints.map((j) => j.name);
  return Int32Array.from(names, (n, i) => {
    const k = names.indexOf(partnerName(n));
    return k >= 0 ? k : i;
  });
}

/**
 * Parse the binary database. With `mirror`, every take is appended again reflected through the character's
 * sagittal plane (x → −x; the CMU rig faces +Z with its left on +X): positions (−x, y, z), rotations
 * (x, −y, −z, w) with left and right joints swapped, contacts swapped. Exact for bones with identity rest
 * orientation, as in BVH; the skeleton's own small asymmetry (≈1 cm at the shoulders) stays.
 */
export function parseMotionDB(buffer: ArrayBuffer, mirror = true): MotionDB {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'MMDB') throw new Error('not a motion database');
  if (view.getUint32(4, true) !== 1) throw new Error('unsupported motion database version');
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength))) as Header;
  const N = header.frames;
  const J = header.joints.length;
  let o = 12 + Math.ceil(headerLength / 4) * 4;
  const rootIn = new Float32Array(buffer, o, N * 3);
  o += N * 3 * 4;
  const hipsIn = new Float32Array(buffer, o, N * 4);
  o += N * 4 * 4;
  const rotsIn = new Int16Array(buffer, o, N * (J - 1) * 3);
  o += Math.ceil((N * (J - 1) * 3 * 2) / 4) * 4;
  const contactsIn = new Uint8Array(buffer, o, N * 2);

  const total = mirror ? 2 * N : N;
  const root = new Float32Array(total * 3);
  const rot = new Float32Array(total * J * 4);
  const contacts = new Uint8Array(total * 2);
  const take = new Int32Array(total);
  root.set(rootIn);
  contacts.set(contactsIn);
  for (let f = 0; f < N; f++) {
    const b = f * J * 4;
    rot.set(hipsIn.subarray(f * 4, f * 4 + 4), b);
    for (let j = 1; j < J; j++) {
      const k = (f * (J - 1) + (j - 1)) * 3;
      const x = rotsIn[k] / 32767;
      const y = rotsIn[k + 1] / 32767;
      const z = rotsIn[k + 2] / 32767;
      const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
      const inv = 1 / Math.hypot(x, y, z, w);
      rot.set([x * inv, y * inv, z * inv, w * inv], b + j * 4);
    }
  }

  const takes: MMTake[] = header.takes.map((t) => ({ ...t, mirrored: false }));
  for (const t of takes) {
    take.fill(takes.indexOf(t), t.start, t.start + t.frames);
    fixHemispheres(rot, J, t.start, t.frames);
  }

  if (mirror) {
    const partner = mirrorPartners(header.joints);
    for (let f = 0; f < N; f++) {
      const g = N + f;
      root[g * 3] = -root[f * 3];
      root[g * 3 + 1] = root[f * 3 + 1];
      root[g * 3 + 2] = root[f * 3 + 2];
      for (let j = 0; j < J; j++) {
        const s = (f * J + partner[j]) * 4;
        const d = (g * J + j) * 4;
        rot[d] = rot[s];
        rot[d + 1] = -rot[s + 1];
        rot[d + 2] = -rot[s + 2];
        rot[d + 3] = rot[s + 3];
      }
      contacts[g * 2] = contacts[f * 2 + 1];
      contacts[g * 2 + 1] = contacts[f * 2];
    }
    const n = takes.length;
    for (let i = 0; i < n; i++) {
      const t = takes[i];
      takes.push({ ...t, start: N + t.start, mirrored: true });
      take.fill(n + i, N + t.start, N + t.start + t.frames);
    }
  }

  return {
    fps: header.fps,
    joints: header.joints,
    takes,
    frames: total,
    root,
    rot,
    contacts,
    take,
    source: header.source,
    attribution: header.attribution,
  };
}

/**
 * Make each joint's quaternion track continuous within a take (q and −q are the same rotation; storage
 * forces w ≥ 0, so a track through w = 0 flips sign). Finite differences need neighbouring frames in the
 * same hemisphere.
 */
export function fixHemispheres(rot: Float32Array, joints: number, start: number, frames: number): void {
  for (let j = 0; j < joints; j++) {
    for (let f = start + 1; f < start + frames; f++) {
      const a = ((f - 1) * joints + j) * 4;
      const b = (f * joints + j) * 4;
      if (rot[a] * rot[b] + rot[a + 1] * rot[b + 1] + rot[a + 2] * rot[b + 2] + rot[a + 3] * rot[b + 3] < 0) {
        rot[b] = -rot[b];
        rot[b + 1] = -rot[b + 1];
        rot[b + 2] = -rot[b + 2];
        rot[b + 3] = -rot[b + 3];
      }
    }
  }
}
