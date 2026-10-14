import * as THREE from 'three';
import { BITONIC_FRAGMENT, bitonicPasses } from '../../src/gpu/bitonic';
import { buildGrid, gridFor, stepBoids, type BoidParams, type BoidState, type Grid } from '../../src/gpu/boidsCpu';
import type { Compute } from '../../src/gpu/compute';

const KEY_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D posTex;
uniform vec3 gridMin;
uniform float invCell;
uniform ivec3 dims;
uniform int width;
out vec4 outValue;
void main() {
  ivec2 xy = ivec2(gl_FragCoord.xy);
  int i = xy.y * width + xy.x;
  vec3 p = texelFetch(posTex, xy, 0).xyz;
  ivec3 c = clamp(ivec3(floor((p - gridMin) * invCell)), ivec3(0), dims - 1);
  outValue = vec4(float(c.x + dims.x * (c.y + dims.y * c.z)), float(i), 0.0, 0.0);
}
`;

const CELL_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D sorted;
uniform int n;
uniform int width;
uniform int log2Width;
uniform int cellWidth;
uniform int cells;
out vec4 outValue;
int lowerBound(float key) {
  int lo = 0;
  int hi = n;
  for (int s = 0; s < 32; s++) {
    if (lo >= hi) break;
    int mid = (lo + hi) >> 1;
    if (texelFetch(sorted, ivec2(mid & (width - 1), mid >> log2Width), 0).x < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
void main() {
  ivec2 xy = ivec2(gl_FragCoord.xy);
  int c = xy.y * cellWidth + xy.x;
  if (c >= cells) { outValue = vec4(0.0); return; }
  outValue = vec4(float(lowerBound(float(c))), float(lowerBound(float(c + 1))), 0.0, 0.0);
}
`;

const UPDATE_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D posTex;
uniform sampler2D velTex;
uniform sampler2D sorted;
uniform sampler2D cellTex;
uniform int width;
uniform int log2Width;
uniform int cellWidth;
uniform int cap;
uniform vec3 gridMin;
uniform float invCell;
uniform ivec3 dims;
uniform float dt;
uniform float radius;
uniform float separation;
uniform float wSeparation;
uniform float wAlignment;
uniform float wCohesion;
uniform float wBounds;
uniform float wObstacle;
uniform float wFlee;
uniform float minSpeed;
uniform float maxSpeed;
uniform float margin;
uniform vec3 center;
uniform vec3 halfExtent;
uniform vec4 obstacle;
uniform vec4 predator;
layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;
void main() {
  ivec2 xy = ivec2(gl_FragCoord.xy);
  int i = xy.y * width + xy.x;
  vec4 P = texelFetch(posTex, xy, 0);
  vec4 V = texelFetch(velTex, xy, 0);
  vec3 p = P.xyz;
  vec3 v = V.xyz;
  ivec3 c = clamp(ivec3(floor((p - gridMin) * invCell)), ivec3(0), dims - 1);
  float r2 = radius * radius;
  float sep2 = separation * separation;
  int count = 0;
  vec3 sumV = vec3(0.0);
  vec3 sumD = vec3(0.0);
  vec3 sep = vec3(0.0);
  for (int dz = -1; dz <= 1; dz++)
  for (int dy = -1; dy <= 1; dy++)
  for (int dx = -1; dx <= 1; dx++) {
    ivec3 cc = c + ivec3(dx, dy, dz);
    if (any(lessThan(cc, ivec3(0))) || any(greaterThanEqual(cc, dims))) continue;
    int cell = cc.x + dims.x * (cc.y + dims.y * cc.z);
    vec2 range = texelFetch(cellTex, ivec2(cell % cellWidth, cell / cellWidth), 0).xy;
    int s = int(range.x);
    int e = min(int(range.y), s + cap);
    for (int t = s; t < e; t++) {
      int j = int(texelFetch(sorted, ivec2(t & (width - 1), t >> log2Width), 0).y);
      if (j == i) continue;
      ivec2 jxy = ivec2(j & (width - 1), j >> log2Width);
      vec3 d = texelFetch(posTex, jxy, 0).xyz - p;
      float d2 = dot(d, d);
      if (d2 < r2) {
        count++;
        sumV += texelFetch(velTex, jxy, 0).xyz;
        sumD += d;
        if (d2 < sep2) sep -= d / max(d2, 1e-4);
      }
    }
  }
  vec3 a = vec3(0.0);
  if (count > 0) {
    a += wAlignment * (sumV / float(count) - v);
    a += wCohesion * (sumD / float(count));
  }
  a += wSeparation * sep;
  vec3 dc = p - center;
  vec3 lim = halfExtent - margin;
  a -= wBounds * (max(dc - lim, 0.0) + min(dc + lim, 0.0));
  vec3 d = p - obstacle.xyz;
  float dist = length(d);
  float reach = obstacle.w + margin;
  if (dist < reach && dist > 1e-6) a += d * (wObstacle * (reach - dist) / dist);
  d = p - predator.xyz;
  dist = length(d);
  reach = predator.w;
  if (dist < reach && dist > 1e-6) a += d * (wFlee * maxSpeed * (1.0 - dist / reach) / dist);
  v += a * dt;
  float sp = length(v);
  v *= sp > maxSpeed ? maxSpeed / sp : (sp < minSpeed ? minSpeed / max(sp, 1e-6) : 1.0);
  float speed = length(v);
  float phase = V.w + dt * (3.0 + 9.0 * speed / maxSpeed);
  if (phase > 6.2831853) phase -= 6.2831853;
  outPos = vec4(p + v * dt, float(count));
  outVel = vec4(v, phase);
}
`;

const COPY2_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D a;
uniform sampler2D b;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
void main() {
  outA = texelFetch(a, ivec2(gl_FragCoord.xy), 0);
  outB = texelFetch(b, ivec2(gl_FragCoord.xy), 0);
}
`;

