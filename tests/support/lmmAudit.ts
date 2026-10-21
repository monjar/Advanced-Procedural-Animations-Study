import { readFileSync } from 'node:fs';
import { LearnedMatcher, type LearnedSettings, type LmmModel } from '../../demos/16-learned-motion-matching/learned';
import { Networks, type NetworksFile } from '../../demos/16-learned-motion-matching/networks';
import { MotionMatcher } from '../../demos/09-motion-matching/matcher';
import type { ControlInput } from '../../demos/09-motion-matching/controller';
import { features } from './mmAudit';

let nets: Networks | undefined;
let model: LmmModel | undefined;
export function lmm(): { nets: Networks; model: LmmModel } {
  nets ??= new Networks(JSON.parse(readFileSync('public/assets/lmm/networks.json', 'utf8')) as NetworksFile);
  model ??= JSON.parse(readFileSync('public/assets/lmm/model.json', 'utf8')) as LmmModel;
  return { nets, model };
}

/** The learned matcher's standing start: the projector applied to a standing frame's features. */
export function learnedMatcher(settings: Partial<LearnedSettings> = {}): LearnedMatcher {
  const { nets, model } = lmm();
  const start = nets.project(Float32Array.from(model.startX), new Float32Array(nets.X + nets.Z));
  return new LearnedMatcher(nets, model, start, settings);
}

export interface Sample {
  t: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  segment: number;
}

export interface Comparison {
  samples: Sample[];
  /** Largest per-step joint rotation change (rad), at transitions and elsewhere. */
  transitionJumps: number[];
  steadyJumps: number[];
  /** Mean horizontal ankle speed (m/s) while the pose says that foot is planted. */
  skate: number;
  transitions: number;
  time: number;
  /** Mean milliseconds per 60 Hz step. */
  msPerStep: number;
}

type Matcher = LearnedMatcher | MotionMatcher;

/**
 * Drive either runtime through scripted input at 60 fps and measure it the same way: root speed and heading,
 * joint rotation jumps per step, and foot skating against the runtime's own contact labels.
 */
export function runBoth(kind: 'database' | 'learned', script: { duration: number; input: ControlInput }[], settings: Partial<LearnedSettings> = {}): Comparison {
  const m: Matcher = kind === 'learned' ? learnedMatcher(settings) : new MotionMatcher(features());
  const J = m.J;
  const ankles = [m.skel.parents.length ? lankle(kind) : 0, rankle(kind)];
  const transitionJumps: number[] = [];
  const steadyJumps: number[] = [];
  let prevRot = new Float32Array(m.pose.rot);
  let prevAnkle = [0, 0, 0, 0, 0, 0];
  let skateDist = 0;
  let contactTime = 0;
  let stepMs = 0;
  const onStep = (transitioned: boolean) => {
    let worst = 0;
    for (let j = 1; j < J; j++) {
      const k = j * 4;
      const dot = Math.abs(prevRot[k] * m.pose.rot[k] + prevRot[k + 1] * m.pose.rot[k + 1] + prevRot[k + 2] * m.pose.rot[k + 2] + prevRot[k + 3] * m.pose.rot[k + 3]);
      worst = Math.max(worst, 2 * Math.acos(Math.min(1, dot)));
    }
    (transitioned ? transitionJumps : steadyJumps).push(worst);
    prevRot = new Float32Array(m.pose.rot);
    const contacts = m instanceof LearnedMatcher ? [m.contacts[0] > 0.5, m.contacts[1] > 0.5] : [m.mf.db.contacts[m.frame * 2] > 0, m.mf.db.contacts[m.frame * 2 + 1] > 0];
    const w = m.currWorld;
    ankles.forEach((a, k) => {
      const x = w[a * 3];
      const z = w[a * 3 + 2];
      if (contacts[k] && m.steps > 1) {
        skateDist += Math.hypot(x - prevAnkle[k * 3], z - prevAnkle[k * 3 + 2]);
        contactTime += 1 / 60;
      }
      prevAnkle[k * 3] = x;
      prevAnkle[k * 3 + 2] = z;
    });
  };
  if (m instanceof LearnedMatcher) m.onStep = (t) => onStep(t);
  else m.onStep = (from) => onStep(from >= 0);
  const samples: Sample[] = [];
  let t = 0;
  script.forEach((seg, si) => {
    for (let i = 0; i < Math.round(seg.duration * 60); i++) {
      const t0 = performance.now();
      m.update(seg.input, 1 / 60);
      stepMs += performance.now() - t0;
      t += 1 / 60;
      const back = samples[samples.length - 6];
      samples.push({ t, x: m.root.x, z: m.root.z, yaw: m.root.yaw, speed: back ? Math.hypot(m.root.x - back.x, m.root.z - back.z) / (t - back.t) : 0, segment: si });
    }
  });
  void prevAnkle;
  return { samples, transitionJumps, steadyJumps, skate: skateDist / Math.max(1e-9, contactTime), transitions: m.transitions, time: t, msPerStep: stepMs / samples.length };
}

function lankle(_kind: string): number {
  return lmm().model.leftFoot;
}
function rankle(_kind: string): number {
  return lmm().model.rightFoot;
}
