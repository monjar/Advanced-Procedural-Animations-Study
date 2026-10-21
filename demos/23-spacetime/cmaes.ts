import { Rng } from '../../src/math/random';

/**
 * CMA-ES (Hansen, "The CMA Evolution Strategy: A Tutorial", 2016): sample a population from a Gaussian, move the
 * mean toward the best samples, and adapt the covariance and step size from the path the mean has taken. Used
 * here to find the basin of a good jump, which local methods cannot do from a poor start: where the lamp lands
 * depends chaotically on how it flings itself.
 */
export class CMAES {
  readonly n: number;
  readonly lambda: number;
  readonly mu: number;
  private readonly weights: number[];
  private readonly mueff: number;
  private readonly cc: number;
  private readonly cs: number;
  private readonly c1: number;
  private readonly cmu: number;
  private readonly damps: number;
  private readonly chiN: number;
  mean: Float64Array;
  sigma: number;
  private C: Float64Array;
  private B: Float64Array;
  private D: Float64Array;
  private pc: Float64Array;
  private ps: Float64Array;
  private eigenAge = 0;
  generation = 0;
  best: { x: Float64Array; f: number } = { x: new Float64Array(0), f: Infinity };
  private readonly rng: Rng;

  constructor(x0: ArrayLike<number>, sigma: number, seed = 1, lambda?: number) {
    const n = x0.length;
    this.n = n;
    this.lambda = lambda ?? 4 + Math.floor(3 * Math.log(n));
    this.mu = Math.floor(this.lambda / 2);
    const w = Array.from({ length: this.mu }, (_, i) => Math.log(this.mu + 0.5) - Math.log(i + 1));
    const sw = w.reduce((a, b) => a + b, 0);
    this.weights = w.map((x) => x / sw);
    this.mueff = 1 / this.weights.reduce((a, b) => a + b * b, 0);
    this.cc = (4 + this.mueff / n) / (n + 4 + (2 * this.mueff) / n);
    this.cs = (this.mueff + 2) / (n + this.mueff + 5);
    this.c1 = 2 / ((n + 1.3) ** 2 + this.mueff);
    this.cmu = Math.min(1 - this.c1, (2 * (this.mueff - 2 + 1 / this.mueff)) / ((n + 2) ** 2 + this.mueff));
    this.damps = 1 + 2 * Math.max(0, Math.sqrt((this.mueff - 1) / (n + 1)) - 1) + this.cs;
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this.mean = Float64Array.from(x0);
    this.sigma = sigma;
    this.C = new Float64Array(n * n);
    this.B = new Float64Array(n * n);
    this.D = new Float64Array(n).fill(1);
    for (let i = 0; i < n; i++) this.C[i * n + i] = this.B[i * n + i] = 1;
    this.pc = new Float64Array(n);
    this.ps = new Float64Array(n);
    this.rng = new Rng(seed);
  }

  /** One generation: sample, evaluate, update. Returns the generation's best value. */
  step(f: (x: Float64Array) => number): number {
    const { n, lambda, mu } = this;
    const zs: Float64Array[] = [];
    const xs: Float64Array[] = [];
    const fs: number[] = [];
    for (let k = 0; k < lambda; k++) {
      const z = Float64Array.from({ length: n }, () => this.rng.normal());
      // y = B D z
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += this.B[i * n + j] * this.D[j] * z[j];
        y[i] = s;
      }
      const x = new Float64Array(n);
      for (let i = 0; i < n; i++) x[i] = this.mean[i] + this.sigma * y[i];
      zs.push(z);
      xs.push(x);
      const v = f(x);
      fs.push(Number.isFinite(v) ? v : 1e30);
    }
    const order = fs.map((_, i) => i).sort((a, b) => fs[a] - fs[b]);
    if (fs[order[0]] < this.best.f) this.best = { x: xs[order[0]], f: fs[order[0]] };
    const old = new Float64Array(this.mean);
    this.mean.fill(0);
    for (let k = 0; k < mu; k++) for (let i = 0; i < n; i++) this.mean[i] += this.weights[k] * xs[order[k]][i];
    // Evolution paths.
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) dy[i] = (this.mean[i] - old[i]) / this.sigma;
    // C^{-1/2} dy = B D^{-1} Bᵀ dy
    const t = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += this.B[i * n + j] * dy[i];
      t[j] = s / this.D[j];
    }
    const invsq = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += this.B[i * n + j] * t[j];
      invsq[i] = s;
    }
    const csn = Math.sqrt(this.cs * (2 - this.cs) * this.mueff);
    for (let i = 0; i < n; i++) this.ps[i] = (1 - this.cs) * this.ps[i] + csn * invsq[i];
    const psNorm = Math.hypot(...this.ps);
    this.generation++;
    const hsig = psNorm / Math.sqrt(1 - (1 - this.cs) ** (2 * this.generation)) / this.chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    const ccn = Math.sqrt(this.cc * (2 - this.cc) * this.mueff);
    for (let i = 0; i < n; i++) this.pc[i] = (1 - this.cc) * this.pc[i] + hsig * ccn * dy[i];
    // Covariance.
    const c1a = this.c1 * (1 - (1 - hsig * hsig) * this.cc * (2 - this.cc));
    for (let i = 0; i < n; i++)
      for (let j = 0; j <= i; j++) {
        let rankMu = 0;
        for (let k = 0; k < mu; k++) {
          const xi = (xs[order[k]][i] - old[i]) / this.sigma;
          const xj = (xs[order[k]][j] - old[j]) / this.sigma;
          rankMu += this.weights[k] * xi * xj;
        }
        const v = (1 - c1a - this.cmu) * this.C[i * n + j] + this.c1 * this.pc[i] * this.pc[j] + this.cmu * rankMu;
        this.C[i * n + j] = this.C[j * n + i] = v;
      }
    this.sigma *= Math.exp((this.cs / this.damps) * (psNorm / this.chiN - 1));
    // Eigendecomposition every few generations (Jacobi).
    if (++this.eigenAge > Math.max(1, Math.floor(1 / (10 * n * (this.c1 + this.cmu))))) {
      this.eigenAge = 0;
      jacobiEigen(this.C, n, this.B, this.D);
      for (let i = 0; i < n; i++) this.D[i] = Math.sqrt(Math.max(1e-20, this.D[i]));
    }
    return fs[order[0]];
  }
}

/** Symmetric eigendecomposition by cyclic Jacobi rotations: A = V diag(w) Vᵀ. */
function jacobiEigen(A: Float64Array, n: number, V: Float64Array, w: Float64Array): void {
  const a = new Float64Array(A);
  V.fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p];
          const vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  for (let i = 0; i < n; i++) w[i] = a[i * n + i];
}
