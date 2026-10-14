import * as THREE from 'three';
import { createTwoBoneResult, solveTwoBone, type TwoBoneResult } from '../../src/ik/twoBone';
import type { Hit, StaticRaycaster } from '../../src/world/raycast';

export type Gait = 'tripod' | 'ripple' | 'wave';

export interface SpiderSettings {
  speed: number;
  turnRate: number;
  bodyHeight: number;
  stepHeight: number;
  /** Distance between planted foot and its target that triggers a step. */
  stepThreshold: number;
  gait: Gait;
  /** How far ahead (in step durations) foot targets are predicted from body velocity. */
  overshoot: number;
}

export const DEFAULT_SETTINGS: SpiderSettings = {
  speed: 1.6,
  turnRate: 2.2,
  bodyHeight: 0.36,
  stepHeight: 0.22,
  stepThreshold: 0.26,
  gait: 'tripod',
  overshoot: 0.7,
};

// Legs ordered around the body: L0 L1 L2 R2 R1 R0 (0 = front).
const LEG_ORDER = [
  { side: 1, row: 0 },
  { side: 1, row: 1 },
  { side: 1, row: 2 },
  { side: -1, row: 2 },
  { side: -1, row: 1 },
  { side: -1, row: 0 },
];

const GAITS: Record<Gait, number[][]> = {
  // Indices into LEG_ORDER.
  tripod: [
    [0, 4, 2],
    [5, 1, 3],
  ],
  ripple: [
    [0, 4],
    [2, 5],
    [1, 3],
  ],
  wave: [[2], [1], [0], [3], [4], [5]],
};

export const COXA = 0.1;
/** Radius of the rendered foot tip; footholds sit this far off the surface along its normal. */
export const FOOT_RADIUS = 0.022;

/** Points on an ellipsoid (body frame): the bottom, a ring below the equator and the equator. */
function ellipsoidSamples(c: THREE.Vector3Tuple, r: THREE.Vector3Tuple): THREE.Vector3[] {
  const pts = [new THREE.Vector3(c[0], c[1] - r[1], c[2])];
  for (const lat of [-0.75, 0]) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push(new THREE.Vector3(c[0] + Math.cos(lat) * Math.cos(a) * r[0], c[1] + Math.sin(lat) * r[1], c[2] + Math.cos(lat) * Math.sin(a) * r[2]));
    }
  }
  return pts;
}

/**
 * Body-frame sample points on the thorax, abdomen and head (matching the rendered ellipsoids) and the hip
 * sockets, kept out of the level geometry by the clearance pass.
 */
const BODY_SAMPLES = [
  ...ellipsoidSamples([0, 0, 0], [0.22, 0.11, 0.3]),
  ...ellipsoidSamples([0, 0.1, -0.52], [0.27, 0.22, 0.36]),
  ...ellipsoidSamples([0, 0.03, 0.3], [0.11, 0.11, 0.11]),
  new THREE.Vector3(0, 0.28, -0.6),
  ...[0.26, 0, -0.26].flatMap((z) => [new THREE.Vector3(0.27, 0.02, z), new THREE.Vector3(-0.27, 0.02, z)]),
];
export const FEMUR = 0.42;
export const TIBIA = 0.55;

export interface Leg {
  side: number;
  row: number;
  hipLocal: THREE.Vector3;
  homeLocal: THREE.Vector3;
  /** Planted foot position (world). */
  planted: THREE.Vector3;
  /** Current (possibly swinging) foot position (world). */
  foot: THREE.Vector3;
  /** Where the foot wants to be (world, from raycasts). */
  target: THREE.Vector3;
  /** Surface normal at the target / planted foothold / landing point. */
  targetNormal: THREE.Vector3;
  plantedNormal: THREE.Vector3;
  toNormal: THREE.Vector3;
  targetFound: boolean;
  stepping: boolean;
  t: number;
  duration: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  liftAxis: THREE.Vector3;
  fromNormal: THREE.Vector3;
  hip: THREE.Vector3;
  ik: TwoBoneResult;
  /** Which raycast found the target: 0 hip→home (wall), 1 down, 2 under-edge, -1 none. */
  probe: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _dn = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _vis = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();
const _hit: Hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0 };

