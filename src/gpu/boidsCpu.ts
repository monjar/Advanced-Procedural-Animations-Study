/**
 * Reference implementation of the study 11 boids, step for step the algorithm the GPU passes run:
 *  1. cell key per boid in a uniform grid (cell = neighbour radius);
 *  2. sort (key, index) pairs — a total order, so ties are deterministic;
 *  3. each cell's [start, end) found by binary search over the sorted keys;
 *  4. each boid visits the 27 cells around it, at most `cap` boids per cell, and steers.
 * The GPU result can then be checked against this one on the same state (tests/e2e/gpu-crowds.spec.ts).
 */

export interface BoidParams {
  /** Neighbour radius = grid cell size (m). */
  radius: number;
  separation: number;
  /** Rule weights. */
  wSeparation: number;
  wAlignment: number;
  wCohesion: number;
  wBounds: number;
  wObstacle: number;
  wFlee: number;
  minSpeed: number;
  maxSpeed: number;
  /** Boids considered per neighbouring cell. */
  cap: number;
  /** Tank: centre and half extents; boids steer back inside the margin. */
  center: [number, number, number];
  half: [number, number, number];
  margin: number;
  /** Spherical rock. */
  obstacle: [number, number, number, number];
  /** Predator position and fear radius. */
  predator: [number, number, number, number];
}

export const DEFAULT_BOIDS: BoidParams = {
  radius: 1.6,
  separation: 0.6,
  wSeparation: 1.6,
  wAlignment: 1.2,
  wCohesion: 0.5,
  wBounds: 2,
  wObstacle: 6,
  wFlee: 10,
  minSpeed: 1.2,
  maxSpeed: 4,
  cap: 24,
  center: [0, 8, 0],
  half: [24, 7, 24],
  margin: 3,
  obstacle: [6, 5, -4, 3],
  predator: [0, -100, 0, 6],
};

export interface Grid {
  dims: [number, number, number];
  min: [number, number, number];
  invCell: number;
  cells: number;
}

/** Grid covering the tank (plus one cell of slack) with cell size = neighbour radius. */
export function gridFor(p: BoidParams): Grid {
  const f = Math.fround;
  const dims = p.half.map((h) => Math.ceil((2 * h) / p.radius) + 2) as [number, number, number];
  const min = p.center.map((c, i) => f(c - p.half[i] - p.radius)) as [number, number, number];
  return { dims, min, invCell: f(1 / p.radius), cells: dims[0] * dims[1] * dims[2] };
}

/** Cell coordinate along one axis, in float32 arithmetic like the shader (multiply, never divide). */
function cellCoord(p: number, min: number, inv: number, n: number): number {
  const f = Math.fround;
  const c = Math.floor(f(f(f(p) - min) * inv));
  return Math.min(n - 1, Math.max(0, c));
}

export function cellOf(g: Grid, x: number, y: number, z: number): number {
  const cx = cellCoord(x, g.min[0], g.invCell, g.dims[0]);
  const cy = cellCoord(y, g.min[1], g.invCell, g.dims[1]);
  const cz = cellCoord(z, g.min[2], g.invCell, g.dims[2]);
  return cx + g.dims[0] * (cy + g.dims[1] * cz);
}

/** State as stored on the GPU: position + neighbour count, velocity + swim phase (RGBA per boid). */
export interface BoidState {
  n: number;
  pos: Float32Array; // n·4
  vel: Float32Array; // n·4
}

export function randomBoids(n: number, p: BoidParams, seed = 1): BoidState {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pos = new Float32Array(n * 4);
  const vel = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) pos[i * 4 + k] = p.center[k] + (rnd() * 2 - 1) * (p.half[k] - p.margin);
    const th = rnd() * Math.PI * 2;
    const ph = (rnd() - 0.5) * 0.6;
    const sp = p.minSpeed + rnd() * (p.maxSpeed - p.minSpeed) * 0.5;
    vel.set([Math.cos(th) * Math.cos(ph) * sp, Math.sin(ph) * sp, Math.sin(th) * Math.cos(ph) * sp, rnd() * 6.28], i * 4);
  }
  return { n, pos, vel };
}

