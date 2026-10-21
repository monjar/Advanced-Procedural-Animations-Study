import { describe, expect, it } from 'vitest';
import { makeWall, placeTorso, planRoute, reach, root } from '../../demos/25-climbing/climb';

describe('procedural climbing', () => {
  const walls = Array.from({ length: 8 }, (_, i) => makeWall(i + 1, 2.4, 4, 0.34));

  it('finds a route to the top on every random wall', () => {
    for (const w of walls) expect(planRoute(w.holds, w.start, w.top), 'wall').not.toBeNull();
  }, 60000);

  it('every stance along a route is reachable, one limb moves at a time, and three limbs always hold', () => {
    for (const w of walls) {
      const p = planRoute(w.holds, w.start, w.top)!;
      for (let i = 0; i < p.stances.length; i++) {
        const s = p.stances[i];
        for (let l = 0; l < 4; l++) {
          const [ru, rv] = root(l, p.torsos[i]);
          const d = Math.hypot(w.holds[s[l]].u - ru, w.holds[s[l]].v - rv);
          expect(d).toBeLessThan(reach(l) + 0.011);
        }
        if (i > 0) {
          const moved = [0, 1, 2, 3].filter((l) => s[l] !== p.stances[i - 1][l]);
          expect(moved.length).toBe(1);
          // While that limb is off the wall, the other three still hold the body.
          const during = p.stances[i - 1].slice();
          during[moved[0]] = -1;
          expect(placeTorso(w.holds, during).overreach).toBeLessThan(0.011);
        }
      }
      // It ends with both hands on the top hold.
      const last = p.stances[p.stances.length - 1];
      expect(last[0]).toBe(w.top);
      expect(last[1]).toBe(w.top);
    }
  }, 60000);

  it('keeps hands above feet and never crosses the feet', () => {
    for (const w of walls) {
      const p = planRoute(w.holds, w.start, w.top)!;
      for (const s of p.stances) {
        const [lh, rh, lf, rf] = s.map((i) => w.holds[i]);
        expect(Math.min(lh.v, rh.v)).toBeGreaterThan(Math.max(lf.v, rf.v) + 0.34);
        expect(lf.u).toBeLessThanOrEqual(rf.u + 0.1);
      }
    }
  }, 60000);
});