/**
 * Surface-walking hexapod. The body moves along its tangent plane; legs find footholds by raycasting
 * (so they land on walls and wrap over edges), the gait arbitrates which legs may step, and the body
 * orientation follows the plane of the feet plus a couple of body probes.
 */
export class Spider {
  readonly position = new THREE.Vector3();
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly velocity = new THREE.Vector3();
  readonly legs: Leg[] = [];
  readonly quaternion = new THREE.Quaternion();
  settings: SpiderSettings;
  /** Debug: last body probe hits. */
  readonly probes = { ground: null as THREE.Vector3 | null, wall: null as THREE.Vector3 | null };
  private idleTime = 0;
  private readonly groundPoint = new THREE.Vector3();
  private readonly wallPoint = new THREE.Vector3();

  constructor(
    private readonly rays: StaticRaycaster,
    start: THREE.Vector3,
    settings: SpiderSettings = { ...DEFAULT_SETTINGS },
  ) {
    this.settings = settings;
    const rowZ = [0.26, 0.0, -0.26];
    const homeZ = [0.62, 0.08, -0.5];
    for (const { side, row } of LEG_ORDER) {
      const leg: Leg = {
        side,
        row,
        hipLocal: new THREE.Vector3(side * 0.17, 0.02, rowZ[row]),
        homeLocal: new THREE.Vector3(side * (row === 1 ? 0.78 : 0.68), 0, homeZ[row]),
        planted: new THREE.Vector3(),
        foot: new THREE.Vector3(),
        target: new THREE.Vector3(),
        targetNormal: new THREE.Vector3(0, 1, 0),
        plantedNormal: new THREE.Vector3(0, 1, 0),
        toNormal: new THREE.Vector3(0, 1, 0),
        targetFound: false,
        stepping: false,
        t: 0,
        duration: 0.2,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        liftAxis: new THREE.Vector3(),
        fromNormal: new THREE.Vector3(0, 1, 0),
        hip: new THREE.Vector3(),
        ik: createTwoBoneResult(),
        probe: -1,
      };
      this.legs.push(leg);
    }
    this.reset(start);
  }

  reset(start: THREE.Vector3): void {
    const hit = this.rays.cast(_v.copy(start).setY(start.y + 50), _w.set(0, -1, 0), 100, _hit);
    this.position.copy(hit ? hit.point : start);
    this.up.set(0, 1, 0);
    this.forward.set(0, 0, 1);
    this.position.addScaledVector(this.up, this.settings.bodyHeight);
    this.velocity.set(0, 0, 0);
    this.updateQuaternion();
    for (const leg of this.legs) {
      this.findTarget(leg, false);
      leg.planted.copy(leg.target);
      leg.plantedNormal.copy(leg.targetNormal);
      leg.foot.copy(leg.target);
      leg.stepping = false;
    }
  }

  /** Body-local point to world. */
  toWorld(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(local).applyQuaternion(this.quaternion).add(this.position);
  }

