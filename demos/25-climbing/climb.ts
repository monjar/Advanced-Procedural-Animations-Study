import { Rng } from '../../src/math/random';

/**
 * Climbing as search over stances. A stance is which hold each limb is on — (left hand, right hand, left foot,
 * right foot) — and a move changes one limb, so the other three always hold the climber. A* finds the shortest
 * sequence of moves from the start holds until both hands are on the top hold.
 *
 * A stance is possible only if there is somewhere to put the body: a torso position (in the wall's plane) from
 * which every limb reaches its hold. That small problem — four reach constraints, two unknowns — is solved by
 * projected Gauss–Seidel. Rules of good climbing technique enter as constraints and costs: hands above feet,
 * hands not crossed far, short reaches preferred, and a body kept centred over its feet.
 *
 * Coordinates are on the wall: u across (m), v up (m).
 */

export interface Hold {
  u: number;
  v: number;
  /** Size (m) for drawing; bigger holds are jugs. */
  size: number;
}

export const LIMBS = ['left hand', 'right hand', 'left foot', 'right foot'] as const;
export type Stance = [number, number, number, number];

/** Limb roots relative to the torso centre, and limb reach (m). */
export const BODY = {
  shoulder: [
    [-0.19, 0.24],
    [0.19, 0.24],
  ],
  hip: [
    [-0.1, -0.22],
    [0.1, -0.22],
  ],
  arm: 0.62,
  leg: 0.86,
};

export function root(limb: number, torso: [number, number]): [number, number] {
  const r = limb < 2 ? BODY.shoulder[limb] : BODY.hip[limb - 2];
  return [torso[0] + r[0], torso[1] + r[1]];
}

export const reach = (limb: number) => (limb < 2 ? BODY.arm : BODY.leg);

/**
 * Where the torso goes for a set of contacts (−1 = limb free): close to the centre of the contacts, a little
 * above the feet, but never so far that a limb cannot reach. Returns the position and the worst overreach (m).
 */
export function placeTorso(holds: Hold[], stance: ArrayLike<number>, start?: [number, number]): { torso: [number, number]; overreach: number } {
  const used = [0, 1, 2, 3].filter((l) => stance[l] >= 0);
  const feet = used.filter((l) => l >= 2);
  const hands = used.filter((l) => l < 2);
  const mean = (ls: number[], k: 'u' | 'v') => ls.reduce((s, l) => s + holds[stance[l]][k], 0) / Math.max(1, ls.length);
  // Preferred: between hands and feet, horizontally over the feet (where the weight belongs on a vertical wall).
  const pu = feet.length ? 0.7 * mean(feet, 'u') + 0.3 * mean(hands, 'u') : mean(used, 'u');
  const pv = hands.length && feet.length ? 0.55 * mean(feet, 'v') + 0.45 * mean(hands, 'v') + 0.1 : mean(used, 'v');
  let t: [number, number] = start ? [start[0], start[1]] : [pu, pv];
  for (let it = 0; it < (start ? 25 : 60); it++) {
    // Pull toward the preferred spot, then project out every overreach.
    t[0] += 0.15 * (pu - t[0]);
    t[1] += 0.15 * (pv - t[1]);
    for (const l of used) {
      const h = holds[stance[l]];
      const [ru, rv] = root(l, t);
      const du = h.u - ru;
      const dv = h.v - rv;
      const d = Math.hypot(du, dv);
      const r = reach(l) * 0.97;
      if (d > r) {
        t = [t[0] + (du * (d - r)) / d, t[1] + (dv * (d - r)) / d];
      }
    }
  }
  let over = 0;
  for (const l of used) {
    const h = holds[stance[l]];
    const [ru, rv] = root(l, t);
    over = Math.max(over, Math.hypot(h.u - ru, h.v - rv) - reach(l));
  }
  return { torso: t, overreach: over };
}

/** Technique constraints on a stance (beyond reach). */
function sensible(holds: Hold[], s: Stance): boolean {
  const [lh, rh, lf, rf] = s.map((i) => holds[i]);
  if (lh.u > rh.u + 0.15) return false; // hands crossed far
  if (lf.u > rf.u + 0.1) return false; // feet crossed
  if (Math.min(lh.v, rh.v) < Math.max(lf.v, rf.v) + 0.35) return false; // hands well above feet
  if (s[2] === s[3] && s[0] === s[1]) return false;
  return true;
}

export interface Plan {
  stances: Stance[];
  torsos: [number, number][];
  expanded: number;
  ms: number;
}

/**
 * Weighted A* over stances (f = g + w·h, w = 3: not always the fewest moves, but orders of magnitude fewer
 * stances expanded). Cost: one per move plus a penalty for stretched stances and for going down; heuristic: the
 * height still to gain over the most a hand can gain in one move.
 */
