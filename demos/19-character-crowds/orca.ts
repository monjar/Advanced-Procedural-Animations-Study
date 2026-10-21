/**
 * Optimal Reciprocal Collision Avoidance (van den Berg, Guy, Lin & Manocha, "Reciprocal n-Body Collision
 * Avoidance", ISRR 2011), ported from the reference implementation RVO2 (Agent.cpp) — agents and polygonal
 * obstacles, with the same incremental 2-D linear programs.
 *
 * Each agent turns every neighbour into a half-plane of allowed velocities: the velocity obstacle (all relative
 * velocities that collide within the time horizon) is a truncated cone; u is the shortest change of relative
 * velocity that leaves it, and the agent takes half of that responsibility — the neighbour, running the same
 * rule, takes the other half. That is the "reciprocal": no oscillation from both agents dodging fully. The new
 * velocity is the one closest to the preferred velocity inside every half-plane and the max-speed disc; if the
 * half-planes have no common point (dense crowds), the one that violates them least.
 *
 * Plane coordinates: x and y here are the scene's x and z.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Line {
  point: Vec2;
  /** Unit direction; the allowed side is to its left. */
  direction: Vec2;
}

const EPS = 1e-5;

const det = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const absSq = (a: Vec2) => a.x * a.x + a.y * a.y;
const v2 = (x: number, y: number): Vec2 => ({ x, y });
const sub = (a: Vec2, b: Vec2) => v2(a.x - b.x, a.y - b.y);
const add = (a: Vec2, b: Vec2) => v2(a.x + b.x, a.y + b.y);
const scale = (a: Vec2, s: number) => v2(a.x * s, a.y * s);
const normalize = (a: Vec2) => {
  const l = Math.sqrt(absSq(a));
  return l > 0 ? v2(a.x / l, a.y / l) : v2(0, 0);
};
/** > 0 when c is left of the directed line a → b. */
const leftOf = (a: Vec2, b: Vec2, c: Vec2) => det(sub(a, c), sub(b, a));

/** Squared distance from c to segment a–b. */
function distSqPointSegment(a: Vec2, b: Vec2, c: Vec2): number {
  const ab = sub(b, a);
  const r = dot(sub(c, a), ab) / absSq(ab);
  if (r < 0) return absSq(sub(c, a));
  if (r > 1) return absSq(sub(c, b));
  return absSq(sub(c, add(a, scale(ab, r))));
}

// ------------------------------------------------------------------------------------------ linear programs

/** Optimise on line `lineNo` subject to lines [0, lineNo) and the disc. False if infeasible. */
function linearProgram1(lines: Line[], lineNo: number, radius: number, opt: Vec2, directionOpt: boolean, result: Vec2): boolean {
  const L = lines[lineNo];
  const dp = dot(L.point, L.direction);
  const discriminant = dp * dp + radius * radius - absSq(L.point);
  if (discriminant < 0) return false; // the disc misses the line entirely
  const sq = Math.sqrt(discriminant);
  let tLeft = -dp - sq;
  let tRight = -dp + sq;
  for (let i = 0; i < lineNo; i++) {
    const denominator = det(L.direction, lines[i].direction);
    const numerator = det(lines[i].direction, sub(L.point, lines[i].point));
    if (Math.abs(denominator) <= EPS) {
      if (numerator < 0) return false; // parallel and on the wrong side
      continue;
    }
    const t = numerator / denominator;
    if (denominator >= 0) tRight = Math.min(tRight, t);
    else tLeft = Math.max(tLeft, t);
    if (tLeft > tRight) return false;
  }
  let t: number;
  if (directionOpt) t = dot(opt, L.direction) > 0 ? tRight : tLeft;
  else t = Math.min(tRight, Math.max(tLeft, dot(L.direction, sub(opt, L.point))));
  result.x = L.point.x + t * L.direction.x;
  result.y = L.point.y + t * L.direction.y;
  return true;
}

