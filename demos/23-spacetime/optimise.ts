import { CMAES } from './cmaes';
import { Jump, type JumpSpec } from './spacetime';

/**
 * The full search for one jump: CMA-ES from the animator's guess to find the basin, then Levenberg–Marquardt to
 * polish. `report` is called every generation/iteration with the current best (for live display).
 */
export function optimiseJump(spec: JumpSpec, opts: { generations?: number; polish?: number; seed?: number; report?: (j: Jump, stage: string, step: number) => boolean | void } = {}): Jump {
  const jump = new Jump(spec);
  const es = new CMAES(jump.p, 0.25, opts.seed ?? 3, 24);
  const gens = opts.generations ?? 700;
  for (let g = 0; g < gens; g++) {
    es.step((x) => jump.objective(x));
    if (opts.report && g % 10 === 9) {
      jump.set(es.best.x);
      if (opts.report(jump, 'search', g + 1) === false) return jump;
    }
  }
  jump.set(es.best.x);
  for (let i = 0; i < (opts.polish ?? 40); i++) {
    jump.iterate();
    if (opts.report?.(jump, 'polish', i + 1) === false) return jump;
  }
  return jump;
}
