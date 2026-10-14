/**
 * Bitonic sort as a sequence of full-screen passes. Every pass compares element i with i ^ j; within a
 * block of size k the sequence is sorted ascending where (i & k) == 0 and descending elsewhere, so after the
 * last pass (k = n) the whole array is ascending. n must be a power of two: log₂n·(log₂n + 1)/2 passes.
 *
 * Elements are (key, index) pairs ordered by key, then index — a total order, so the result is unique and a
 * CPU reference reproduces it exactly.
 */

export function bitonicPasses(n: number): { j: number; k: number }[] {
  if (n & (n - 1)) throw new Error('bitonic sort needs a power-of-two size');
  const passes: { j: number; k: number }[] = [];
  for (let k = 2; k <= n; k <<= 1) for (let j = k >> 1; j > 0; j >>= 1) passes.push({ j, k });
  return passes;
}

/** GLSL for one pass: `src` holds (key, index, …) per texel; writes the element this texel keeps. */
export const BITONIC_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D src;
uniform int j;
uniform int k;
uniform int width;
uniform int log2Width;
out vec4 outValue;
void main() {
  ivec2 xy = ivec2(gl_FragCoord.xy);
  int i = xy.y * width + xy.x;
  int l = i ^ j;
  vec4 a = texelFetch(src, xy, 0);
  vec4 b = texelFetch(src, ivec2(l & (width - 1), l >> log2Width), 0);
  bool aLess = a.x < b.x || (a.x == b.x && a.y < b.y);
  bool ascending = (i & k) == 0;
  bool keepMin = ascending == (i < l);
  outValue = keepMin == aLess ? a : b;
}
`;

/** The same pass on the CPU (pairs as [key, index] in a Float32Array of 2·n). */
export function bitonicPassCpu(src: Float32Array, j: number, k: number, out: Float32Array): void {
  const n = src.length / 2;
  for (let i = 0; i < n; i++) {
    const l = i ^ j;
    const ak = src[i * 2];
    const ai = src[i * 2 + 1];
    const bk = src[l * 2];
    const bi = src[l * 2 + 1];
    const aLess = ak < bk || (ak === bk && ai < bi);
    const keepMin = ((i & k) === 0) === i < l;
    const takeA = keepMin === aLess;
    out[i * 2] = takeA ? ak : bk;
    out[i * 2 + 1] = takeA ? ai : bi;
  }
}