export function planRoute(holds: Hold[], start: Stance, top: number, maxExpand = 20000, weight = 3, stats?: { highest: number; best?: Stance }): Plan | null {
  const t0 = performance.now();
  const key = (s: Stance) => s.join(',');
  const goal = (s: Stance) => s[0] === top && s[1] === top;
  const gain = BODY.arm * 1.3;
  const h = (s: Stance) => Math.max(0, holds[top].v - Math.max(holds[s[0]].v, holds[s[1]].v)) / gain + (s[0] === top ? 0 : 0.5) + (s[1] === top ? 0 : 0.5);
  const heap = new MinHeap<{ s: Stance; g: number; torso: [number, number] }>();
  const startFit = placeTorso(holds, start).torso;
  heap.push(weight * h(start), { s: start, g: 0, torso: startFit });
  const came = new Map<string, string>();
  const gScore = new Map<string, number>([[key(start), 0]]);
  const byKey = new Map<string, Stance>([[key(start), start]]);
  let expanded = 0;
  while (heap.size && expanded < maxExpand) {
    const { s, g, torso } = heap.pop()!;
    const k = key(s);
    if (g > (gScore.get(k) ?? Infinity)) continue;
    expanded++;
    if (stats) {
      const hv = Math.min(holds[s[0]].v, holds[s[1]].v);
      if (hv > stats.highest) {
        stats.highest = hv;
        stats.best = s;
      }
    }
    if (goal(s)) {
      const stances: Stance[] = [s];
      let cur = k;
      while (came.has(cur)) {
        cur = came.get(cur)!;
        stances.unshift(byKey.get(cur)!);
      }
      const torsos: [number, number][] = [];
      let prev: [number, number] | undefined;
      for (const st of stances) {
        prev = placeTorso(holds, st, prev).torso;
        torsos.push(prev);
      }
      return { stances, torsos, expanded, ms: performance.now() - t0 };
    }
    for (let limb = 0; limb < 4; limb++) {
      // The other three must hold the body while this limb moves: where does the body go?
      const during = s.slice();
      during[limb] = -1;
      const hang = placeTorso(holds, during, torso);
      if (hang.overreach > 0.01) continue;
      const [ru, rv] = root(limb, hang.torso);
      for (let j = 0; j < holds.length; j++) {
        if (j === s[limb]) continue;
        const to = holds[j];
        // Within reach of the limb from where the body hangs (with some give: the body shifts as it lands).
        if (Math.hypot(to.u - ru, to.v - rv) > reach(limb) + 0.25) continue;
        if (limb < 2 && j === s[1 - limb] && j !== top) continue;
        if (limb >= 2 && j === s[5 - limb]) continue;
        if (limb >= 2 && j === top) continue;
        const n = s.slice() as Stance;
        n[limb] = j;
        if (!sensible(holds, n)) continue;
        const nk = key(n);
        const known = gScore.get(nk) ?? Infinity;
        if (g + 1 >= known) continue;
        const fit = placeTorso(holds, n, hang.torso);
        if (fit.overreach > 0.01) continue;
        let stretch = 0;
        for (let l = 0; l < 4; l++) {
          const [qu, qv] = root(l, fit.torso);
          stretch += Math.hypot(holds[n[l]].u - qu, holds[n[l]].v - qv) / reach(l);
        }
        const down = Math.max(0, holds[s[limb]].v - to.v);
        const cost = g + 1 + 0.15 * stretch + 2 * down;
        if (cost < known) {
          gScore.set(nk, cost);
          came.set(nk, k);
          byKey.set(nk, n);
          heap.push(cost + weight * h(n), { s: n, g: cost, torso: fit.torso });
        }
      }
    }
  }
  return null;
}

class MinHeap<T> {
  private readonly keys: number[] = [];
  private readonly vals: T[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(k: number, v: T): void {
    this.keys.push(k);
    this.vals.push(v);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      [this.keys[p], this.keys[i]] = [this.keys[i], this.keys[p]];
      [this.vals[p], this.vals[i]] = [this.vals[i], this.vals[p]];
      i = p;
    }
  }
  pop(): T | undefined {
    if (!this.keys.length) return undefined;
    const top = this.vals[0];
    const lk = this.keys.pop()!;
    const lv = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = lk;
      this.vals[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        [this.keys[m], this.keys[i]] = [this.keys[i], this.keys[m]];
        [this.vals[m], this.vals[i]] = [this.vals[i], this.vals[m]];
        i = m;
      }
    }
    return top;
  }
}

/** A random wall: Poisson-disc holds, two footholds and two handholds to start on, and a top hold. */
export function makeWall(seed: number, width: number, height: number, spacing: number): { holds: Hold[]; start: Stance; top: number } {
  const rng = new Rng(seed);
  const holds: Hold[] = [];
  const add = (u: number, v: number, size: number) => holds.push({ u, v, size });
  add(-0.2, 0.3, 0.06);
  add(0.2, 0.32, 0.06);
  add(-0.25, 1.45, 0.06);
  add(0.25, 1.5, 0.06);
  add(rng.range(-0.3, 0.3), height - 0.25, 0.09);
  for (let tries = 0; tries < 4000; tries++) {
    const u = rng.range(-width / 2, width / 2);
    const v = rng.range(0.15, height - 0.3);
    if (holds.every((h) => Math.hypot(h.u - u, h.v - v) > spacing)) add(u, v, rng.range(0.03, 0.07));
  }
  return { holds, start: [2, 3, 0, 1], top: 4 };
}
