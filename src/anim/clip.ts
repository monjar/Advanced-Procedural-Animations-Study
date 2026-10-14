import * as THREE from 'three';

/** Loopable clip produced by tools/bvh-to-clip.mjs. */
export interface ClipData {
  source: string;
  attribution: string;
  fps: number;
  frames: number;
  joints: { name: string; parent: number; offset: [number, number, number] }[];
  /** Root displacement per loop (m). */
  cycle: [number, number, number];
  /** Root position per frame (frames × 3). */
  root: number[];
  /** Local joint rotations per frame (frames × joints × 4, xyzw). */
  rotations: number[];
  contacts: { left: number[]; right: number[] };
}

/**
 * Plays a looping clip on a bone hierarchy with root motion: each completed loop adds the cycle
 * displacement, so the character keeps walking forward.
 */
export class ClipPlayer {
  readonly root = new THREE.Object3D();
  readonly bones: THREE.Object3D[];
  readonly index: Record<string, number>;
  /** Clip time (s), unbounded; loops are counted from it. */
  time = 0;
  /** World offset added to the root (e.g. pelvis height adjustment). */
  readonly rootOffset = new THREE.Vector3();
  readonly origin = new THREE.Vector3();
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();

  constructor(readonly data: ClipData) {
    this.bones = data.joints.map((j) => {
      const b = new THREE.Object3D();
      b.name = j.name;
      b.position.fromArray(j.offset);
      return b;
    });
    data.joints.forEach((j, i) => (j.parent >= 0 ? this.bones[j.parent] : this.root).add(this.bones[i]));
    this.index = Object.fromEntries(data.joints.map((j, i) => [j.name, i]));
  }

  get duration(): number {
    return this.data.frames / this.data.fps;
  }

  bone(name: string): THREE.Object3D {
    return this.bones[this.index[name]];
  }

  /** Fractional frame and loop count for a time. */
  locate(time: number): { loop: number; frame: number; next: number; t: number } {
    const f = time * this.data.fps;
    const loop = Math.floor(f / this.data.frames);
    const local = f - loop * this.data.frames;
    const frame = Math.floor(local);
    return { loop, frame, next: (frame + 1) % this.data.frames, t: local - frame };
  }

  /** Root position (world, before rootOffset) at an arbitrary time, including root motion. */
  rootAt(time: number, out = new THREE.Vector3()): THREE.Vector3 {
    const { loop, frame, next, t } = this.locate(time);
    const r = this.data.root;
    const c = this.data.cycle;
    const wrap = next === 0 ? 1 : 0;
    for (let k = 0; k < 3; k++) {
      const a = r[frame * 3 + k];
      const b = r[next * 3 + k] + c[k] * wrap;
      out.setComponent(k, a + (b - a) * t + c[k] * loop);
    }
    return out.add(this.origin);
  }

  /** Pose the hierarchy at the current time. */
  apply(): void {
    const { frame, next, t } = this.locate(this.time);
    const R = this.data.rotations;
    const J = this.data.joints.length;
    for (let j = 0; j < J; j++) {
      this.qa.fromArray(R, (frame * J + j) * 4);
      this.qb.fromArray(R, (next * J + j) * 4);
      this.bones[j].quaternion.slerpQuaternions(this.qa, this.qb, t);
    }
    this.rootAt(this.time, this.bones[0].position).add(this.rootOffset);
    this.root.updateMatrixWorld(true);
  }

  /** Contact weight (0..1, interpolated) for a foot at a time. */
  contact(side: 'left' | 'right', time = this.time): number {
    const { frame, next, t } = this.locate(time);
    const c = this.data.contacts[side];
    return c[frame] + (c[next] - c[frame]) * t;
  }
}
