/** The three trained networks (half-precision weights) and their input/output normalisation. */

interface LayerFile {
  in: number;
  out: number;
  weight: string;
  bias: string;
}

export interface NetworksFile {
  xDims: number;
  zDims: number;
  yDims: number;
  x: { mean: number[]; std: number[] };
  y: { mean: number[]; std: number[] };
  decompressor: LayerFile[];
  stepper: { layers: LayerFile[]; inMean: number[]; inStd: number[]; outMean: number[]; outStd: number[] };
  projector: { layers: LayerFile[]; outMean: number[]; outStd: number[] };
  fixture: { frames: number[]; z: number[][]; y: number[][] };
}

function bytesOf(b64: string): Uint8Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** IEEE 754 half → float. */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

function decodeF16(b64: string): Float32Array {
  const bytes = bytesOf(b64);
  const out = new Float32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = halfToFloat(bytes[2 * i] | (bytes[2 * i + 1] << 8));
  return out;
}

/** Linear → ELU → … → Linear, float32 arithmetic. */
export class Mlp {
  readonly layers: { in: number; out: number; w: Float32Array; b: Float32Array }[];
  private readonly buffers: Float32Array[];
  readonly params: number;

  constructor(layers: LayerFile[]) {
    this.layers = layers.map((l) => ({ in: l.in, out: l.out, w: decodeF16(l.weight), b: decodeF16(l.bias) }));
    this.buffers = this.layers.map((l) => new Float32Array(l.out));
    this.params = this.layers.reduce((n, l) => n + l.w.length + l.b.length, 0);
  }

  run(x: ArrayLike<number>, out: Float32Array): Float32Array {
    let v: ArrayLike<number> = x;
    const last = this.layers.length - 1;
    this.layers.forEach((l, k) => {
      const y = k === last ? out : this.buffers[k];
      for (let o = 0; o < l.out; o++) {
        let s = l.b[o];
        const row = o * l.in;
        for (let i = 0; i < l.in; i++) s += l.w[row + i] * v[i];
        y[o] = k === last || s > 0 ? s : Math.expm1(s);
      }
      v = y;
    });
    return out;
  }
}

/** The decompressor, stepper and projector with their normalisation folded in. */
export class Networks {
  readonly X: number;
  readonly Z: number;
  readonly Y: number;
  private readonly dec: Mlp;
  private readonly step_: Mlp;
  private readonly proj: Mlp;
  private readonly inDec: Float32Array;
  private readonly inStep: Float32Array;
  private readonly inProj: Float32Array;
  private readonly tmp: Float32Array;

  constructor(readonly file: NetworksFile) {
    this.X = file.xDims;
    this.Z = file.zDims;
    this.Y = file.yDims;
    this.dec = new Mlp(file.decompressor);
    this.step_ = new Mlp(file.stepper.layers);
    this.proj = new Mlp(file.projector.layers);
    this.inDec = new Float32Array(this.X + this.Z);
    this.inStep = new Float32Array(this.X + this.Z);
    this.inProj = new Float32Array(this.X);
    this.tmp = new Float32Array(Math.max(this.Y, this.X + this.Z));
  }

  /** Total weights and the bytes they take at half precision. */
  get size(): { params: number; bytes: number } {
    const params = this.dec.params + this.step_.params + this.proj.params;
    return { params, bytes: params * 2 };
  }

  /** (X, Z) → Y. */
  decompress(xz: Float32Array, y: Float32Array): Float32Array {
    const { mean, std } = this.file.x;
    for (let i = 0; i < this.X; i++) this.inDec[i] = (xz[i] - mean[i]) / std[i];
    for (let i = 0; i < this.Z; i++) this.inDec[this.X + i] = xz[this.X + i];
    this.dec.run(this.inDec, y);
    const ym = this.file.y.mean;
    const ys = this.file.y.std;
    for (let i = 0; i < this.Y; i++) y[i] = y[i] * ys[i] + ym[i];
    return y;
  }

  /** (X, Z)ₜ → (X, Z)ₜ₊₁, in place. */
  step(xz: Float32Array): Float32Array {
    const s = this.file.stepper;
    const n = this.X + this.Z;
    for (let i = 0; i < n; i++) this.inStep[i] = (xz[i] - s.inMean[i]) / s.inStd[i];
    const d = this.step_.run(this.inStep, this.tmp);
    for (let i = 0; i < n; i++) xz[i] += d[i] * s.outStd[i] + s.outMean[i];
    return xz;
  }

  /** Normalised query features → the (X, Z) of the database frame the search would have found. */
  project(query: Float32Array, xz: Float32Array): Float32Array {
    const { mean, std } = this.file.x;
    for (let i = 0; i < this.X; i++) this.inProj[i] = (query[i] - mean[i]) / std[i];
    this.proj.run(this.inProj, xz);
    const p = this.file.projector;
    for (let i = 0; i < this.X + this.Z; i++) xz[i] = xz[i] * p.outStd[i] + p.outMean[i];
    return xz;
  }
}