export interface SortedGrid {
  /** (key, index) sorted by key then index. */
  keys: Float32Array;
  index: Float32Array;
  /** Per cell: start and end into the sorted arrays. */
  start: Int32Array;
  end: Int32Array;
}

export function buildGrid(state: BoidState, g: Grid): SortedGrid {
  const n = state.n;
  const order = Array.from({ length: n }, (_, i) => i);
  const key = new Float32Array(n);
  for (let i = 0; i < n; i++) key[i] = cellOf(g, state.pos[i * 4], state.pos[i * 4 + 1], state.pos[i * 4 + 2]);
  order.sort((a, b) => key[a] - key[b] || a - b);
  const keys = Float32Array.from(order, (i) => key[i]);
  const index = Float32Array.from(order);
  const lowerBound = (k: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < k) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const start = new Int32Array(g.cells);
  const end = new Int32Array(g.cells);
  for (let c = 0; c < g.cells; c++) {
    start[c] = lowerBound(c);
    end[c] = lowerBound(c + 1);
  }
  return { keys, index, start, end };
}

/** Indices of boid i's neighbours as the grid search sees them (within `radius`, cap per cell). */
export function gridNeighbours(state: BoidState, g: Grid, sg: SortedGrid, p: BoidParams, i: number, cap = p.cap): number[] {
  const px = state.pos[i * 4];
  const py = state.pos[i * 4 + 1];
  const pz = state.pos[i * 4 + 2];
  const cx = cellCoord(px, g.min[0], g.invCell, g.dims[0]);
  const cy = cellCoord(py, g.min[1], g.invCell, g.dims[1]);
  const cz = cellCoord(pz, g.min[2], g.invCell, g.dims[2]);
  const r2 = p.radius * p.radius;
  const out: number[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const z = cz + dz;
        if (x < 0 || y < 0 || z < 0 || x >= g.dims[0] || y >= g.dims[1] || z >= g.dims[2]) continue;
        const c = x + g.dims[0] * (y + g.dims[1] * z);
        const e = Math.min(sg.end[c], sg.start[c] + cap);
        for (let t = sg.start[c]; t < e; t++) {
          const j = sg.index[t];
          if (j === i) continue;
          const ddx = state.pos[j * 4] - px;
          const ddy = state.pos[j * 4 + 1] - py;
          const ddz = state.pos[j * 4 + 2] - pz;
          if (ddx * ddx + ddy * ddy + ddz * ddz < r2) out.push(j);
        }
      }
    }
  }
  return out;
}

