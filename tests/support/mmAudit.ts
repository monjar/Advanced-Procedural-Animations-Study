import { buildFeatures, type MotionFeatures } from '../../src/anim/mmfeatures';
import { MotionMatcher, type MatcherSettings } from '../../demos/09-motion-matching/matcher';
import type { ControlInput } from '../../demos/09-motion-matching/controller';
import { loadMotionDB } from './mmdb';

let mf: MotionFeatures | undefined;
export function features(): MotionFeatures {
  return (mf ??= buildFeatures(loadMotionDB()));
}

export interface Segment {
  /** Seconds this input is held. */
  duration: number;
  input: ControlInput;
}

export interface Sample {
  t: number;
  x: number;
  z: number;
  yaw: number;
  /** Root speed (m/s) over the last 0.1 s. */
  speed: number;
  simDistance: number;
  segment: number;
}

export interface Run {
  matcher: MotionMatcher;
  samples: Sample[];
  /** Per transition: the largest per-step joint rotation change (rad) across the switch. */
  transitionJumps: number[];
  /** Largest per-step joint rotation change (rad) at non-transition steps. */
  steadyJumps: number[];
}

/** Drive a matcher through scripted input at a given display rate. */
export function runScript(script: Segment[], fps = 60, settings: Partial<MatcherSettings> = {}): Run {
  const m = new MotionMatcher(features(), settings);
  const J = m.J;
  const samples: Sample[] = [];
  const transitionJumps: number[] = [];
  const steadyJumps: number[] = [];
  let prevRot = new Float32Array(m.pose.rot);
  m.onStep = (from) => {
    // Largest joint rotation change this step (skip the root: it turns with the character).
    let worst = 0;
    for (let j = 1; j < J; j++) {
      const k = j * 4;
      const dot = Math.abs(prevRot[k] * m.pose.rot[k] + prevRot[k + 1] * m.pose.rot[k + 1] + prevRot[k + 2] * m.pose.rot[k + 2] + prevRot[k + 3] * m.pose.rot[k + 3]);
      worst = Math.max(worst, 2 * Math.acos(Math.min(1, dot)));
    }
    (from >= 0 ? transitionJumps : steadyJumps).push(worst);
    prevRot = new Float32Array(m.pose.rot);
  };
  let t = 0;
  const window = Math.max(1, Math.round(fps / 10));
  script.forEach((seg, si) => {
    const n = Math.round(seg.duration * fps);
    for (let i = 0; i < n; i++) {
      m.update(seg.input, 1 / fps);
      t += 1 / fps;
      const back = samples[samples.length - window];
      samples.push({
        t,
        x: m.root.x,
        z: m.root.z,
        yaw: m.root.yaw,
        speed: back ? Math.hypot(m.root.x - back.x, m.root.z - back.z) / (t - back.t) : 0,
        simDistance: Math.hypot(m.controller.x.x - m.root.x, m.controller.z.x - m.root.z),
        segment: si,
      });
    }
  });
  return { matcher: m, samples, transitionJumps, steadyJumps };
}

export const IDLE: ControlInput = { x: 0, z: 0, run: false };
export const FORWARD: ControlInput = { x: 0, z: 1, run: false };
export const LEFT: ControlInput = { x: 1, z: 0, run: false }; // +X is the character's left when facing +Z
export const RUN: ControlInput = { x: 0, z: 1, run: true };
