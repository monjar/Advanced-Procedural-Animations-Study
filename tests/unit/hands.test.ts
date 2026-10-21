import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import loadMujoco, { type MainModule } from '@mujoco/mujoco';
import { epsilonQuality, liftQuality, oppositionOf, planGrasps, type Contact, type Grasp } from '../../demos/18-procedural-hands/grasp';
import { handLinks, JOINTS, LIMITS } from '../../demos/18-procedural-hands/hand';
import { firstThatHolds, GraspSim, liftTest, sceneXml } from '../../demos/18-procedural-hands/physics';
import { SHAPES } from '../../demos/18-procedural-hands/shapes';

let mj: MainModule;
const plans = new Map<string, Grasp[]>();
const plan = (name: string) => {
  if (!plans.has(name)) plans.set(name, planGrasps(SHAPES.find((s) => s.name.startsWith(name))!));
  return plans.get(name)!;
};
const shape = (name: string) => SHAPES.find((s) => s.name.startsWith(name))!;

beforeAll(async () => {
  mj = await loadMujoco();
});

/** Contacts on a unit sphere at the given outward normals. */
const onSphere = (...normals: [number, number, number][]): Contact[] =>
  normals.map((n, i) => {
    const v = new THREE.Vector3(...n).normalize();
    return { point: v.clone(), normal: v, digit: i };
  });

describe('grasp quality', () => {
  const O = new THREE.Vector3();

  it('three contacts 120° apart around a sphere are in force closure; all on one side are not', () => {
    const ring = onSphere([1, 0, 0], [-0.5, 0, 0.866], [-0.5, 0, -0.866]);
    expect(epsilonQuality(ring, O, 1)).toBeGreaterThan(0.05);
    const oneSide = onSphere([1, 0.2, 0], [1, -0.2, 0], [1, 0, 0.2]);
    expect(epsilonQuality(oneSide, O, 1)).toBeLessThanOrEqual(0);
  });

  it('a two-fingertip pinch is force closure only through soft-finger torsion, and barely', () => {
    const pinch = onSphere([1, 0, 0], [-1, 0, 0]);
    const eps = epsilonQuality(pinch, O, 1);
    expect(eps).toBeGreaterThan(0);
    // The weakest direction is a twist about the line between the tips: torsion 0.02 m per unit normal force.
    expect(eps).toBeLessThan(0.03);
    const ring = onSphere([1, 0, 0], [-0.5, 0, 0.866], [-0.5, 0, -0.866]);
    expect(epsilonQuality(ring, O, 1)).toBeGreaterThan(3 * eps);
  });

  it('opposition is 1 straight across and −1 when thumb and fingers push the same way', () => {
    const across: Contact[] = onSphere([1, 0, 0], [-1, 0, 0]).map((c, i) => ({ ...c, digit: i === 0 ? 0 : 4 }));
    expect(oppositionOf(across)).toBeCloseTo(1, 5);
    const same: Contact[] = onSphere([1, 0, 0], [1, 0.01, 0]).map((c, i) => ({ ...c, digit: i === 0 ? 0 : 4 }));
    expect(oppositionOf(same)).toBeLessThan(-0.99);
  });

  it('lift quality: a ring of contacts holds more weight per unit grip than a pinch', () => {
    const ring = onSphere([1, 0, 0], [-0.5, 0, 0.866], [-0.5, 0, -0.866]);
    const pinch = onSphere([1, 0, 0], [-1, 0, 0]);
    expect(liftQuality(ring, O, 1)).toBeGreaterThan(liftQuality(pinch, O, 1));
    expect(liftQuality(pinch, O, 1)).toBeGreaterThan(0.3); // two friction cones (μ 0.6) can still lift
  });
});

