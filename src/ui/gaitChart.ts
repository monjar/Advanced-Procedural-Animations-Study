/**
 * Scrolling footfall diagram (Hildebrand style): one row per limb, filled while the foot is in stance.
 * Call `push` once per simulation step and `draw` once per frame.
 */
export class GaitChart {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly history: Uint8Array[];
  private head = 0;

  constructor(
    parent: HTMLElement,
    private readonly labels: string[],
    private readonly length = 240,
    private readonly colors: string[] = labels.map(() => '#ff8a3d'),
  ) {
    this.history = labels.map(() => new Uint8Array(length));
    const h = labels.length * 12 + 4;
    this.canvas.style.height = `${h}px`;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  push(stance: boolean[]): void {
    for (let i = 0; i < this.history.length; i++) this.history[i][this.head] = stance[i] ? 1 : 0;
    this.head = (this.head + 1) % this.length;
  }

  draw(): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, this.canvas.clientWidth);
    const rows = this.labels.length;
    const h = rows * 12 + 4;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ui-monospace, monospace';
    const left = 26;
    const cw = (w - left) / this.length;
    for (let r = 0; r < rows; r++) {
      const y = 2 + r * 12;
      ctx.fillStyle = '#7d8590';
      ctx.fillText(this.labels[r], 0, y + 9);
      ctx.fillStyle = '#2e333d';
      ctx.fillRect(left, y + 1, w - left, 9);
      ctx.fillStyle = this.colors[r];
      const row = this.history[r];
      for (let k = 0; k < this.length; k++) {
        // Oldest on the left.
        if (row[(this.head + k) % this.length]) ctx.fillRect(left + k * cw, y + 1, Math.ceil(cw), 9);
      }
    }
  }
}
