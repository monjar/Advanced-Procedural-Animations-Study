import * as THREE from 'three';
import type { JointSpec } from '../../src/ik/chain';
import type { TreeNodeSpec } from '../../src/ik/fabrikTree';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;

export type ScenarioId = 'tentacle' | 'robot' | 'tree';

export interface ChainScenario {
  kind: 'chain';
  joints: (cone: number, twist: number) => JointSpec[];
  radius: [number, number];
  color: number;
}

export interface TreeScenario {
  kind: 'tree';
  nodes: TreeNodeSpec[];
  effectors: number[];
  /** Target offsets relative to the target rig. */
  targetOffsets: THREE.Vector3[];
}

export function tentacle(cone: number, twist: number): JointSpec[] {
  return Array.from({ length: 12 }, () => ({ bone: v(0, 0.14, 0), cone, twist }));
}

export function robotArm(): JointSpec[] {
  return [
    { bone: v(0, 0.35, 0), type: 'hinge', axis: v(0, 1, 0) },
    { bone: v(0, 0.7, 0), type: 'hinge', axis: v(1, 0, 0), min: -100 * DEG, max: 100 * DEG },
    { bone: v(0, 0.6, 0), type: 'hinge', axis: v(1, 0, 0), min: -150 * DEG, max: 150 * DEG },
    { bone: v(0, 0.2, 0), type: 'hinge', axis: v(1, 0, 0), min: -110 * DEG, max: 110 * DEG },
  ];
}

/** A trunk splitting into three four-segment branches. */
export function tree(): TreeScenario {
  const nodes: TreeNodeSpec[] = [{ parent: -1, position: v(0, 0, 0) }];
  for (let i = 1; i <= 4; i++) nodes.push({ parent: i - 1, position: v(0, i * 0.22, 0) });
  const subBase = 4;
  const effectors: number[] = [];
  const targetOffsets: THREE.Vector3[] = [];
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2;
    const dir = v(Math.cos(a) * 0.55, 0.85, Math.sin(a) * 0.55).normalize();
    let parent = subBase;
    for (let s = 1; s <= 4; s++) {
      nodes.push({ parent, position: nodes[subBase].position.clone().addScaledVector(dir, s * 0.18) });
      parent = nodes.length - 1;
    }
    effectors.push(parent);
    targetOffsets.push(v(Math.cos(a) * 0.4, 0.1 * b - 0.1, Math.sin(a) * 0.4));
  }
  return { kind: 'tree', nodes, effectors, targetOffsets };
}