describe('hand model', () => {
  it('the planner’s forward kinematics matches the MuJoCo hand exactly', () => {
    const g = plan('can')[0];
    const sim = new GraspSim(mj, shape('can'), g);
    const q = sim.data.qpos as Float64Array;
    for (let j = 0; j < JOINTS; j++) q[sim.qpos0 + j] = g.pose[j];
    mj.mj_forward(sim.model, sim.data);
    const links = handLinks(g.pose, g.wrist);
    const xpos = sim.data.xpos as Float64Array;
    const bodies = ['index1', 'middle2', 'ring1', 'little2', 'thumb1', 'thumb2'];
    const linkOf = [1, 5, 7, 11, 13, 14];
    let worst = 0;
    bodies.forEach((name, i) => {
      const b = mj.mj_name2id(sim.model, mj.mjtObj.mjOBJ_BODY.value, name);
      const a = links[linkOf[i]].a; // body origin = start of its link; scene (x, y, z) is MuJoCo (x, −z, y)
      worst = Math.max(worst, Math.hypot(xpos[3 * b] - a.x, xpos[3 * b + 1] + a.z, xpos[3 * b + 2] - a.y));
    });
    sim.dispose();
    expect(worst).toBeLessThan(1e-6);
  });

  it('planned poses respect joint limits', () => {
    for (const g of plan('mug').slice(0, 20)) for (let j = 0; j < JOINTS; j++) {
      expect(g.pose[j]).toBeGreaterThanOrEqual(LIMITS[j][0] - 1e-9);
      expect(g.pose[j]).toBeLessThanOrEqual(LIMITS[j][1] + 1e-9);
    }
  });
});

describe('planner', () => {
  it('finds force-closure grasps for every object, power and pinch', () => {
    for (const s of SHAPES) {
      const g = plan(s.name.split(' ')[0]);
      expect(g.filter((x) => x.epsilon > 0).length, s.name).toBeGreaterThanOrEqual(3);
    }
    expect(plan('apple').some((g) => g.kind === 'pinch' && g.epsilon > 0)).toBe(true);
  });

  it('is deterministic', () => {
    const a = planGrasps(shape('apple'));
    expect(a[0].epsilon).toBe(plan('apple')[0].epsilon);
    expect(a.length).toBe(plan('apple').length);
  });
});

describe('physical lift (MuJoCo)', () => {
  it('the top five ranked grasps mostly hold; grasps without force closure rarely do', () => {
    const min: Record<string, number> = { ball: 4, apple: 4, block: 3, can: 4, mug: 3 };
    // Evenly spaced samples across each list, not its head: near-closure grasps sort first among the rest.
    const spread = (g: Grasp[], n: number) => (g.length <= n ? g : Array.from({ length: n }, (_, i) => g[Math.floor((i * g.length) / n)]));
    const rate = { closure: [0, 0], open: [0, 0] };
    for (const [name, need] of Object.entries(min)) {
      const g = plan(name);
      const held = g.slice(0, 5).filter((x) => liftTest(mj, shape(name), x).held).length;
      expect(held, name).toBeGreaterThanOrEqual(need);
      for (const [k, list] of [['closure', g.filter((x) => x.epsilon > 0)], ['open', g.filter((x) => x.epsilon <= 0)]] as const) {
        const sample = spread(list, 10);
        rate[k][0] += sample.filter((x) => liftTest(mj, shape(name), x).held).length;
        rate[k][1] += sample.length;
      }
    }
    expect(rate.closure[0] / rate.closure[1]).toBeGreaterThan(0.4);
    expect(rate.open[0] / rate.open[1]).toBeLessThan(0.1);
  }, 30000);

  it('verifying in rank order: an early grasp holds for every object; the lying marker needs a pinch further down', () => {
    for (const name of ['ball', 'apple', 'block', 'can', 'mug']) expect(firstThatHolds(mj, shape(name), plan(name), 3).index, name).toBeGreaterThanOrEqual(0);
    // A 2.2 cm marker flat on the table: the best-scored grasps hold it end to end with contacts above its
    // equator and drop it; a fingertip pinch further down the list lifts it.
    const marker = firstThatHolds(mj, shape('marker'), plan('marker'), 12);
    expect(marker.index).toBeGreaterThan(0);
    expect(plan('marker')[marker.index].kind).toBe('pinch');
  }, 30000);

  it('the hand must be welded to its target: parented to a mocap body it cannot lift anything', () => {
    // A mocap body is teleported each step: it has no velocity, so its contacts produce no friction drag and
    // the object stays on the table while the hand rises past it.
    const g = plan('can')[0];
    const welded = sceneXml(shape('can'));
    const mocap = welded
      .replace('<body name="target" mocap="true"/>', '')
      .replace(/<body name="hand">\s*<freejoint name="hand"\/>\s*<inertial[^>]*\/>/, '<body name="target" mocap="true">')
      .replace(/<equality>[\s\S]*?<\/equality>/, '');
    expect(mocap).not.toContain('<weld');
    expect(liftTest(mj, shape('can'), g, welded).held).toBe(true);
    const r = liftTest(mj, shape('can'), g, mocap);
    expect(r.held).toBe(false);
    expect(r.rise).toBeLessThan(0.05);
  });
});
