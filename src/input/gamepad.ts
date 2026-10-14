/** Left stick (with a radial dead zone) and a run button from the first connected gamepad. */
export interface StickState {
  /** Stick x (right +) and y (up +), magnitude ≤ 1. */
  x: number;
  y: number;
  /** Right trigger or the bottom face button. */
  run: boolean;
  connected: boolean;
}

export function readGamepad(deadZone = 0.18): StickState {
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = Array.from(pads).find((p) => p && p.connected);
  if (!pad) return { x: 0, y: 0, run: false, connected: false };
  let x = pad.axes[0] ?? 0;
  let y = -(pad.axes[1] ?? 0);
  const m = Math.hypot(x, y);
  if (m < deadZone) x = y = 0;
  else {
    const k = Math.min(1, (m - deadZone) / (1 - deadZone)) / m;
    x *= k;
    y *= k;
  }
  const run = (pad.buttons[7]?.value ?? 0) > 0.3 || !!pad.buttons[0]?.pressed;
  return { x, y, run, connected: true };
}