  /**
   * Advance by dt. `move` is −1..1 forward/back throttle, `turn` −1..1 (positive turns left),
   * `steer` optionally gives a world direction to turn toward (auto mode).
   */
  update(dt: number, move: number, turn: number, steer?: THREE.Vector3): void {
    const s = this.settings;

    // --- Steering on the tangent plane.
    if (steer) {
      _v.copy(steer).addScaledVector(this.up, -steer.dot(this.up));
      if (_v.lengthSq() > 1e-6) {
        _v.normalize();
        const angle = Math.atan2(_w.crossVectors(this.forward, _v).dot(this.up), this.forward.dot(_v));
        turn = THREE.MathUtils.clamp(angle * 2, -1, 1);
      }
    }
    _q.setFromAxisAngle(this.up, turn * s.turnRate * dt);
    this.forward.applyQuaternion(_q);

    // --- Translate along the body forward.
    _v.copy(this.forward).multiplyScalar(move * s.speed);
    this.velocity.lerp(_v, 1 - Math.exp(-dt * 6));
    this.position.addScaledVector(this.velocity, dt);
    const moving = this.velocity.length() > 0.05 || Math.abs(turn) > 0.05;
    this.idleTime = moving ? 0 : this.idleTime + dt;

    // --- Legs.
    for (const leg of this.legs) this.findTarget(leg, true);
    this.advanceSteps(dt);
    this.chooseSteps();

    // --- Body orientation and height, then keep the body out of the geometry.
    this.orientBody(dt);
    this.updateQuaternion();
    this.clearBody();

    // --- Leg IK (hip → knee → foot), knees up, out and away from the foothold's surface.
    for (const leg of this.legs) {
      this.toWorld(_v.copy(leg.hipLocal).setX(leg.hipLocal.x + leg.side * COXA), leg.hip);
      const pole = _w.copy(leg.hip).addScaledVector(this.up, 0.9);
      this.toWorld(_v.set(leg.side * 0.4, 0, 0).add(leg.hipLocal), _v);
      pole.add(_v.sub(this.position).multiplyScalar(0.6));
      pole.addScaledVector(leg.stepping ? leg.toNormal : leg.plantedNormal, 0.5);
      solveTwoBone(leg.hip, leg.foot, pole, FEMUR, TIBIA, { softness: 0.04 }, leg.ik);
    }
  }

  private findTarget(leg: Leg, predict: boolean): void {
    const home = this.toWorld(leg.homeLocal, leg.target);
    home.addScaledVector(this.up, -this.settings.bodyHeight);
    if (predict) home.addScaledVector(this.velocity, this.stepDuration() * this.settings.overshoot);
    const hip = this.toWorld(leg.hipLocal, _hip);

    // 1) hip → home: a wall between the hip and the home point (visible from the hip by construction).
    _w.subVectors(home, hip);
    const len = _w.length();
    let hit = this.rays.cast(hip, _w.divideScalar(len), len + 0.05, _hit);
    leg.probe = hit ? 0 : -1;
    // 2) straight down (body frame) through the home point.
    if (!hit) {
      hit = this.unburied(this.rays.cast(_v.copy(home).addScaledVector(this.up, 0.7), _w.copy(this.up).negate(), 1.5, _hit));
      if (hit) leg.probe = 1;
    }
    // 3) from below the home point back toward the body: wraps over convex edges.
    if (!hit) {
      const from = _v.copy(home).addScaledVector(this.up, -0.8);
      _w.copy(this.position).addScaledVector(this.up, -0.8).sub(from);
      const l = _w.length();
      hit = this.unburied(this.rays.cast(from, _w.divideScalar(l), l, _hit));
      if (hit) leg.probe = 2;
    }
    leg.targetFound = !!hit;
    if (hit) {
      // Rest the foot tip on the surface, not half inside it.
      leg.target.copy(hit.point).addScaledVector(hit.normal, FOOT_RADIUS);
      leg.targetNormal.copy(hit.normal);
    }
  }

  /**
   * Reject footholds on faces buried inside other geometry. Probes 2 and 3 start away from the body and can
   * begin inside a solid (a crate sunk into the terrain, a ramp end inside its platform); a short ray out of
   * a buried foothold along its normal meets the back of the enclosing solid's face first.
   */
  private unburied(hit: Hit | null): Hit | null {
    if (!hit) return null;
    _vis.copy(hit.point).addScaledVector(hit.normal, 0.005);
    return this.rays.insideAlong(_vis, hit.normal, 3) ? null : hit;
  }

  private stepDuration(): number {
    const speed = this.velocity.length();
    const base = THREE.MathUtils.clamp(0.3 - 0.06 * speed, 0.12, 0.3);
    return this.settings.gait === 'wave' ? base * 0.6 : base;
  }

