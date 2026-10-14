import type { Genome } from './genome.ts';
import type { Evaluation } from './phenotype.ts';
import type { WorkerRequest } from './worker.ts';

export interface Recording {
  sizes: Float32Array;
  frames: Float32Array;
  bodies: number;
  evaluation: Evaluation;
}

type Pending = { resolve: (v: unknown) => void };

/** A pool of physics workers: batches of genomes are split across them and evaluated in parallel. */
export class WorkerPool {
  readonly workers: Worker[];
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        p.resolve(e.data);
      };
      return w;
    });
  }

  private send<T>(worker: Worker, msg: Omit<WorkerRequest, 'id'>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void });
      worker.postMessage({ ...msg, id });
    });
  }

  /** Evaluate genomes in parallel; results in input order. */
  async evaluate(genomes: Genome[], duration: number): Promise<Evaluation[]> {
    const n = this.workers.length;
    const chunks = this.workers.map((_, w) => genomes.filter((_, i) => i % n === w));
    const results = await Promise.all(
      this.workers.map((w, k) => this.send<{ results: Evaluation[] }>(w, { type: 'evaluate', genomes: chunks[k], duration } as Omit<WorkerRequest, 'id'>)),
    );
    return genomes.map((_, i) => results[i % n].results[Math.floor(i / n)]);
  }

  record(genome: Genome, duration: number): Promise<Recording> {
    return this.send<Recording>(this.workers[0], { type: 'record', genome, duration } as Omit<WorkerRequest, 'id'>);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}
