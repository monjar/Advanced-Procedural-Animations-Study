import { RUN, WALK } from './poses';

/** Stride-wheel diagram: phase pointer, stance arcs per foot and key-pose markers. */
export class StrideWheel {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;

  constructor(parent: HTMLElement, private readonly size = 150) {
    this.canvas.style.height = `${size}px`;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  draw(phase: number, duty: number, wRun: number, swinging: [boolean, boolean]): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, this.canvas.clientWidth);
    const h = this.size;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = h / 2 + 6;
    const cy = h / 2;
    const r = h / 2 - 14;
    // Phase 0 at the top, clockwise.
    const ang = (p: number) => -Math.PI / 2 + p * Math.PI * 2;

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2e333d';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    const arcs: [number, string, number][] = [
      [0, '#5fb3ff', r + 6], // right foot stance
      [0.5, '#ff8a3d', r - 6], // left foot stance
    ];
    ctx.lineWidth = 5;
    for (const [start, color, rr] of arcs) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, ang(start), ang(start + duty));
      ctx.stroke();
    }

    // Key-pose markers (walk and run, faded by gait weight), mirrored halves.
    ctx.font = '9px ui-monospace, monospace';
    const marks: [typeof WALK, string[], number][] = [
      [WALK, ['C', 'P'], 1 - wRun],
      [RUN, ['C', 'M', 'F'], wRun],
    ];
    for (const [keys, labels, alpha] of marks) {
      if (alpha < 0.05) continue;
      ctx.globalAlpha = alpha;
      keys.forEach(([p], i) => {
        for (const q of [p, p + 0.5]) {
          const a = ang(q);
          ctx.fillStyle = '#e6e8ec';
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#9aa1ad';
          ctx.fillText(labels[i], cx + Math.cos(a) * (r - 16) - 3, cy + Math.sin(a) * (r - 16) + 3);
        }
      });
      ctx.globalAlpha = 1;
    }

    // Pointer.
    const a = ang(phase - Math.floor(phase));
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * (r + 10), cy + Math.sin(a) * (r + 10));
    ctx.stroke();

    // Legend.
    const lx = cx + r + 22;
    ctx.font = '10px ui-monospace, monospace';
    const legend: [string, string][] = [
      ['#5fb3ff', `R ${swinging[0] ? 'swing' : 'stance'}`],
      ['#ff8a3d', `L ${swinging[1] ? 'swing' : 'stance'}`],
      ['#ffd166', 'phase'],
    ];
    legend.forEach(([c, t], i) => {
      ctx.fillStyle = c;
      ctx.fillRect(lx, 16 + i * 16, 8, 8);
      ctx.fillStyle = '#9aa1ad';
      ctx.fillText(t, lx + 12, 24 + i * 16);
    });
    ctx.fillText('C contact', lx, 80);
    ctx.fillText('P passing', lx, 94);
    ctx.fillText('M mid-stance', lx, 108);
    ctx.fillText('F flight', lx, 122);
  }
}
