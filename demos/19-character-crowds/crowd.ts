import { Rng } from '../../src/math/random';
import { distSqPointSegment, makeObstacle, nearbyObstacles, orcaLines, orcaVelocity, type Line, type ObstacleVertex, type Vec2 } from './orca';

/**
 * A crowd on a plane: each agent walks a route of waypoints at its own preferred speed, and one of two models
 * turns preferred velocities into actual ones —
 *
 *   ORCA (orca.ts): a velocity-space method; picks a collision-free velocity for the next `timeHorizon` seconds.
 *   Social forces (Helbing & Molnár 1995; Helbing, Farkas & Vicsek 2000): a force-space method; agents are
 *   particles pushed by exponential repulsion from each other and the walls, plus body compression and sliding
 *   friction once they touch. Collisions are not prevented, only penalised — physically, people do touch.
 *
 * Plane coordinates (x, y) are the scene's (x, z).
 */

export type Model = 'orca' | 'social';

export interface Waypoint {
  p: Vec2;
  /** Passed once the agent is beyond the line through p with this normal (e.g. a doorway); else within 0.8 m. */
  n?: Vec2;
}

export interface Agent {
  id: number;
  position: Vec2;
  velocity: Vec2;
  radius: number;
  prefSpeed: number;
  route: Waypoint[];
  leg: number;
  arrived: boolean;
  /** Time the agent reached its last waypoint (s), or −1. */
  arrivedAt: number;
  /** Left the scene on arrival (see Crowd.vanishOnArrival): no longer simulated or seen by others. */
  gone: boolean;
  /** Total distance walked (m) and the straight-line length of its route. */
  walked: number;
  direct: number;
  /** The preferred velocity of the last step (for display). */
  preferred: Vec2;
}

export interface CrowdParams {
  model: Model;
  timeHorizon: number;
  timeHorizonObst: number;
  maxSpeed: number;
  neighborDist: number;
  maxNeighbors: number;
}

export const DEFAULT_PARAMS: CrowdParams = { model: 'orca', timeHorizon: 2, timeHorizonObst: 1, maxSpeed: 1.9, neighborDist: 5, maxNeighbors: 10 };

/** Social-force constants (Helbing, Farkas & Vicsek 2000, per kg of an 80 kg pedestrian). */
const SF = { tau: 0.5, A: 2000 / 80, B: 0.08, k: 1.2e5 / 80, kappa: 2.4e5 / 80, substeps: 10 };

export interface Wall {
  a: Vec2;
  b: Vec2;
}

export interface Metrics {
  time: number;
  /** Pair-overlap time: Σ over steps of (agent pairs closer than their radii sum − 1 cm) × dt. */
  overlapSeconds: number;
  /** Deepest agent–agent and agent–wall penetration seen (m). */
  maxPenetration: number;
  maxWallPenetration: number;
  arrived: number;
  /** Σ |Δ heading| / Σ distance walked (rad/m): how much the agents wiggle. */
  turning: number;
}

export class Crowd {
  readonly agents: Agent[] = [];
  readonly vertices: ObstacleVertex[] = [];
  readonly walls: Wall[] = [];
  /** Box obstacles as [x0, y0, x1, y1], for rendering. */
  readonly boxes: [number, number, number, number][] = [];
  params: CrowdParams;
  /** Remove agents when they arrive (an exit), instead of letting them stand at their goals. */
  vanishOnArrival = false;
  readonly metrics: Metrics = { time: 0, overlapSeconds: 0, maxPenetration: 0, maxWallPenetration: 0, arrived: 0, turning: 0 };
  private turned = 0;
  private walkedTotal = 0;
  private readonly rng: Rng;