  private advanceSteps(dt: number): void {
    for (const leg of this.legs) {
      if (!leg.stepping) {
        leg.foot.copy(leg.planted);
        continue;
      }
      // Track the moving target while in the air so fast turns do not leave feet behind.
      if (leg.targetFound) {
        const k = 1 - Math.exp(-dt * 20);
        leg.to.lerp(leg.target, k);
        leg.toNormal.lerp(leg.targetNormal, k).normalize();
      }
      leg.t = Math.min(1, leg.t + dt / leg.duration);
      const s = leg.t * leg.t * (3 - 2 * leg.t);
      // Quadratic Bézier bulging along the mean of the take-off and landing normals: across an inner
      // corner (floor → wall) or a convex edge it arcs away from the edge instead of cutting through it.
      const n = _n.addVectors(leg.fromNormal, leg.toNormal);
      if (n.lengthSq() < 1e-4) n.copy(leg.liftAxis);
      n.normalize();
      const turnAround = 1 - leg.fromNormal.dot(leg.toNormal); // 0 on a plane, 1 at a right angle
      const lift = this.settings.stepHeight * Math.min(1, leg.from.distanceTo(leg.to) / 0.25 + 0.3) + 0.12 * turnAround;
      _c.addVectors(leg.from, leg.to).multiplyScalar(0.5).addScaledVector(n, 2 * lift);
      const u = 1 - s;
      leg.foot
        .copy(leg.from)
        .multiplyScalar(u * u)
        .addScaledVector(_c, 2 * u * s)
        .addScaledVector(leg.to, s * s);
      // Never leave the swinging foot behind a surface (seen from the hip).
      _w.subVectors(leg.foot, leg.hip);
      const len = _w.length();
      if (len > 1e-4) {
        const hit = this.rays.cast(leg.hip, _w.divideScalar(len), len, _hit);
        if (hit) leg.foot.copy(hit.point).addScaledVector(hit.normal, FOOT_RADIUS);
      }
      if (leg.t >= 1) {
        // Land on the actual foothold: the smoothed landing point can cut through a corner when the
        // target switches surfaces mid-swing.
        if (leg.targetFound) {
          leg.to.copy(leg.target);
          leg.toNormal.copy(leg.targetNormal);
        }
        leg.stepping = false;
        leg.planted.copy(leg.to);
        leg.plantedNormal.copy(leg.toNormal);
        leg.foot.copy(leg.to);
      }
    }
  }

  private chooseSteps(): void {
    const groups = GAITS[this.settings.gait];
    const threshold = this.settings.stepThreshold;
    const anyStepping = this.legs.some((l) => l.stepping);
    const dist = (l: Leg) => (l.targetFound ? l.planted.distanceTo(l.target) : 0);

    // Emergency: a foot far beyond its threshold, or out of the leg's reach, steps regardless of the gait.
    for (const leg of this.legs) {
      const outOfReach = leg.hip.distanceTo(leg.planted) > (FEMUR + TIBIA) * 0.98;
      if (!leg.stepping && (dist(leg) > threshold * 2.4 || (outOfReach && leg.targetFound))) this.startStep(leg);
    }
    if (anyStepping) return;

    let best = -1;
    let bestUrgency = 0;
    groups.forEach((g, gi) => {
      const u = Math.max(...g.map((i) => dist(this.legs[i]))) / threshold;
      if (u > bestUrgency) {
        bestUrgency = u;
        best = gi;
      }
    });
    // Walking: step when over threshold. Idle: tidy up small offsets after a short pause.
    const trigger = this.idleTime > 0.25 ? 0.15 : 1;
    if (best >= 0 && bestUrgency > trigger) {
      for (const i of groups[best]) if (dist(this.legs[i]) > 0.02) this.startStep(this.legs[i]);
    }
  }

