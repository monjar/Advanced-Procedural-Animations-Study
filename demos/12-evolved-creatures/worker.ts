/// <reference lib="webworker" />
import RAPIER from '@dimforge/rapier3d-compat';
import type { Genome } from './genome.ts';
import { evaluate, record } from './phenotype.ts';

/**
 * Physics worker: evaluates batches of genomes and records runs for playback. Rapier lives only here, so the
 * page itself never loads the 4 MB physics bundle.
 */
const ready = RAPIER.init();

export type WorkerRequest =
  | { type: 'evaluate'; id: number; genomes: Genome[]; duration: number }
  | { type: 'record'; id: number; genome: Genome; duration: number };

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  await ready;
  const msg = e.data;
  if (msg.type === 'evaluate') {
    const results = msg.genomes.map((g) => evaluate(g, msg.duration));
    (self as unknown as Worker).postMessage({ type: 'evaluated', id: msg.id, results });
  } else {
    const r = record(msg.genome, msg.duration);
    (self as unknown as Worker).postMessage({ type: 'recorded', id: msg.id, ...r }, [r.frames.buffer, r.sizes.buffer]);
  }
};