  constructor(params: Partial<CrowdParams> = {}, seed = 1) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.rng = new Rng(seed);
  }

  addAgent(position: Vec2, route: Waypoint[], radius = 0.25, prefSpeed = 1.3): Agent {
    let direct = 0;
    let prev = position;
    for (const w of route) {
      direct += Math.hypot(w.p.x - prev.x, w.p.y - prev.y);
      prev = w.p;
    }
    const a: Agent = { id: this.agents.length, position: { ...position }, velocity: { x: 0, y: 0 }, radius, prefSpeed, route, leg: 0, arrived: false, arrivedAt: -1, gone: false, walked: 0, direct, preferred: { x: 0, y: 0 } };
    this.agents.push(a);
    return a;
  }

  /** A polygonal obstacle, vertices counter-clockwise in (x, y). */
  addObstacle(points: Vec2[]): void {
    this.vertices.push(...makeObstacle(points, this.vertices.length));
    for (let i = 0; i < points.length; i++) this.walls.push({ a: points[i], b: points[(i + 1) % points.length] });
  }

  /** Axis-aligned box obstacle. */
  addBox(x0: number, y0: number, x1: number, y1: number): void {
    this.boxes.push([x0, y0, x1, y1]);
    this.addObstacle([
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ]);
  }

  /** The preferred velocity: toward the current waypoint, slowing over the last metre before the final one. */
  private preferredVelocity(a: Agent): Vec2 {
    while (a.leg < a.route.length - 1) {
      const w = a.route[a.leg];
      const passed = w.n ? (a.position.x - w.p.x) * w.n.x + (a.position.y - w.p.y) * w.n.y > 0 : Math.hypot(a.position.x - w.p.x, a.position.y - w.p.y) < 0.8;
      if (!passed) break;
      a.leg++;
    }
    const goal = a.route[a.leg].p;
    const dx = goal.x - a.position.x;
    const dy = goal.y - a.position.y;
    const d = Math.hypot(dx, dy);
    const last = a.leg === a.route.length - 1;
    if (last && d < 0.15) return { x: 0, y: 0 };
    const speed = last ? a.prefSpeed * Math.min(1, d) : a.prefSpeed;
    return { x: (dx / d) * speed, y: (dy / d) * speed };
  }

  /** The nearest agents within neighborDist (brute force; a few hundred agents). */
  neighbours(a: Agent): Agent[] {
    const out: { b: Agent; d: number }[] = [];
    const r2 = this.params.neighborDist ** 2;
    for (const b of this.agents) {
      if (b === a || b.gone) continue;
      const d = (b.position.x - a.position.x) ** 2 + (b.position.y - a.position.y) ** 2;
      if (d >= r2) continue;
      if (out.length < this.params.maxNeighbors) out.push({ b, d });
      else if (d < out[out.length - 1].d) out[out.length - 1] = { b, d };
      else continue;
      out.sort((p, q) => p.d - q.d);
    }
    return out.map((o) => o.b);
  }

  /** ORCA half-planes for one agent with its current state (for display). */
  linesFor(a: Agent, dt: number): { lines: Line[]; numObstLines: number } {
    const range = this.params.timeHorizonObst * this.params.maxSpeed + a.radius;
    return orcaLines(a, this.neighbours(a), nearbyObstacles(this.vertices, a.position, range), this.params, dt);
  }

  step(dt: number): void {
    const prefs = this.agents.map((a) => {
      const p = this.preferredVelocity(a);
      // A tiny perturbation breaks the perfect symmetries (head-on pairs, circles) in which ORCA can deadlock.
      const ang = this.rng.next() * Math.PI * 2;
      const mag = this.rng.next() * 0.01;
      a.preferred = { x: p.x + Math.cos(ang) * mag, y: p.y + Math.sin(ang) * mag };
      return a.preferred;
    });
    const oldVel = this.agents.map((a) => ({ ...a.velocity }));
    if (this.params.model === 'orca') this.stepOrca(prefs, dt);
    else this.stepSocial(prefs, dt);
    this.measure(oldVel, dt);
  }

  /**
   * ORCA velocities for this step without moving anyone, for bodies that move themselves (study 27: animated
   * characters that cannot change velocity instantly). Pair with `adopt`.
   */
  plan(dt: number): Vec2[] {
    const prefs = this.agents.map((a) => {
      const p = this.preferredVelocity(a);
      const ang = this.rng.next() * Math.PI * 2;
      const mag = this.rng.next() * 0.01;
      a.preferred = { x: p.x + Math.cos(ang) * mag, y: p.y + Math.sin(ang) * mag };
      return a.preferred;
    });
    const range = this.params.timeHorizonObst * this.params.maxSpeed;
    return this.agents.map((a, i) => (a.gone ? { x: 0, y: 0 } : orcaVelocity(a, prefs[i], this.neighbours(a), nearbyObstacles(this.vertices, a.position, range + a.radius), this.params, dt)));
  }

  /** Take the bodies' actual positions after they moved, and measure (study 27). */
  adopt(positions: Vec2[], dt: number): void {
    const oldVel = this.agents.map((a) => ({ ...a.velocity }));
    this.agents.forEach((a, i) => {
      if (a.gone) return;
      a.velocity = { x: (positions[i].x - a.position.x) / dt, y: (positions[i].y - a.position.y) / dt };
      a.position = { ...positions[i] };
    });
    this.measure(oldVel, dt);
  }

  private stepOrca(prefs: Vec2[], dt: number): void {
    const range = this.params.timeHorizonObst * this.params.maxSpeed;
    // All new velocities from the same old state, then all agents move (the reciprocity assumes this).
    // Agents that have arrived keep running ORCA with a zero preferred velocity, so they step aside reciprocally.
    const next = this.agents.map((a, i) => (a.gone ? a.velocity : orcaVelocity(a, prefs[i], this.neighbours(a), nearbyObstacles(this.vertices, a.position, range + a.radius), this.params, dt)));
    this.agents.forEach((a, i) => {
      if (a.gone) return;
      a.velocity = next[i];
      a.position.x += a.velocity.x * dt;
      a.position.y += a.velocity.y * dt;
    });
  }

  private stepSocial(prefs: Vec2[], dt: number): void {
    const h = dt / SF.substeps;
    const n = this.agents.length;
    const fx = new Float64Array(n);
    const fy = new Float64Array(n);
    const near = this.agents.map((a) => this.neighbours(a));
    for (let s = 0; s < SF.substeps; s++) {
      for (let i = 0; i < n; i++) {
        const a = this.agents[i];
        if (a.gone) continue;
        // Driving force toward the preferred velocity.
        fx[i] = (prefs[i].x - a.velocity.x) / SF.tau;
        fy[i] = (prefs[i].y - a.velocity.y) / SF.tau;
        for (const b of near[i]) this.contactForce(a, b.position, b.radius, b.velocity, fx, fy, i);
        for (const w of this.walls) {
          const c = closestOnSegment(w.a, w.b, a.position);
          if ((c.x - a.position.x) ** 2 + (c.y - a.position.y) ** 2 < 4) this.contactForce(a, c, 0, { x: 0, y: 0 }, fx, fy, i);
        }
      }
      for (let i = 0; i < n; i++) {
        const a = this.agents[i];
        if (a.gone) continue;
        a.velocity.x += fx[i] * h;
        a.velocity.y += fy[i] * h;
        const sp = Math.hypot(a.velocity.x, a.velocity.y);
        if (sp > this.params.maxSpeed) {
          a.velocity.x *= this.params.maxSpeed / sp;
          a.velocity.y *= this.params.maxSpeed / sp;
        }
        a.position.x += a.velocity.x * h;
        a.position.y += a.velocity.y * h;
      }
    }
  }

  /** Helbing's interaction force on agent `a` from a body (or wall point, radius 0) at `p`. */
  private contactForce(a: Agent, p: Vec2, radius: number, vel: Vec2, fx: Float64Array, fy: Float64Array, i: number): void {
    const dx = a.position.x - p.x;
    const dy = a.position.y - p.y;
    const d = Math.hypot(dx, dy) || 1e-9;
    const nx = dx / d;
    const ny = dy / d;
    const overlap = a.radius + radius - d;
    let f = SF.A * Math.exp(overlap / SF.B);
    if (overlap > 0) {
      f += SF.k * overlap;
      // Sliding friction against the tangential relative velocity.
      const tx = -ny;
      const ty = nx;
      const dvt = (vel.x - a.velocity.x) * tx + (vel.y - a.velocity.y) * ty;
      fx[i] += SF.kappa * overlap * dvt * tx;
      fy[i] += SF.kappa * overlap * dvt * ty;
    }
    fx[i] += f * nx;
    fy[i] += f * ny;
  }

  private measure(oldVel: Vec2[], dt: number): void {
    const m = this.metrics;
    m.time += dt;
    let overlapping = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.gone) continue;
      for (let j = i + 1; j < this.agents.length; j++) {
        const b = this.agents[j];
        if (b.gone) continue;
        const pen = a.radius + b.radius - Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
        if (pen > 0.01) overlapping++;
        if (pen > m.maxPenetration) m.maxPenetration = pen;
      }
      for (const w of this.walls) {
        const pen = a.radius - Math.sqrt(distSqPointSegment(w.a, w.b, a.position));
        if (pen > m.maxWallPenetration) m.maxWallPenetration = pen;
      }
      const sp = Math.hypot(a.velocity.x, a.velocity.y);
      a.walked += sp * dt;
      this.walkedTotal += sp * dt;
      const ov = oldVel[i];
      if (sp > 0.2 && Math.hypot(ov.x, ov.y) > 0.2) {
        const da = Math.atan2(a.velocity.y, a.velocity.x) - Math.atan2(ov.y, ov.x);
        this.turned += Math.abs(Math.atan2(Math.sin(da), Math.cos(da)));
      }
      if (!a.arrived && a.leg === a.route.length - 1) {
        const g = a.route[a.leg].p;
        if (Math.hypot(g.x - a.position.x, g.y - a.position.y) < 0.5) {
          a.arrived = true;
          a.arrivedAt = m.time;
          m.arrived++;
          if (this.vanishOnArrival) {
            a.gone = true;
            a.velocity = { x: 0, y: 0 };
          }
        }
      }
    }
    m.overlapSeconds += overlapping * dt;
    m.turning = this.walkedTotal > 0 ? this.turned / this.walkedTotal : 0;
  }
}

function closestOnSegment(a: Vec2, b: Vec2, c: Vec2): Vec2 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const t = Math.min(1, Math.max(0, ((c.x - a.x) * abx + (c.y - a.y) * aby) / (abx * abx + aby * aby)));
  return { x: a.x + t * abx, y: a.y + t * aby };
}
