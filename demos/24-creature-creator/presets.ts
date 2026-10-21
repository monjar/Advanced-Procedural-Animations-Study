import type { CreatureSpec } from './creature';

const pairs = (n: number, from: number, to: number, length: number, segments: 2 | 3, spread: number) =>
  Array.from({ length: n }, (_, i) => ({ at: n === 1 ? from : from + ((to - from) * i) / (n - 1), length, segments, spread }));

export const PRESETS: CreatureSpec[] = [
  { name: 'quadruped', spineLength: 0.8, spineSegments: 6, radius: [0.1, 0.13, 0.11], legs: [{ at: 0.1, length: 0.55, segments: 3, spread: 0 }, { at: 0.88, length: 0.5, segments: 2, spread: 0 }], headSize: 0.13, neck: 0.18, tailLength: 0.45, color: 0xd98c4a },
  { name: 'biped', spineLength: 0.42, spineSegments: 3, radius: [0.12, 0.15, 0.12], legs: pairs(1, 0.12, 0.12, 0.75, 3, 0.05), headSize: 0.13, neck: 0.12, tailLength: 0.55, color: 0x6fbf73, upright: true },
  { name: 'insect (six legs)', spineLength: 0.55, spineSegments: 5, radius: [0.12, 0.08, 0.08], legs: pairs(3, 0.3, 0.75, 0.38, 2, 0.45), headSize: 0.08, neck: 0.03, tailLength: 0, color: 0x4a6fd9 },
  { name: 'spider (eight legs)', spineLength: 0.45, spineSegments: 4, radius: [0.17, 0.1, 0.09], legs: pairs(4, 0.55, 0.85, 0.62, 3, 0.55), headSize: 0.06, neck: 0.02, tailLength: 0, color: 0x3d3d48 },
  { name: 'centipede', spineLength: 1.7, spineSegments: 18, radius: [0.05, 0.065, 0.06], legs: pairs(10, 0.05, 0.92, 0.2, 2, 0.35), headSize: 0.07, neck: 0.03, tailLength: 0.08, color: 0xc0472f },
  { name: 'long-legged', spineLength: 0.9, spineSegments: 6, radius: [0.12, 0.15, 0.13], legs: [{ at: 0.12, length: 1.25, segments: 3, spread: 0 }, { at: 0.86, length: 1.2, segments: 2, spread: 0 }], headSize: 0.12, neck: 0.75, tailLength: 0.4, color: 0xe2b53e },
];
