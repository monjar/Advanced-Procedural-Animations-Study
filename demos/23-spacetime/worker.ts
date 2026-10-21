/// <reference lib="webworker" />
import { optimiseJump } from './optimise';
import type { JumpSpec } from './spacetime';

/** Runs a jump optimisation off the main thread, posting the current best every few generations. */
self.onmessage = (e: MessageEvent<{ spec: JumpSpec; seed: number }>) => {
  const { spec, seed } = e.data;
  const j = optimiseJump(spec, {
    seed,
    report: (jump, stage, step) => {
      (self as DedicatedWorkerGlobalScope).postMessage({ done: false, stage, step, p: Array.from(jump.p), cost: jump.cost, terms: jump.terms });
    },
  });
  (self as DedicatedWorkerGlobalScope).postMessage({ done: true, stage: 'done', step: 0, p: Array.from(j.p), cost: j.cost, terms: j.terms });
};
