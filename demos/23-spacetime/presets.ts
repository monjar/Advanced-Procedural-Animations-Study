import type { JumpSpec } from './spacetime';

export interface Preset {
  name: string;
  spec: JumpSpec;
}

export const PRESETS: Preset[] = [
  { name: 'hop forward 30 cm', spec: { distance: 0.3, rise: 0, stance1: 0.6, flight: 0.32, stance2: 0.5, hurdle: 0, friction: 0.8 } },
  { name: 'up onto a 10 cm step', spec: { distance: 0.25, rise: 0.1, stance1: 0.6, flight: 0.3, stance2: 0.5, hurdle: 0, friction: 0.8 } },
  { name: 'long jump 45 cm', spec: { distance: 0.45, rise: 0, stance1: 0.6, flight: 0.36, stance2: 0.5, hurdle: 0, friction: 0.8 } },
];