  private startStep(leg: Leg): void {
    leg.stepping = true;
    leg.t = 0;
    leg.duration = this.stepDuration();
    leg.from.copy(leg.planted);
    leg.fromNormal.copy(leg.plantedNormal);
    leg.to.copy(leg.target);
    leg.toNormal.copy(leg.targetNormal);
    leg.liftAxis.copy(this.up);
  }

  private orientBody(dt: number): void {
    // Plane through the footholds (planted feet, and landing points of swinging feet — not their arcs,
    // which would tilt the body every step): sum of cross products around the ordered foot loop.
    const hold = (leg: Leg) => (leg.stepping ? leg.to : leg.planted);
    const c = _v.set(0, 0, 0);
    for (const leg of this.legs) c.add(hold(leg));
    c.divideScalar(this.legs.length);
    const n = _w.set(0, 0, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < this.legs.length; i++) {
      a.subVectors(hold(this.legs[i]), c);
      b.subVectors(hold(this.legs[(i + 1) % this.legs.length]), c);
      n.add(a.cross(b));
    }
    if (n.dot(this.up) < 0) n.negate();
    n.normalize();
    const centroid = c.clone();

    // Body probes: straight down and straight ahead.
    const target = n.clone();
    this.probes.ground = null;
    this.probes.wall = null;
    const down = this.rays.cast(_v.copy(this.position).addScaledVector(this.up, 0.3), _dn.copy(this.up).negate(), 1.4, _hit);
    let groundDist = Infinity;
    if (down) {
      target.addScaledVector(down.normal, 0.5);
      this.probes.ground = this.groundPoint.copy(down.point);
      groundDist = down.distance - 0.3;
    }
    const ahead = this.rays.cast(this.position, _v.copy(this.forward), 0.75, _hit);
    if (ahead && ahead.normal.dot(this.up) < 0.7) {
      const w = 1 - ahead.distance / 0.75;
      target.addScaledVector(ahead.normal, 2.5 * w);
      this.probes.wall = this.wallPoint.copy(ahead.point);
    }
    target.normalize();

    // Rotate up toward the target normal, carrying forward along.
    _q.setFromUnitVectors(this.up, target);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(_q.w)));
    const t = Math.min(1, dt * 7);
    if (angle > 1e-5) {
      _q.slerp(IDENTITY, 1 - t);
      this.up.applyQuaternion(_q).normalize();
      this.forward.applyQuaternion(_q);
    }
    this.forward.addScaledVector(this.up, -this.forward.dot(this.up)).normalize();

    // Height: keep the body bodyHeight above the surface (probe), else above the foot plane.
    const s = this.settings;
    let error: number;
    if (Number.isFinite(groundDist)) error = s.bodyHeight - groundDist;
    else error = s.bodyHeight - _v.subVectors(this.position, centroid).dot(this.up);
    // Slight bob from the stepping legs.
    const lifting = this.legs.filter((l) => l.stepping).length / this.legs.length;
    error -= lifting * 0.03;
    this.position.addScaledVector(this.up, error * Math.min(1, dt * 10));
  }

  /**
   * Cast from the body centre to each body sample point; a hit before the point means that part of
   * the body is behind a surface, so push the body out along the surface normal. Two passes settle
   * corners where two surfaces push.
   */
  private clearBody(): void {
    const centre = _c;
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const local of BODY_SAMPLES) {
        centre.copy(this.position);
        const p = _v.copy(local).applyQuaternion(this.quaternion).add(this.position);
        _w.subVectors(p, centre);
        const len = _w.length();
        const hit = this.rays.cast(centre, _w.divideScalar(len), len, _hit);
        if (!hit) continue;
        const depth = _w.subVectors(hit.point, p).dot(hit.normal) + 0.015;
        if (depth > 0) {
          this.position.addScaledVector(hit.normal, depth);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  private updateQuaternion(): void {
    const x = _v.crossVectors(this.up, this.forward).normalize();
    _m.makeBasis(x, this.up, this.forward);
    this.quaternion.setFromRotationMatrix(_m);
  }
}

const IDENTITY = new THREE.Quaternion();
