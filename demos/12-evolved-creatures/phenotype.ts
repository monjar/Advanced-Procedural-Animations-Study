import RAPIER from '@dimforge/rapier3d-compat';
import type { Genome, Vec3 } from './genome.ts';

/**
 * Genome → Rapier bodies. Every part is a box created at identity orientation, attached to its parent's
 * dominant face at the attachment point, hinged about the gene's axis. Parts only collide with the ground (no
 * self-collision: overlapping boxes at spawn would otherwise "launch" the creature — a classic exploit).
 * Joint motors follow offset + amp·sin(2πft + phase), with torque capped in proportion to the part's
 * cross-section, as Sims did, so bigger muscles cost bigger limbs.
 */

export const DENSITY = 1000;
/** Max motor torque per m² of the child's cross-section (N·m/m²). */
export const TORQUE_PER_AREA = 2500;
export const STEP = 1 / 60;
const GROUND = 0x0002;
const BODY = 0x0001;

export interface BodyPlan {
  /** Half extents and spawn centre (world) per body. */
  size: Vec3;
  center: Vec3;
  parent: number;
  gene: number;
  /** +1, or −1 for a mirrored copy (x flipped). */
  side: number;
}

export interface Creature {
  world: RAPIER.World;
  bodies: RAPIER.RigidBody[];
  joints: { joint: RAPIER.RevoluteImpulseJoint; gene: number; side: number; limit: number; stiffness: number; damping: number }[];
  plan: BodyPlan[];
  mass: number;
}

/** Expand the genome into bodies (mirrored limbs duplicated) with spawn positions, root at the origin. */
export function bodyPlan(g: Genome): { plan: BodyPlan[]; anchors: { a1: Vec3; a2: Vec3; axis: Vec3 }[] } {
  const plan: BodyPlan[] = [{ size: [...g.parts[0].size], center: [0, 0, 0], parent: -1, gene: 0, side: 1 }];
  const anchors: { a1: Vec3; a2: Vec3; axis: Vec3 }[] = [{ a1: [0, 0, 0], a2: [0, 0, 0], axis: [1, 0, 0] }];
  const place = (gene: number, parentBody: number, side: number) => {
    const p = g.parts[gene];
    const parent = plan[parentBody];
    const att: Vec3 = [p.attach[0] * side, p.attach[1], p.attach[2]];
    // Snap to the dominant face of the parent box.
    let k = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(att[i]) > Math.abs(att[k])) k = i;
    const sign = att[k] >= 0 ? 1 : -1;
    const a1: Vec3 = [att[0] * parent.size[0], att[1] * parent.size[1], att[2] * parent.size[2]];
    a1[k] = sign * parent.size[k];
    const a2: Vec3 = [0, 0, 0];
    a2[k] = -sign * p.size[k];
    const center: Vec3 = [parent.center[0] + a1[0] - a2[0], parent.center[1] + a1[1] - a2[1], parent.center[2] + a1[2] - a2[2]];
    // Mirrored hinge axis: an axial vector reflected through x = 0 keeps x and flips y, z.
    const ax: Vec3 = side > 0 ? [...p.axis] : [p.axis[0], -p.axis[1], -p.axis[2]];
    // Keep the axis off the face normal so the hinge actually swings the part.
    const n: Vec3 = [0, 0, 0];
    n[k] = 1;
    const dot = ax[0] * n[0] + ax[1] * n[1] + ax[2] * n[2];
    let axis: Vec3 = [ax[0] - dot * n[0] * 0.7, ax[1] - dot * n[1] * 0.7, ax[2] - dot * n[2] * 0.7];
    const l = Math.hypot(...axis);
    axis = l > 1e-6 ? [axis[0] / l, axis[1] / l, axis[2] / l] : k === 0 ? [0, 0, 1] : [1, 0, 0];
    const index = plan.length;
    plan.push({ size: [...p.size], center, parent: parentBody, gene, side });
    anchors.push({ a1, a2, axis });
    g.parts.forEach((c, ci) => {
      if (c.parent === gene) place(ci, index, side);
    });
  };
  g.parts.forEach((p, i) => {
    if (p.parent !== 0) return;
    place(i, 0, 1);
    if (p.mirror) place(i, 0, -1);
  });
  return { plan, anchors };
}

