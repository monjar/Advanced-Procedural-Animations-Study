export interface LoopHandlers {
  /** Simulation step. All simulation belongs here. */
  fixedUpdate?: (dt: number, time: number) => void;
  /** Called once per rendered frame. `alpha` is the fraction of a step left unsimulated (fixed mode only). */
  frame?: (alpha: number, frameDt: number) => void;
}

/**
 * - `synced`: every rendered frame advances the simulation by exactly the elapsed time, split into
 *   equal steps no longer than `dt`. What is drawn is always the state at the frame's time, so motion
 *   is smooth at any refresh rate. Steps vary slightly in length.
 * - `fixed`: classic accumulator; every step is exactly `dt`. Deterministic, but without render
 *   interpolation a frame shows the state of the last whole step, so motion judders whenever display
 *   and simulation rates differ (0 or 2 steps in some frames).
 */
export type StepMode = 'synced' | 'fixed';

export class FixedStepLoop {
  /** Step length (fixed mode) or maximum step length (synced mode). */
  dt: number;
  mode: StepMode = 'synced';
  time = 0;
  timeScale = 1;
  paused = false;
  /** Upper bound on steps per frame; prevents a spiral of death after a long stall. */
  maxSteps = 16;

  private accumulator = 0;
  private last = -1;
  private raf = 0;
  private readonly handlers: LoopHandlers;

  constructor(handlers: LoopHandlers, rate = 120) {
    this.handlers = handlers;
    this.dt = 1 / rate;
  }

  get rate(): number {
    return 1 / this.dt;
  }

  set rate(hz: number) {
    this.dt = 1 / hz;
  }

  start(): void {
    if (this.raf) return;
    this.last = -1;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Advance exactly one step of `dt` (used for single-stepping while paused). */
  step(dt = this.dt): void {
    this.handlers.fixedUpdate?.(dt, this.time);
    this.time += dt;
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const frameDt = this.last < 0 ? 0 : Math.min((now - this.last) / 1000, 0.25);
    this.last = now;

    let alpha = 0;
    if (!this.paused) {
      const budget = frameDt * this.timeScale;
      if (this.mode === 'synced') {
        if (budget > 0) {
          const n = Math.min(this.maxSteps, Math.max(1, Math.ceil(budget / this.dt - 1e-6)));
          const h = budget / n;
          for (let i = 0; i < n; i++) this.step(h);
        }
        this.accumulator = 0;
      } else {
        this.accumulator += budget;
        let steps = 0;
        while (this.accumulator >= this.dt && steps < this.maxSteps) {
          this.step();
          this.accumulator -= this.dt;
          steps++;
        }
        if (steps === this.maxSteps) this.accumulator = 0;
        alpha = this.accumulator / this.dt;
      }
    }

    this.handlers.frame?.(alpha, frameDt);
  };
}