/** One boids step (the GPU update pass), returning the new state. */
export function stepBoids(state: BoidState, p: BoidParams, dt: number, g = gridFor(p), sg = buildGrid(state, g)): BoidState {
  const n = state.n;
  const pos = new Float32Array(n * 4);
  const vel = new Float32Array(n * 4);
  const sep2 = p.separation * p.separation;
  for (let i = 0; i < n; i++) {
    const px = state.pos[i * 4];
    const py = state.pos[i * 4 + 1];
    const pz = state.pos[i * 4 + 2];
    let vx = state.vel[i * 4];
    let vy = state.vel[i * 4 + 1];
    let vz = state.vel[i * 4 + 2];
    let count = 0;
    const sum = [0, 0, 0, 0, 0, 0];
    const sep = [0, 0, 0];
    for (const j of gridNeighbours(state, g, sg, p, i)) {
      const dx = state.pos[j * 4] - px;
      const dy = state.pos[j * 4 + 1] - py;
      const dz = state.pos[j * 4 + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      count++;
      sum[0] += state.vel[j * 4];
      sum[1] += state.vel[j * 4 + 1];
      sum[2] += state.vel[j * 4 + 2];
      sum[3] += dx;
      sum[4] += dy;
      sum[5] += dz;
      if (d2 < sep2) {
        const k = 1 / Math.max(d2, 1e-4);
        sep[0] -= dx * k;
        sep[1] -= dy * k;
        sep[2] -= dz * k;
      }
    }
    const acc = steer(p, [px, py, pz], [vx, vy, vz], count, sum, sep);
    vx += acc[0] * dt;
    vy += acc[1] * dt;
    vz += acc[2] * dt;
    const sp = Math.hypot(vx, vy, vz);
    const k = sp > p.maxSpeed ? p.maxSpeed / sp : sp < p.minSpeed ? p.minSpeed / Math.max(sp, 1e-6) : 1;
    vx *= k;
    vy *= k;
    vz *= k;
    const speed = Math.hypot(vx, vy, vz);
    pos.set([px + vx * dt, py + vy * dt, pz + vz * dt, count], i * 4);
    vel.set([vx, vy, vz, state.vel[i * 4 + 3] + dt * (3 + (9 * speed) / p.maxSpeed)], i * 4);
  }
  return { n, pos, vel };
}

/**
 * Steering for one boid. `sum` = neighbour velocity sum (0–2) and offset sum (3–5), `sep` = separation push.
 * Shared rules: alignment to the neighbours' mean velocity, cohesion towards their centre, separation
 * (∝ 1/d), soft tank walls, a spherical rock and a predator to flee.
 */
export function steer(p: BoidParams, pos: number[], vel: number[], count: number, sum: number[], sep: number[]): number[] {
  const a = [0, 0, 0];
  if (count > 0) {
    for (let k = 0; k < 3; k++) {
      a[k] += p.wAlignment * (sum[k] / count - vel[k]);
      a[k] += p.wCohesion * (sum[3 + k] / count);
    }
  }
  for (let k = 0; k < 3; k++) {
    a[k] += p.wSeparation * sep[k];
    const d = pos[k] - p.center[k];
    const lim = p.half[k] - p.margin;
    if (d > lim) a[k] -= p.wBounds * (d - lim);
    if (d < -lim) a[k] -= p.wBounds * (d + lim);
  }
  // Rock: pushed out of the sphere grown by the margin, in proportion to the depth inside it.
  const o = p.obstacle;
  let dx = pos[0] - o[0];
  let dy = pos[1] - o[1];
  let dz = pos[2] - o[2];
  let d = Math.hypot(dx, dy, dz);
  let reach = o[3] + p.margin;
  if (d < reach && d > 1e-6) {
    const s = (p.wObstacle * (reach - d)) / d;
    a[0] += dx * s;
    a[1] += dy * s;
    a[2] += dz * s;
  }
  // Predator: flee, strongest up close.
  const q = p.predator;
  dx = pos[0] - q[0];
  dy = pos[1] - q[1];
  dz = pos[2] - q[2];
  d = Math.hypot(dx, dy, dz);
  reach = q[3];
  if (d < reach && d > 1e-6) {
    const s = (p.wFlee * p.maxSpeed * (1 - d / reach)) / d;
    a[0] += dx * s;
    a[1] += dy * s;
    a[2] += dz * s;
  }
  return a;
}

/** Polarisation: |mean of unit velocities| — 0 for a swarm, 1 for a perfectly aligned school. */
export function polarisation(s: BoidState): number {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < s.n; i++) {
    const v = Math.hypot(s.vel[i * 4], s.vel[i * 4 + 1], s.vel[i * 4 + 2]) || 1;
    x += s.vel[i * 4] / v;
    y += s.vel[i * 4 + 1] / v;
    z += s.vel[i * 4 + 2] / v;
  }
  return Math.hypot(x, y, z) / s.n;
}

/**
 * Local order: for each boid with neighbours, |mean unit velocity of it and its neighbours|, averaged.
 * Schools heading different ways keep global polarisation low; this measures whether neighbours align.
 */
export function localOrder(s: BoidState, p: BoidParams): number {
  const g = gridFor(p);
  const sg = buildGrid(s, g);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < s.n; i++) {
    const nb = gridNeighbours(s, g, sg, p, i);
    if (!nb.length) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const j of [i, ...nb]) {
      const v = Math.hypot(s.vel[j * 4], s.vel[j * 4 + 1], s.vel[j * 4 + 2]) || 1;
      x += s.vel[j * 4] / v;
      y += s.vel[j * 4 + 1] / v;
      z += s.vel[j * 4 + 2] / v;
    }
    sum += Math.hypot(x, y, z) / (nb.length + 1);
    n++;
  }
  return n ? sum / n : 0;
}