/**
 * The velocity closest to `opt` (or furthest along it, with directionOpt) within the disc and every line.
 * Returns the number of lines processed: lines.length on success, else the index of the first failure.
 */
export function linearProgram2(lines: Line[], radius: number, opt: Vec2, directionOpt: boolean, result: Vec2): number {
  if (directionOpt) {
    result.x = opt.x * radius;
    result.y = opt.y * radius;
  } else if (absSq(opt) > radius * radius) {
    const n = normalize(opt);
    result.x = n.x * radius;
    result.y = n.y * radius;
  } else {
    result.x = opt.x;
    result.y = opt.y;
  }
  for (let i = 0; i < lines.length; i++) {
    if (det(lines[i].direction, sub(lines[i].point, result)) > 0) {
      // The current result violates line i: the new optimum lies on it.
      const keep = v2(result.x, result.y);
      if (!linearProgram1(lines, i, radius, opt, directionOpt, result)) {
        result.x = keep.x;
        result.y = keep.y;
        return i;
      }
    }
  }
  return lines.length;
}

/**
 * Infeasible: minimise the largest violation of the agent lines (obstacle lines stay hard) — a 3-D LP solved
 * as a sequence of 2-D ones over the lines' pairwise bisectors.
 */
export function linearProgram3(lines: Line[], numObstLines: number, beginLine: number, radius: number, result: Vec2): void {
  let distance = 0;
  for (let i = beginLine; i < lines.length; i++) {
    if (det(lines[i].direction, sub(lines[i].point, result)) > distance) {
      const projLines: Line[] = lines.slice(0, numObstLines);
      for (let j = numObstLines; j < i; j++) {
        const determinant = det(lines[i].direction, lines[j].direction);
        let point: Vec2;
        if (Math.abs(determinant) <= EPS) {
          if (dot(lines[i].direction, lines[j].direction) > 0) continue; // same direction
          point = scale(add(lines[i].point, lines[j].point), 0.5);
        } else {
          point = add(lines[i].point, scale(lines[i].direction, det(lines[j].direction, sub(lines[i].point, lines[j].point)) / determinant));
        }
        projLines.push({ point, direction: normalize(sub(lines[j].direction, lines[i].direction)) });
      }
      const keep = v2(result.x, result.y);
      if (linearProgram2(projLines, radius, v2(-lines[i].direction.y, lines[i].direction.x), true, result) < projLines.length) {
        // Cannot happen in exact arithmetic (the result is feasible by construction); keep the last result.
        result.x = keep.x;
        result.y = keep.y;
      }
      distance = det(lines[i].direction, sub(lines[i].point, result));
    }
  }
}

// ------------------------------------------------------------------------------------------ obstacles

/** One vertex of a polygonal obstacle (RVO2's linked representation). */
export interface ObstacleVertex {
  point: Vec2;
  /** Unit direction to the next vertex. */
  unitDir: Vec2;
  isConvex: boolean;
  next: ObstacleVertex;
  prev: ObstacleVertex;
  id: number;
}

/** Build a polygon's vertices; give them counter-clockwise (in x–y) so the outside is to each edge's right. */
export function makeObstacle(points: Vec2[], startId = 0): ObstacleVertex[] {
  const vs = points.map((p, i) => ({ point: { ...p }, id: startId + i }) as ObstacleVertex);
  const n = vs.length;
  vs.forEach((v, i) => {
    v.next = vs[(i + 1) % n];
    v.prev = vs[(i - 1 + n) % n];
  });
  for (const v of vs) {
    v.unitDir = normalize(sub(v.next.point, v.point));
    v.isConvex = n === 2 ? true : leftOf(v.prev.point, v.point, v.next.point) >= 0;
  }
  return vs;
}

// ------------------------------------------------------------------------------------------ the agent rule

export interface AgentState {
  position: Vec2;
  velocity: Vec2;
  radius: number;
}

