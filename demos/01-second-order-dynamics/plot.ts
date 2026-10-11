export interface Curve {
  values: ArrayLike<number>;
  dt: number;
  color: string;
  dashed?: boolean;
}

/** Minimal canvas line plot for step responses: x = time, y clamped to [yMin, yMax]. */
export class ResponsePlot {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cssHeight: number;

  constructor(
    parent: HTMLElement,
    height = 140,
    private readonly yMin = -0.5,
    private readonly yMax = 2,
  ) {
    this.cssHeight = height;
    this.canvas.style.height = `${height}px`;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  draw(curves: Curve[], duration: number): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, this.canvas.clientWidth);
    const h = this.cssHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 22, r: 4, t: 4, b: 16 };
    const px = (t: number) => pad.l + (t / duration) * (w - pad.l - pad.r);
    const py = (v: number) => {
      const c = Math.min(this.yMax, Math.max(this.yMin, v));
      return pad.t + (1 - (c - this.yMin) / (this.yMax - this.yMin)) * (h - pad.t - pad.b);
    };

    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#7d8590';
    ctx.lineWidth = 1;
    for (const v of [0, 1]) {
      ctx.strokeStyle = v === 1 ? '#555b66' : '#3a3f48';
      ctx.beginPath();
      ctx.moveTo(pad.l, py(v));
      ctx.lineTo(w - pad.r, py(v));
      ctx.stroke();
      ctx.fillText(String(v), 6, py(v) + 3);
    }
    for (let t = 0; t <= duration + 1e-9; t += 0.5) {
      ctx.fillText(t % 1 === 0 ? `${t}s` : '', px(t) - 4, h - 3);
    }

    for (const c of curves) {
      ctx.strokeStyle = c.color;
      ctx.lineWidth = c.dashed ? 1 : 1.75;
      ctx.setLineDash(c.dashed ? [3, 3] : []);
      ctx.beginPath();
      const n = c.values.length;
      for (let i = 0; i < n; i++) {
        const t = i * c.dt;
        if (t > duration) break;
        const v = Number.isFinite(c.values[i]) ? c.values[i] : this.yMax;
        if (i === 0) ctx.moveTo(px(t), py(v));
        else ctx.lineTo(px(t), py(v));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