/** Build the creature in a fresh world, resting just above the ground. */
export function buildCreature(g: Genome): Creature {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.5, 0).setFriction(1).setCollisionGroups((GROUND << 16) | BODY),
  );
  const { plan, anchors } = bodyPlan(g);
  let lowest = Infinity;
  for (const b of plan) lowest = Math.min(lowest, b.center[1] - b.size[1]);
  const lift = 0.02 - lowest;
  const bodies: RAPIER.RigidBody[] = [];
  let mass = 0;
  for (const b of plan) {
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(b.center[0], b.center[1] + lift, b.center[2]).setCanSleep(false));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(...b.size)
        .setDensity(DENSITY)
        .setFriction(1)
        .setCollisionGroups((BODY << 16) | GROUND),
      rb,
    );
    bodies.push(rb);
    mass += rb.mass();
  }
  // Subtree masses for the motor gains.
  const sub = plan.map((_, i) => bodies[i].mass());
  for (let i = plan.length - 1; i > 0; i--) sub[plan[i].parent] += sub[i];
  const joints: Creature['joints'] = [];
  for (let i = 1; i < plan.length; i++) {
    const { a1, a2, axis } = anchors[i];
    const data = RAPIER.JointData.revolute({ x: a1[0], y: a1[1], z: a1[2] }, { x: a2[0], y: a2[1], z: a2[2] }, { x: axis[0], y: axis[1], z: axis[2] });
    const gene = g.parts[plan[i].gene];
    const joint = world.createImpulseJoint(data, bodies[plan[i].parent], bodies[i], true) as RAPIER.RevoluteImpulseJoint;
    joint.setLimits(-gene.limit, gene.limit);
    joint.setContactsEnabled(false);
    joint.configureMotorModel(RAPIER.MotorModel.ForceBased);
    // Muscle strength ∝ cross-section: the box face through its two largest extents.
    const s = [...plan[i].size].sort((x, y) => y - x);
    joint.setMotorMaxForce(TORQUE_PER_AREA * 4 * s[0] * s[1]);
    const reach = Math.max(...s) * 2;
    const stiffness = 60 * sub[i] * 9.81 * reach;
    const damping = 2 * Math.sqrt(stiffness * sub[i] * reach * reach * 0.4);
    joints.push({ joint, gene: plan[i].gene, side: plan[i].side, limit: gene.limit, stiffness, damping });
  }
  return { world, bodies, joints, plan, mass };
}

/** Drive the motors for time t. Mirrored copies run half a cycle out of phase. */
export function driveMotors(c: Creature, g: Genome, t: number): void {
  for (const j of c.joints) {
    const p = g.parts[j.gene];
    const phase = p.phase + (j.side < 0 ? Math.PI : 0);
    const target = Math.max(-1, Math.min(1, p.offset + p.amp * Math.sin(2 * Math.PI * g.frequency * t + phase))) * j.limit;
    j.joint.configureMotorPosition(target, j.stiffness, j.damping);
  }
}

export function centerOfMass(c: Creature, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = out[1] = out[2] = 0;
  for (const b of c.bodies) {
    const m = b.mass();
    const p = b.translation();
    out[0] += p.x * m;
    out[1] += p.y * m;
    out[2] += p.z * m;
  }
  out[0] /= c.mass;
  out[1] /= c.mass;
  out[2] /= c.mass;
  return out;
}

export interface Evaluation {
  /** Horizontal distance (m) the centre of mass travelled after settling; 0 when disqualified. */
  fitness: number;
  distance: number;
  disqualified?: 'nan' | 'speed' | 'launch';
}

export const EVAL = { settle: 1.5, duration: 8, maxSpeed: 15, maxRise: 1 };

/** Simulate a genome and score it, with the exploit guards. Deterministic for a given genome. */
export function evaluate(g: Genome, duration = EVAL.duration, onStep?: (c: Creature, t: number) => void): Evaluation {
  const c = buildCreature(g);
  try {
    const start: Vec3 = [0, 0, 0];
    const now: Vec3 = [0, 0, 0];
    let startY = Infinity;
    const steps = Math.round((EVAL.settle + duration) / STEP);
    for (let s = 0; s < steps; s++) {
      const t = s * STEP;
      driveMotors(c, g, t);
      c.world.step();
      onStep?.(c, t + STEP);
      if (s === Math.round(EVAL.settle / STEP) - 1) {
        centerOfMass(c, start);
        startY = start[1];
      }
      if (s % 6 === 0 || s === steps - 1) {
        for (const b of c.bodies) {
          const v = b.linvel();
          const sp = Math.hypot(v.x, v.y, v.z);
          if (!Number.isFinite(sp)) return { fitness: 0, distance: 0, disqualified: 'nan' };
          if (sp > EVAL.maxSpeed) return { fitness: 0, distance: 0, disqualified: 'speed' };
        }
        centerOfMass(c, now);
        if (startY < Infinity && now[1] > startY + EVAL.maxRise) return { fitness: 0, distance: 0, disqualified: 'launch' };
      }
    }
    centerOfMass(c, now);
    const distance = Math.hypot(now[0] - start[0], now[2] - start[2]);
    return { fitness: distance, distance };
  } finally {
    c.world.free();
  }
}

/**
 * Record a run for playback: per frame, every body's position and rotation (7 floats), plus the box sizes.
 */
export function record(g: Genome, duration = EVAL.settle + EVAL.duration): { sizes: Float32Array; frames: Float32Array; bodies: number; evaluation: Evaluation } {
  const chunks: number[] = [];
  let sizes = new Float32Array(0);
  let bodies = 0;
  const evaluation = evaluate(g, duration - EVAL.settle, (c) => {
    if (!bodies) {
      bodies = c.bodies.length;
      sizes = Float32Array.from(c.plan.flatMap((p) => p.size));
    }
    for (const b of c.bodies) {
      const p = b.translation();
      const q = b.rotation();
      chunks.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w);
    }
  });
  return { sizes, frames: Float32Array.from(chunks), bodies, evaluation };
}
