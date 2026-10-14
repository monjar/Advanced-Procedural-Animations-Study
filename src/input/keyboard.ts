/** Tracks held keys by `KeyboardEvent.code`, ignoring typing in form fields. */
export class Keyboard {
  private readonly held = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      this.held.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.held.delete(e.code));
    target.addEventListener('blur', () => this.held.clear());
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** -1, 0 or 1 from two key sets. */
  axis(negative: string[], positive: string[]): number {
    const n = negative.some((c) => this.held.has(c)) ? 1 : 0;
    const p = positive.some((c) => this.held.has(c)) ? 1 : 0;
    return p - n;
  }

  /** True while any movement key (WASD / arrows) is held. */
  get moving(): boolean {
    return ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].some((c) => this.held.has(c));
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