/**
 * Boids entirely on the GPU: per frame a key pass, log₂N(log₂N+1)/2 bitonic sort passes, a cell-range pass
 * and one update pass writing position and velocity (two render targets). Mirrors `src/gpu/boidsCpu.ts`.
 */
export class GpuCrowd {
  readonly width: number;
  readonly log2Width: number;
  readonly grid: Grid;
  readonly cellWidth = 128;
  readonly passesPerStep: number;
  private readonly state: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private current = 0;
  private readonly sortTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private sortedIndex = 0;
  private readonly cellTarget: THREE.WebGLRenderTarget;
  private readonly keyPass: THREE.RawShaderMaterial;
  private readonly sortPass: THREE.RawShaderMaterial;
  private readonly cellPass: THREE.RawShaderMaterial;
  private readonly updatePass: THREE.RawShaderMaterial;
  private readonly passes: { j: number; k: number }[];

  constructor(
    readonly compute: Compute,
    readonly n: number,
    readonly params: BoidParams,
    initial: BoidState,
  ) {
    this.width = Math.sqrt(n);
    this.log2Width = Math.log2(this.width);
    if (!Number.isInteger(this.log2Width) || this.width * this.width !== n) throw new Error('n must be a power of four');
    this.grid = gridFor(params);
    if (this.grid.cells > this.cellWidth * this.cellWidth) throw new Error('grid too large for the cell texture');
    this.state = [compute.target(this.width, this.width, 2), compute.target(this.width, this.width, 2)];
    this.sortTargets = [compute.target(this.width, this.width), compute.target(this.width, this.width)];
    this.cellTarget = compute.target(this.cellWidth, this.cellWidth);
    this.passes = bitonicPasses(n);
    this.passesPerStep = this.passes.length + 3;

    const g = this.grid;
    const common = {
      width: { value: this.width },
      log2Width: { value: this.log2Width },
      gridMin: { value: new THREE.Vector3(...g.min) },
      invCell: { value: g.invCell },
      dims: { value: Int32Array.from(g.dims) },
    };
    this.keyPass = compute.pass(KEY_FRAGMENT, { posTex: { value: null }, ...common });
    this.sortPass = compute.pass(BITONIC_FRAGMENT, { src: { value: null }, j: { value: 0 }, k: { value: 0 }, width: common.width, log2Width: common.log2Width });
    this.cellPass = compute.pass(CELL_FRAGMENT, {
      sorted: { value: null },
      n: { value: n },
      width: common.width,
      log2Width: common.log2Width,
      cellWidth: { value: this.cellWidth },
      cells: { value: g.cells },
    });
    this.updatePass = compute.pass(UPDATE_FRAGMENT, {
      posTex: { value: null },
      velTex: { value: null },
      sorted: { value: null },
      cellTex: { value: this.cellTarget.texture },
      cellWidth: { value: this.cellWidth },
      cap: { value: params.cap },
      dt: { value: 1 / 60 },
      radius: { value: 0 },
      separation: { value: 0 },
      wSeparation: { value: 0 },
      wAlignment: { value: 0 },
      wCohesion: { value: 0 },
      wBounds: { value: 0 },
      wObstacle: { value: 0 },
      wFlee: { value: 0 },
      minSpeed: { value: 0 },
      maxSpeed: { value: 0 },
      margin: { value: 0 },
      center: { value: new THREE.Vector3() },
      halfExtent: { value: new THREE.Vector3() },
      obstacle: { value: new THREE.Vector4() },
      predator: { value: new THREE.Vector4() },
      ...common,
    });
    this.upload(initial);
  }

  /** Current position (xyz, neighbour count) and velocity (xyz, swim phase) textures. */
  get positions(): THREE.Texture {
    return this.state[this.current].textures[0];
  }

  get velocities(): THREE.Texture {
    return this.state[this.current].textures[1];
  }

