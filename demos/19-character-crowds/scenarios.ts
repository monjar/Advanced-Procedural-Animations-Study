import { Rng } from '../../src/math/random';
import { Crowd, type CrowdParams } from './crowd';

/**
 * The test scenes. Each fills a crowd with agents (radius 0.25 m, preferred speeds around 1.3 m/s) and walls.
 * Plane (x, y) is the scene's (x, z).
 */

export interface Scenario {
  name: string;
  /** Agents at density 1 (the page's slider scales it). */
  count: number;
  /** Seconds after which a run counts as stuck. */
  timeout: number;
  /** People leave the scene when they reach their goal (exits), rather than standing there. */
  vanish?: boolean;
  build(crowd: Crowd, n: number, rng: Rng): void;
}

const speed = (rng: Rng) => Math.min(1.7, Math.max(0.9, 1.3 + 0.15 * rng.normal()));

export const SCENARIOS: Scenario[] = [
  {
    name: 'circle swap',
    count: 48,
    timeout: 40,
    build(crowd, n, rng) {
      // Everyone walks to the antipode of a 10 m circle: all paths cross at the centre at once.
      const R = Math.max(6, (n * 0.6) / Math.PI);
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        const p = { x: R * Math.cos(a), y: R * Math.sin(a) };
        crowd.addAgent(p, [{ p: { x: -p.x, y: -p.y } }], 0.25, speed(rng));
      }
    },
  },
  {
    name: 'crossing',
    count: 60,
    timeout: 50,
    build(crowd, n, rng) {
      // Two groups cross at right angles in an open square.
      const half = Math.floor(n / 2);
      const cols = Math.ceil(Math.sqrt(half));
      for (let i = 0; i < n; i++) {
        const k = i < half ? i : i - half;
        const u = -14 - Math.floor(k / cols) * 0.9 + rng.range(-0.15, 0.15);
        const v = (k % cols - (cols - 1) / 2) * 0.9 + rng.range(-0.15, 0.15);
        if (i < half) crowd.addAgent({ x: u, y: v }, [{ p: { x: 14 + (u + 14), y: v } }], 0.25, speed(rng));
        else crowd.addAgent({ x: v, y: u }, [{ p: { x: v, y: 14 + (u + 14) } }], 0.25, speed(rng));
      }
    },
  },
  {
    name: 'doorway',
    count: 60,
    timeout: 90,
    vanish: true,
    build(crowd, n, rng) {
      // A room on the left, one 1.2 m door in the wall at x = 0, the goal area beyond.
      crowd.addBox(-0.15, 0.6, 0.15, 8);
      crowd.addBox(-0.15, -8, 0.15, -0.6);
      const starts: { x: number; y: number }[] = [];
      for (let i = 0; i < n; i++) {
        let p = { x: 0, y: 0 };
        // Rejection-sample a non-overlapping start in the room.
        for (let tries = 0; tries < 200; tries++) {
          p = { x: rng.range(-11, -1.5), y: rng.range(-6.5, 6.5) };
          if (starts.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 0.6)) break;
        }
        starts.push(p);
      }
      // Through the door, then out of the scene somewhere along x = 7.
      for (let i = 0; i < n; i++) crowd.addAgent(starts[i], [{ p: { x: 0.3, y: 0 }, n: { x: 1, y: 0 } }, { p: { x: 7, y: rng.range(-5, 5) } }], 0.25, speed(rng));
    },
  },
  {
    name: 'corridor',
    count: 60,
    timeout: 90,
    vanish: true,
    build(crowd, n, rng) {
      // Two streams meet head-on in a 4 m corridor; lanes form (or don't).
      crowd.addBox(-16, 2, 16, 2.3);
      crowd.addBox(-16, -2.3, 16, -2);
      const half = Math.floor(n / 2);
      for (let i = 0; i < n; i++) {
        const k = i < half ? i : i - half;
        const along = 13 + Math.floor(k / 4) * 0.9 + rng.range(-0.1, 0.1);
        const across = ((k % 4) - 1.5) * 0.85 + rng.range(-0.1, 0.1);
        const dir = i < half ? 1 : -1;
        // Out of the far end, then out of the scene.
        crowd.addAgent({ x: -dir * along, y: across }, [{ p: { x: dir * 15.5, y: 0 }, n: { x: dir, y: 0 } }, { p: { x: dir * 18, y: across } }], 0.25, speed(rng));
      }
    },
  },
];

/** Build a scenario; `hurry` scales every preferred speed (and the speed limit with it). */
export function buildScenario(s: Scenario, params: Partial<CrowdParams>, density = 1, seed = 7, hurry = 1): Crowd {
  const crowd = new Crowd(params, seed);
  crowd.vanishOnArrival = s.vanish ?? false;
  s.build(crowd, Math.max(2, Math.round(s.count * density)), new Rng(seed));
  for (const a of crowd.agents) a.prefSpeed *= hurry;
  crowd.params.maxSpeed *= Math.max(1, hurry);
  return crowd;
}

/** Run a scenario headless until everyone arrives or it times out. */
export function runScenario(s: Scenario, params: Partial<CrowdParams>, density = 1, seed = 7, dt = 1 / 60, hurry = 1): Crowd {
  const crowd = buildScenario(s, params, density, seed, hurry);
  while (crowd.metrics.arrived < crowd.agents.length && crowd.metrics.time < s.timeout) crowd.step(dt);
  return crowd;
}
