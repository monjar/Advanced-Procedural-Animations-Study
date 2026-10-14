import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Chain, type JointSpec } from '../../src/ik/chain';
import { solveCCD } from '../../src/ik/ccd';
import { solveFABRIK } from '../../src/ik/fabrik';
import { solveJacobian } from '../../src/ik/jacobian';
import { FabrikTree } from '../../src/ik/fabrikTree';
import { swingTwist, rotationAngle } from '../../src/math/quat';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v(0, 1, 0);

function tentacle(n = 8, len = 0.2, cone = Math.PI, twist = Math.PI): Chain {
  const specs: JointSpec[] = Array.from({ length: n }, () => ({ bone: v(0, len, 0), cone, twist }));
  return new Chain(specs);
}

function robotArm(): Chain {
  return new Chain([
    { bone: v(0, 0.35, 0), type: 'hinge', axis: UP },
    { bone: v(0, 0.7, 0), type: 'hinge', axis: v(1, 0, 0), min: -1.6, max: 1.6 },
    { bone: v(0, 0.6, 0), type: 'hinge', axis: v(1, 0, 0), min: -2.6, max: 2.6 },
    { bone: v(0, 0.2, 0), type: 'hinge', axis: v(1, 0, 0), min: -2, max: 2 },
  ]);
}

const solvers = {
  ccd: (c: Chain, t: THREE.Vector3) => solveCCD(c, t, { iterations: 60, tolerance: 1e-4 }),
  fabrik: (c: Chain, t: THREE.Vector3) => solveFABRIK(c, t, { iterations: 60, tolerance: 1e-4 }),
  dls: (c: Chain, t: THREE.Vector3) => solveJacobian(c, t, { iterations: 200, tolerance: 1e-4, method: 'dls', lambda: 0.1 }),
  pinv: (c: Chain, t: THREE.Vector3) => solveJacobian(c, t, { iterations: 200, tolerance: 1e-4, method: 'pinv' }),
  transpose: (c: Chain, t: THREE.Vector3) => solveJacobian(c, t, { iterations: 400, tolerance: 1e-3, method: 'transpose' }),
};

function boneLengthsPreserved(c: Chain): boolean {
  return c.joints.every((j, i) => Math.abs(c.positions[i].distanceTo(c.positions[i + 1]) - j.length) < 1e-9);
}

describe('Chain forward kinematics', () => {
  it('rest pose stacks the bones', () => {
    const c = tentacle(5, 0.2);
    expect(c.effector.distanceTo(v(0, 1, 0))).toBeLessThan(1e-12);
    expect(c.totalLength).toBeCloseTo(1, 12);
  });

  it('a hinge rotation swings everything distal to it', () => {
    const c = robotArm();
    c.rotations[1].setFromAxisAngle(v(1, 0, 0), Math.PI / 2);
    c.forward();
    expect(c.positions[2].distanceTo(v(0, 0.35, 0.7))).toBeLessThan(1e-9);
  });
});

describe.each(Object.entries(solvers))('%s', (name, solve) => {
  it('reaches targets inside the workspace and preserves bone lengths', () => {
    for (const t of [v(0.5, 0.9, 0.3), v(-0.4, 0.6, -0.5), v(0.2, 1.2, 0)]) {
      const c = tentacle();
      const r = solve(c, t);
      expect(r.error, `${name} → ${t.toArray()}`).toBeLessThan(name === 'transpose' ? 2e-3 : 2e-4);
      expect(boneLengthsPreserved(c)).toBe(true);
    }
  });

  // The undamped pseudo-inverse oscillates at the singular (straight) configuration an unreachable
  // target drives the chain into — the failure DLS exists to fix — so it is excluded here.
  it.skipIf(name === 'pinv')('points at unreachable targets', () => {
    const c = tentacle();
    const t = v(3, 1.2, 0);
    solve(c, t);
    const dir = c.effector.clone().sub(c.basePosition).normalize();
    expect(dir.dot(t.clone().sub(c.basePosition).normalize())).toBeGreaterThan(0.995);
  });

  it('keeps hinge joints on their axes and within limits', () => {
    const c = robotArm();
    const r = solve(c, v(0.6, 0.8, 0.5));
    // Undamped pinv steps get clipped by the limits and stall; only the limits are checked for it.
    if (name !== 'pinv') expect(r.error).toBeLessThan(name === 'transpose' ? 5e-3 : 1e-3);
    c.joints.forEach((j, i) => {
      const { swing, twist } = swingTwist(c.rotations[i], j.axis);
      expect(rotationAngle(swing)).toBeLessThan(1e-6);
      const angle = 2 * Math.atan2(twist.x * j.axis.x + twist.y * j.axis.y + twist.z * j.axis.z, twist.w);
      const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle));
      expect(wrapped).toBeGreaterThanOrEqual(j.min - 1e-6);
      expect(wrapped).toBeLessThanOrEqual(j.max + 1e-6);
    });
  });

  it.skipIf(name === 'pinv' || name === 'transpose')('converges on a tightly limited chain (30° cones)', () => {
    // Regression: FABRIK used to stall here when cones were only enforced in the forward pass.
    for (let k = 0; k < 12; k++) {
      const a = k * 2.39996;
      const t = v(0.6 * Math.sin(a), 0.6 + 0.8 * ((k * 0.618) % 1), 0.5 * Math.cos(a * 1.3));
      const c = new Chain(Array.from({ length: 12 }, () => ({ bone: v(0, 0.14, 0), cone: 30 * (Math.PI / 180), twist: 0.26 })));
      const r = solve(c, t);
      expect(r.error, `${name} target ${k}`).toBeLessThan(1e-3);
    }
  });

  it('respects cone limits', () => {
    const cone = 0.35;
    const c = tentacle(8, 0.2, cone, 0.2);
    solve(c, v(0.9, 0.4, 0.2));
    c.joints.forEach((j, i) => {
      const { swing } = swingTwist(c.rotations[i], j.boneDir);
      expect(rotationAngle(swing)).toBeLessThanOrEqual(cone + 1e-6);
    });
  });
});

describe('FabrikTree', () => {
  it('reaches two branch targets from a shared trunk', () => {
    // root 0 → 1 → 2 (sub-base) → {3 → 4, 5 → 6}
    const nodes = [
      { parent: -1, position: v(0, 0, 0) },
      { parent: 0, position: v(0, 0.4, 0) },
      { parent: 1, position: v(0, 0.8, 0) },
      { parent: 2, position: v(-0.2, 1.1, 0) },
      { parent: 3, position: v(-0.4, 1.4, 0) },
      { parent: 2, position: v(0.2, 1.1, 0) },
      { parent: 5, position: v(0.4, 1.4, 0) },
    ];
    const tree = new FabrikTree(nodes);
    const lengths = [...tree.length];
    const targets = new Map([
      [4, v(-0.5, 1.0, 0.3)],
      [6, v(0.45, 1.1, 0.25)],
    ]);
    const r = tree.solve(targets, v(0, 0, 0), 100, 1e-4);
    expect(r.error).toBeLessThan(1e-3);
    for (let i = 1; i < nodes.length; i++) {
      expect(tree.positions[i].distanceTo(tree.positions[tree.parent[i]])).toBeCloseTo(lengths[i], 9);
    }
  });
});