export interface OrcaParams {
  /** Seconds ahead an agent guarantees no collision with other agents / with obstacles. */
  timeHorizon: number;
  timeHorizonObst: number;
  maxSpeed: number;
}

/**
 * The ORCA lines for one agent: obstacles first (they must be satisfied exactly), then agents. Returns the
 * lines and how many came from obstacles. `obstacles` are edges (vertex → vertex.next) near the agent with the
 * agent on their outer side, nearest first; `neighbours` are the nearest agents.
 */
export function orcaLines(agent: AgentState, neighbours: AgentState[], obstacles: ObstacleVertex[], p: OrcaParams, dt: number): { lines: Line[]; numObstLines: number } {
  const lines: Line[] = [];
  const pos = agent.position;
  const vel = agent.velocity;
  const r = agent.radius;
  const invTimeHorizonObst = 1 / p.timeHorizonObst;

  for (const start of obstacles) {
    let obstacle1 = start;
    let obstacle2 = start.next;
    const relativePosition1 = sub(obstacle1.point, pos);
    const relativePosition2 = sub(obstacle2.point, pos);

    // Already covered by an earlier obstacle's line?
    let alreadyCovered = false;
    for (const l of lines) {
      if (
        det(sub(scale(relativePosition1, invTimeHorizonObst), l.point), l.direction) - invTimeHorizonObst * r >= -EPS &&
        det(sub(scale(relativePosition2, invTimeHorizonObst), l.point), l.direction) - invTimeHorizonObst * r >= -EPS
      ) {
        alreadyCovered = true;
        break;
      }
    }
    if (alreadyCovered) continue;

    const distSq1 = absSq(relativePosition1);
    const distSq2 = absSq(relativePosition2);
    const radiusSq = r * r;
    const obstacleVector = sub(obstacle2.point, obstacle1.point);
    const s = dot(scale(relativePosition1, -1), obstacleVector) / absSq(obstacleVector);
    const distSqLine = absSq(sub(scale(relativePosition1, -1), scale(obstacleVector, s)));

    // Already colliding with a vertex or the edge: push straight out.
    if (s < 0 && distSq1 <= radiusSq) {
      if (obstacle1.isConvex) lines.push({ point: v2(0, 0), direction: normalize(v2(-relativePosition1.y, relativePosition1.x)) });
      continue;
    } else if (s > 1 && distSq2 <= radiusSq) {
      if (obstacle2.isConvex && det(relativePosition2, obstacle2.unitDir) >= 0)
        lines.push({ point: v2(0, 0), direction: normalize(v2(-relativePosition2.y, relativePosition2.x)) });
      continue;
    } else if (s >= 0 && s < 1 && distSqLine <= radiusSq) {
      lines.push({ point: v2(0, 0), direction: scale(obstacle1.unitDir, -1) });
      continue;
    }

    // No collision: the legs of the obstacle's velocity obstacle.
    let leftLegDirection: Vec2;
    let rightLegDirection: Vec2;
    if (s < 0 && distSqLine <= radiusSq) {
      // Seen obliquely: both legs come from the left vertex.
      if (!obstacle1.isConvex) continue;
      obstacle2 = obstacle1;
      const leg1 = Math.sqrt(distSq1 - radiusSq);
      leftLegDirection = scale(v2(relativePosition1.x * leg1 - relativePosition1.y * r, relativePosition1.x * r + relativePosition1.y * leg1), 1 / distSq1);
      rightLegDirection = scale(v2(relativePosition1.x * leg1 + relativePosition1.y * r, -relativePosition1.x * r + relativePosition1.y * leg1), 1 / distSq1);
    } else if (s > 1 && distSqLine <= radiusSq) {
      // Both legs from the right vertex.
      if (!obstacle2.isConvex) continue;
      obstacle1 = obstacle2;
      const leg2 = Math.sqrt(distSq2 - radiusSq);
      leftLegDirection = scale(v2(relativePosition2.x * leg2 - relativePosition2.y * r, relativePosition2.x * r + relativePosition2.y * leg2), 1 / distSq2);
      rightLegDirection = scale(v2(relativePosition2.x * leg2 + relativePosition2.y * r, -relativePosition2.x * r + relativePosition2.y * leg2), 1 / distSq2);
    } else {
      if (obstacle1.isConvex) {
        const leg1 = Math.sqrt(distSq1 - radiusSq);
        leftLegDirection = scale(v2(relativePosition1.x * leg1 - relativePosition1.y * r, relativePosition1.x * r + relativePosition1.y * leg1), 1 / distSq1);
      } else leftLegDirection = scale(obstacle1.unitDir, -1);
      if (obstacle2.isConvex) {
        const leg2 = Math.sqrt(distSq2 - radiusSq);
        rightLegDirection = scale(v2(relativePosition2.x * leg2 + relativePosition2.y * r, -relativePosition2.x * r + relativePosition2.y * leg2), 1 / distSq2);
      } else rightLegDirection = obstacle1.unitDir;
    }

    // A leg pointing into the neighbouring edge is replaced by that edge (its line will handle it).
    const leftNeighbor = obstacle1.prev;
    let isLeftLegForeign = false;
    let isRightLegForeign = false;
    if (obstacle1.isConvex && det(leftLegDirection, scale(leftNeighbor.unitDir, -1)) >= 0) {
      leftLegDirection = scale(leftNeighbor.unitDir, -1);
      isLeftLegForeign = true;
    }
    if (obstacle2.isConvex && det(rightLegDirection, obstacle2.unitDir) <= 0) {
      rightLegDirection = obstacle2.unitDir;
      isRightLegForeign = true;
    }

    // Cut-off centres and the projection of the current velocity onto the truncated cone.
    const leftCutoff = scale(sub(obstacle1.point, pos), invTimeHorizonObst);
    const rightCutoff = scale(sub(obstacle2.point, pos), invTimeHorizonObst);
    const cutoffVec = sub(rightCutoff, leftCutoff);
    const t = obstacle1 === obstacle2 ? 0.5 : dot(sub(vel, leftCutoff), cutoffVec) / absSq(cutoffVec);
    const tLeft = dot(sub(vel, leftCutoff), leftLegDirection);
    const tRight = dot(sub(vel, rightCutoff), rightLegDirection);

    if ((t < 0 && tLeft < 0) || (obstacle1 === obstacle2 && tLeft < 0 && tRight < 0)) {
      const unitW = normalize(sub(vel, leftCutoff));
      lines.push({ direction: v2(unitW.y, -unitW.x), point: add(leftCutoff, scale(unitW, r * invTimeHorizonObst)) });
      continue;
    } else if (t > 1 && tRight < 0) {
      const unitW = normalize(sub(vel, rightCutoff));
      lines.push({ direction: v2(unitW.y, -unitW.x), point: add(rightCutoff, scale(unitW, r * invTimeHorizonObst)) });
      continue;
    }

    const distSqCutoff = t < 0 || t > 1 || obstacle1 === obstacle2 ? Infinity : absSq(sub(vel, add(leftCutoff, scale(cutoffVec, t))));
    const distSqLeft = tLeft < 0 ? Infinity : absSq(sub(vel, add(leftCutoff, scale(leftLegDirection, tLeft))));
    const distSqRight = tRight < 0 ? Infinity : absSq(sub(vel, add(rightCutoff, scale(rightLegDirection, tRight))));

    if (distSqCutoff <= distSqLeft && distSqCutoff <= distSqRight) {
      const direction = scale(obstacle1.unitDir, -1);
      lines.push({ direction, point: add(leftCutoff, scale(v2(-direction.y, direction.x), r * invTimeHorizonObst)) });
    } else if (distSqLeft <= distSqRight) {
      if (isLeftLegForeign) continue;
      const direction = leftLegDirection;
      lines.push({ direction, point: add(leftCutoff, scale(v2(-direction.y, direction.x), r * invTimeHorizonObst)) });
    } else {
      if (isRightLegForeign) continue;
      const direction = scale(rightLegDirection, -1);
      lines.push({ direction, point: add(rightCutoff, scale(v2(-direction.y, direction.x), r * invTimeHorizonObst)) });
    }
  }

  const numObstLines = lines.length;
  const invTimeHorizon = 1 / p.timeHorizon;

  for (const other of neighbours) {
    const relativePosition = sub(other.position, pos);
    const relativeVelocity = sub(vel, other.velocity);
    const distSq = absSq(relativePosition);
    const combinedRadius = r + other.radius;
    const combinedRadiusSq = combinedRadius * combinedRadius;
    let direction: Vec2;
    let u: Vec2;
    if (distSq > combinedRadiusSq) {
      // No collision yet. w: relative velocity seen from the cut-off circle's centre.
      const w = sub(relativeVelocity, scale(relativePosition, invTimeHorizon));
      const wLengthSq = absSq(w);
      const dotProduct1 = dot(w, relativePosition);
      if (dotProduct1 < 0 && dotProduct1 * dotProduct1 > combinedRadiusSq * wLengthSq) {
        // Project on the cut-off circle.
        const wLength = Math.sqrt(wLengthSq);
        const unitW = scale(w, 1 / wLength);
        direction = v2(unitW.y, -unitW.x);
        u = scale(unitW, combinedRadius * invTimeHorizon - wLength);
      } else {
        // Project on the nearer leg.
        const leg = Math.sqrt(distSq - combinedRadiusSq);
        if (det(relativePosition, w) > 0) {
          direction = scale(v2(relativePosition.x * leg - relativePosition.y * combinedRadius, relativePosition.x * combinedRadius + relativePosition.y * leg), 1 / distSq);
        } else {
          direction = scale(v2(relativePosition.x * leg + relativePosition.y * combinedRadius, -relativePosition.x * combinedRadius + relativePosition.y * leg), -1 / distSq);
        }
        u = sub(scale(direction, dot(relativeVelocity, direction)), relativeVelocity);
      }
    } else {
      // Already overlapping: separate within one time step.
      const invTimeStep = 1 / dt;
      const w = sub(relativeVelocity, scale(relativePosition, invTimeStep));
      const wLength = Math.sqrt(absSq(w));
      const unitW = scale(w, 1 / wLength);
      direction = v2(unitW.y, -unitW.x);
      u = scale(unitW, combinedRadius * invTimeStep - wLength);
    }
    // Take half the responsibility: the neighbour takes the other half.
    lines.push({ direction, point: add(vel, scale(u, 0.5)) });
  }
  return { lines, numObstLines };
}

/** ORCA's new velocity for one agent. */
export function orcaVelocity(agent: AgentState, preferred: Vec2, neighbours: AgentState[], obstacles: ObstacleVertex[], p: OrcaParams, dt: number): Vec2 {
  const { lines, numObstLines } = orcaLines(agent, neighbours, obstacles, p, dt);
  const result = v2(0, 0);
  const lineFail = linearProgram2(lines, p.maxSpeed, preferred, false, result);
  if (lineFail < lines.length) linearProgram3(lines, numObstLines, lineFail, p.maxSpeed, result);
  return result;
}

/** Obstacle edges near `pos` with `pos` on their outer side, nearest first (RVO2's obstacle query, brute force). */
export function nearbyObstacles(vertices: ObstacleVertex[], pos: Vec2, range: number): ObstacleVertex[] {
  const out: { v: ObstacleVertex; d: number }[] = [];
  const rangeSq = range * range;
  for (const v of vertices) {
    if (leftOf(v.point, v.next.point, pos) >= 0) continue;
    const d = distSqPointSegment(v.point, v.next.point, pos);
    if (d < rangeSq) out.push({ v, d });
  }
  return out.sort((a, b) => a.d - b.d).map((o) => o.v);
}

export { distSqPointSegment, leftOf };
