export interface Series {
  values: ArrayLike<number>;
  /** x spacing between samples. */
  dx: number;
  color: string;
  dashed?: boolean;
}

export interface PlotOptions {
  height?: number;
  yMin: number;
  yMax: number;
  /** Plot log10(y) instead of y; yMin/yMax are then in data units (must be > 0). */
  logY?: boolean;
  yTicks?: number[];
  xTickStep?: number;
  formatX?: (x: number) => string;
  formatY?: (y: number) => string;
}

/** Minimal canvas line plot for side panels. */
export class LinePlot {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    parent: HTMLElement,
    private options: PlotOptions,
  ) {
    this.canvas.style.height = `${options.height ?? 140}px`;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  setRange(yMin: number, yMax: number): void {
    this.options = { ...this.options, yMin, yMax };
  }

  draw(series: Series[], xMax: number): void {
    const o = this.options;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, this.canvas.clientWidth);
    const h = o.height ?? 140;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const tf = (v: number) => (o.logY ? Math.log10(Math.max(v, 1e-12)) : v);
    const lo = tf(o.yMin);
    const hi = tf(o.yMax);
    const pad = { l: 30, r: 4, t: 4, b: 16 };
    const px = (x: number) => pad.l + (x / xMax) * (w - pad.l - pad.r);
    const py = (v: number) => {
      const c = Math.min(hi, Math.max(lo, tf(v)));
      return pad.t + (1 - (c - lo) / (hi - lo)) * (h - pad.t - pad.b);
    };

    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#7d8590';
    ctx.lineWidth = 1;
    const fy = o.formatY ?? ((y: number) => String(y));
    for (const v of o.yTicks ?? [o.yMin, o.yMax]) {
      ctx.strokeStyle = '#3a3f48';
      ctx.beginPath();
      ctx.moveTo(pad.l, py(v));
      ctx.lineTo(w - pad.r, py(v));
      ctx.stroke();
      ctx.fillText(fy(v), 2, py(v) + 3);
    }
    const step = o.xTickStep ?? xMax / 4;
    const fx = o.formatX ?? ((x: number) => String(x));
    for (let x = 0; x <= xMax + 1e-9; x += step) ctx.fillText(fx(x), px(x) - 4, h - 3);

    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.dashed ? 1 : 1.75;
      ctx.setLineDash(s.dashed ? [3, 3] : []);
      ctx.beginPath();
      for (let i = 0; i < s.values.length; i++) {
        const x = i * s.dx;
        if (x > xMax) break;
        const v = Number.isFinite(s.values[i]) ? s.values[i] : o.yMax;
        if (i === 0) ctx.moveTo(px(x), py(v));
        else ctx.lineTo(px(x), py(v));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