  upload(s: BoidState): void {
    const mk = (d: Float32Array) => {
      const t = new THREE.DataTexture(d, this.width, this.width, THREE.RGBAFormat, THREE.FloatType);
      t.needsUpdate = true;
      return t;
    };
    const a = mk(s.pos);
    const b = mk(s.vel);
    const copy = this.compute.pass(COPY2_FRAGMENT, { a: { value: a }, b: { value: b } });
    this.compute.run(copy, this.state[this.current]);
    copy.dispose();
    a.dispose();
    b.dispose();
  }

  /** Key, sort and cell-range passes for the current state. */
  buildGrid(): void {
    const c = this.compute;
    this.keyPass.uniforms.posTex.value = this.positions;
    c.run(this.keyPass, this.sortTargets[0]);
    this.sortedIndex = 0;
    for (const { j, k } of this.passes) {
      this.sortPass.uniforms.src.value = this.sortTargets[this.sortedIndex].texture;
      this.sortPass.uniforms.j.value = j;
      this.sortPass.uniforms.k.value = k;
      c.run(this.sortPass, this.sortTargets[1 - this.sortedIndex]);
      this.sortedIndex = 1 - this.sortedIndex;
    }
    this.cellPass.uniforms.sorted.value = this.sortTargets[this.sortedIndex].texture;
    c.run(this.cellPass, this.cellTarget);
  }

  step(dt: number): void {
    this.buildGrid();
    const u = this.updatePass.uniforms;
    const p = this.params;
    u.posTex.value = this.positions;
    u.velTex.value = this.velocities;
    u.sorted.value = this.sortTargets[this.sortedIndex].texture;
    u.dt.value = dt;
    u.cap.value = p.cap;
    for (const key of ['radius', 'separation', 'wSeparation', 'wAlignment', 'wCohesion', 'wBounds', 'wObstacle', 'wFlee', 'minSpeed', 'maxSpeed', 'margin'] as const) u[key].value = p[key];
    (u.center.value as THREE.Vector3).set(...p.center);
    (u.halfExtent.value as THREE.Vector3).set(...p.half);
    (u.obstacle.value as THREE.Vector4).set(...p.obstacle);
    (u.predator.value as THREE.Vector4).set(...p.predator);
    this.compute.run(this.updatePass, this.state[1 - this.current]);
    this.current = 1 - this.current;
  }

  read(): BoidState {
    const t = this.state[this.current];
    return { n: this.n, pos: this.compute.read(t, 0), vel: this.compute.read(t, 1) };
  }

  /**
   * Check the GPU against the CPU reference on the current state: sorted keys non-decreasing and indices a
   * permutation, the cell table identical, and one update step within `tol` metres for each boid.
   */
  verify(dt = 1 / 60, tol = 1e-4) {
    const before = this.read();
    this.buildGrid();
    const sorted = this.compute.read(this.sortTargets[this.sortedIndex]);
    const cells = this.compute.read(this.cellTarget);
    const ref = buildGrid(before, this.grid);
    let ordered = true;
    const seen = new Uint8Array(this.n);
    let keysMatch = true;
    for (let i = 0; i < this.n; i++) {
      const k = sorted[i * 4];
      const idx = sorted[i * 4 + 1];
      if (i > 0 && (k < sorted[(i - 1) * 4] || (k === sorted[(i - 1) * 4] && idx < sorted[(i - 1) * 4 + 1]))) ordered = false;
      if (idx >= 0 && idx < this.n) seen[idx] = 1;
      if (k !== ref.keys[i] || idx !== ref.index[i]) keysMatch = false;
    }
    let cellMismatches = 0;
    for (let c = 0; c < this.grid.cells; c++) {
      if (cells[c * 4] !== ref.start[c] || cells[c * 4 + 1] !== ref.end[c]) cellMismatches++;
    }
    this.step(dt);
    const after = this.read();
    const cpu = stepBoids(before, this.params, dt, this.grid, ref);
    let within = 0;
    let worst = 0;
    let countMismatches = 0;
    for (let i = 0; i < this.n; i++) {
      const e = Math.hypot(after.pos[i * 4] - cpu.pos[i * 4], after.pos[i * 4 + 1] - cpu.pos[i * 4 + 1], after.pos[i * 4 + 2] - cpu.pos[i * 4 + 2]);
      worst = Math.max(worst, e);
      if (e <= tol) within++;
      if (after.pos[i * 4 + 3] !== cpu.pos[i * 4 + 3]) countMismatches++;
    }
    return {
      n: this.n,
      ordered,
      permutation: seen.every((x) => x === 1),
      keysMatch,
      cellMismatches,
      withinTolerance: within / this.n,
      worstError: worst,
      countMismatches,
    };
  }

  dispose(): void {
    for (const t of [...this.state, ...this.sortTargets, this.cellTarget]) t.dispose();
    for (const m of [this.keyPass, this.sortPass, this.cellPass, this.updatePass]) m.dispose();
  }
}
