import { readFileSync } from 'node:fs';
import { parseMotionDB, type MotionDB } from '../../src/anim/mmdb';

export const MMDB_PATH = 'public/assets/mocap/cmu16-mm.bin';

let cached: MotionDB | undefined;

/** The shipped study 09 database, mirrored, parsed once per test file. */
export function loadMotionDB(): MotionDB {
  if (!cached) {
    const b = readFileSync(MMDB_PATH);
    cached = parseMotionDB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  }
  return cached;
}
