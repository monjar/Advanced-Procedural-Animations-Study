/**
 * The trained actor network in plain TypeScript: Linear → ELU → … → Linear. Three small matrix–vector products
 * per control step do not need an inference runtime (onnxruntime-web would add ~10 MB); the unit tests check
 * the outputs against PyTorch's on recorded observations.
 */

export interface PolicyFile {
  iteration: number;
  obs: number;
  act: number;
  actionScale: number;
  decimation: number;
  dt: number;
  defaultPose: number[];
  layers: { in: number; out: number; weight: string; bias: string }[];
}

function decodeF32(b64: string): Float32Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export class Mlp {
  readonly layers: { in: number; out: number; w: Float32Array; b: Float32Array }[];
  private readonly buffers: Float64Array[];

  constructor(readonly file: PolicyFile) {
    this.layers = file.layers.map((l) => ({ in: l.in, out: l.out, w: decodeF32(l.weight), b: decodeF32(l.bias) }));
    this.buffers = this.layers.map((l) => new Float64Array(l.out));
  }

  /** Action for an observation (PyTorch's Linear: y = W x + b, W row-major [out][in]). */
  act(obs: ArrayLike<number>, out: Float64Array = new Float64Array(this.file.act)): Float64Array {
    let x: ArrayLike<number> = obs;
    this.layers.forEach((l, k) => {
      const y = k === this.layers.length - 1 ? out : this.buffers[k];
      for (let o = 0; o < l.out; o++) {
        let s = l.b[o];
        const row = o * l.in;
        for (let i = 0; i < l.in; i++) s += l.w[row + i] * x[i];
        y[o] = k === this.layers.length - 1 ? s : s > 0 ? s : Math.expm1(s); // ELU(α = 1)
      }
      x = y;
    });
    return out;
  }
}
