export interface LoopHandlers {
  /** Called at a fixed rate. All simulation belongs here. */
  fixedUpdate?: (dt: number, time: number) => void;
  /** Called once per rendered frame. `alpha` is the fraction of a fixed step left in the accumulator. */
  frame?: (alpha: number, frameDt: number) => void;
}

/**
 * Fixed-timestep loop (accumulator pattern). Simulation runs at `rate` Hz regardless
 * of display refresh, so results do not depend on the viewer's monitor.
 */
export class FixedStepLoop {
  dt: number;
  time = 0;
  timeScale = 1;
  paused = false;
  /** Upper bound on fixed steps per frame; prevents a spiral of death after a long stall. */
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

  /** Advance exactly one fixed step (used for single-stepping while paused). */
  step(): void {
    this.handlers.fixedUpdate?.(this.dt, this.time);
    this.time += this.dt;
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const frameDt = this.last < 0 ? 0 : Math.min((now - this.last) / 1000, 0.25);
    this.last = now;

    if (!this.paused) {
      this.accumulator += frameDt * this.timeScale;
      let steps = 0;
      while (this.accumulator >= this.dt && steps < this.maxSteps) {
        this.step();
        this.accumulator -= this.dt;
        steps++;
      }
      if (steps === this.maxSteps) this.accumulator = 0;
    }

    this.handlers.frame?.(this.accumulator / this.dt, frameDt);
  };
}
