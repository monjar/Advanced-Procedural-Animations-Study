import type { MotionDB } from '../../src/anim/mmdb';

const COLORS: [RegExp, string][] = [
  [/idle/, '#7d8592'],
  [/stop/, '#b48ead'],
  [/^run/, '#ff8a3d'],
  [/^(walk|slow)/, '#5fb3ff'],
];

function colorOf(description: string): string {
  return COLORS.find(([re]) => re.test(description))?.[1] ?? '#5fb3ff';
}

/**
 * The whole database as two strips (captured takes above, their mirrors below), one block per take coloured
 * by kind (walk, run, stop, idle), with the playing frame marked.
 */
export function drawTimeline(canvas: HTMLCanvasElement, db: MotionDB, frame: number): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const half = db.frames / 2;
  const row = (h - 6 * dpr) / 2;
  const x = (f: number) => (f / half) * w;
  for (const t of db.takes) {
    const y = t.mirrored ? row + 6 * dpr : 0;
    const s = t.mirrored ? t.start - half : t.start;
    ctx.fillStyle = colorOf(t.description);
    ctx.globalAlpha = 0.75;
    ctx.fillRect(x(s) + dpr * 0.5, y, Math.max(1, x(t.frames) - dpr), row);
  }
  ctx.globalAlpha = 1;
  const mirrored = frame >= half;
  const fx = x(mirrored ? frame - half : frame);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(fx - dpr, mirrored ? row + 6 * dpr - 2 * dpr : 0, 2 * dpr, row + 2 * dpr);
}
