import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { parseMotionDB, mirrorPartners } from '../../src/anim/mmdb';
import { forwardKinematics, qrot, skeletonDef } from '../../src/anim/fk';
import { loadMotionDB, MMDB_PATH } from '../support/mmdb';

const db = loadMotionDB();
const J = db.joints.length;

function heading(frame: number): number {
  const f = [0, 0, 0];
  qrot(db.rot, frame * J * 4, [0, 0, 1], 0, f, 0);
  return Math.atan2(f[0], f[2]);
}
function wrapDeg(r: number): number {
  return ((((r * 180) / Math.PI + 540) % 360) + 360) % 360 - 180;
}
function medianSpeed(t: (typeof db.takes)[number]): number {
  const s: number[] = [];
  for (let f = t.start; f + 1 < t.start + t.frames; f++)
    s.push(Math.hypot(db.root[(f + 1) * 3] - db.root[f * 3], db.root[(f + 1) * 3 + 2] - db.root[f * 3 + 2]) * db.fps);
  s.sort((a, b) => a - b);
  return s[s.length >> 1];
}

describe('motion matching database (CMU subject 16)', () => {
  it('is compact and holds 53 takes, mirrored to 106', () => {
    expect(statSync(MMDB_PATH).size).toBeLessThan(1.3e6);
    expect(db.joints).toHaveLength(25);
    expect(db.takes).toHaveLength(106);
    expect(db.frames).toBe(2 * 7020);
    expect(db.takes.filter((t) => t.description === 'idle')).toHaveLength(8);
    for (const t of db.takes) for (let f = t.start; f < t.start + t.frames; f++) expect(db.take[f]).toBe(db.takes.indexOf(t));
  });

  it('decodes unit quaternions, continuous in time within every take', () => {
    let worstNorm = 0;
    let flips = 0;
    for (const t of db.takes) {
      for (let f = t.start; f < t.start + t.frames; f++) {
        for (let j = 0; j < J; j++) {
          const k = (f * J + j) * 4;
          worstNorm = Math.max(worstNorm, Math.abs(Math.hypot(db.rot[k], db.rot[k + 1], db.rot[k + 2], db.rot[k + 3]) - 1));
          if (f > t.start) {
            const p = k - J * 4;
            if (db.rot[k] * db.rot[p] + db.rot[k + 1] * db.rot[p + 1] + db.rot[k + 2] * db.rot[p + 2] + db.rot[k + 3] * db.rot[p + 3] < 0) flips++;
          }
        }
      }
    }
    expect(worstNorm).toBeLessThan(1e-6);
    expect(flips).toBe(0);
  });

  it('is in metres at true CMU scale: walks 0.8–1.8 m/s, runs 2–4.3 m/s, idle < 0.1 m/s', () => {
    for (const t of db.takes) {
      const v = medianSpeed(t);
      if (t.description === 'idle') expect(v).toBeLessThan(0.1);
      else if (/^(walk|slow walk)/.test(t.description)) expect(v).toBeGreaterThan(0.75), expect(v).toBeLessThan(1.8);
      else if (/^run/.test(t.description) && !/stop/.test(t.description)) expect(v).toBeGreaterThan(2), expect(v).toBeLessThan(4.3);
    }
    // Hip height ~1 m on a 0.84 m leg.
    expect(db.root[1]).toBeGreaterThan(0.9);
    expect(db.root[1]).toBeLessThan(1.05);
  });

  it('mirrors: left turns become right turns, contacts swap sides, and mirroring twice is exact', () => {
    const n = db.takes.length / 2;
    for (let i = 0; i < n; i++) {
      const t = db.takes[i];
      const m = db.takes[n + i];
      expect(m.mirrored).toBe(true);
      expect(m.frames).toBe(t.frames);
      const turn = wrapDeg(heading(t.start + t.frames - 1) - heading(t.start));
      const mturn = wrapDeg(heading(m.start + m.frames - 1) - heading(m.start));
      expect(Math.abs(turn + mturn)).toBeLessThan(0.5);
      if (/left turn/.test(t.description)) expect(turn).toBeGreaterThan(70);
      if (/right turn/.test(t.description)) expect(turn).toBeLessThan(-60);
      for (let f = 0; f < t.frames; f++) {
        expect(db.contacts[(m.start + f) * 2]).toBe(db.contacts[(t.start + f) * 2 + 1]);
      }
    }
    // Mirroring the mirrored half again reproduces the original bit for bit.
    const partner = mirrorPartners(db.joints);
    const half = db.frames / 2;
    let mismatches = 0;
    for (let f = 0; f < half; f += 7) {
      const g = half + f;
      if (-db.root[g * 3] !== db.root[f * 3]) mismatches++;
      for (let j = 0; j < J; j++) {
        const s = (g * J + partner[j]) * 4;
        const d = (f * J + j) * 4;
        if (db.rot[s] !== db.rot[d] || -db.rot[s + 1] !== db.rot[d + 1] || -db.rot[s + 2] !== db.rot[d + 2] || db.rot[s + 3] !== db.rot[d + 3]) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
    expect(mirrorPartners(db.joints).every((p, j) => mirrorPartners(db.joints)[p] === j)).toBe(true);
  });

  it('forward kinematics keeps every bone length on original and mirrored frames', () => {
    const skel = skeletonDef(db.joints);
    const pos = new Float32Array(J * 3);
    const rot = new Float32Array(J * 4);
    let worst = 0;
    for (let f = 0; f < db.frames; f += 53) {
      forwardKinematics(skel, db.root, f * 3, db.rot, f * J * 4, pos, rot);
      for (let j = 1; j < J; j++) {
        const p = db.joints[j].parent;
        const len = Math.hypot(pos[j * 3] - pos[p * 3], pos[j * 3 + 1] - pos[p * 3 + 1], pos[j * 3 + 2] - pos[p * 3 + 2]);
        worst = Math.max(worst, Math.abs(len - Math.hypot(...db.joints[j].offset)));
      }
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it('can be parsed without mirroring', () => {
    const b = readFileSync(MMDB_PATH);
    const plain = parseMotionDB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, false);
    expect(plain.frames).toBe(7020);
    expect(plain.takes.every((t) => !t.mirrored)).toBe(true);
  });
});
