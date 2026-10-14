import { criticalSpringAngle, velocitySpring, type SpringState, type VelocitySpring } from '../../src/math/spring';

/** Desired motion in world space: direction (x, z) with magnitude ≤ 1, and whether to run. */
export interface ControlInput {
  x: number;
  z: number;
  run: boolean;
}

/**
 * The "simulation" a motion-matched character tries to follow (Holden, "Code vs Data Driven Displacement").
 * Input sets a desired velocity and facing; critically damped springs turn them into a smooth trajectory
 * whose future positions and facings are known in closed form — those predictions are the trajectory part
 * of every search query. There is no strafe or backwards motion: the CMU takes have none, so facing always
 * follows the direction of travel.
 */
export class TrajectoryController {
  walkSpeed = 1.3;
  runSpeed = 3.2;
  /** Spring half-lives (s): how quickly velocity and facing ease into the input. */
  velocityHalflife = 0.27;
  facingHalflife = 0.2;

  readonly x: VelocitySpring = { x: 0, v: 0, a: 0 };
  readonly z: VelocitySpring = { x: 0, v: 0, a: 0 };
  readonly yaw: SpringState = { x: 0, v: 0 };
  readonly desiredVel = { x: 0, z: 0 };
  desiredYaw = 0;

  reset(x = 0, z = 0, yaw = 0): void {
    Object.assign(this.x, { x, v: 0, a: 0 });
    Object.assign(this.z, { x: z, v: 0, a: 0 });
    Object.assign(this.yaw, { x: yaw, v: 0 });
    this.desiredVel.x = this.desiredVel.z = 0;
    this.desiredYaw = yaw;
  }

  update(input: ControlInput, dt: number): void {
    const m = Math.min(1, Math.hypot(input.x, input.z));
    const speed = m * (input.run ? this.runSpeed : this.walkSpeed);
    const dirX = m > 1e-6 ? input.x / Math.hypot(input.x, input.z) : 0;
    const dirZ = m > 1e-6 ? input.z / Math.hypot(input.x, input.z) : 0;
    this.desiredVel.x = dirX * speed;
    this.desiredVel.z = dirZ * speed;
    if (m > 0.1) this.desiredYaw = Math.atan2(dirX, dirZ);
    velocitySpring(this.x, this.desiredVel.x, this.velocityHalflife, dt);
    velocitySpring(this.z, this.desiredVel.z, this.velocityHalflife, dt);
    criticalSpringAngle(this.yaw, this.desiredYaw, this.facingHalflife, dt);
  }

  /** Predicted position (x, z) and yaw `t` seconds ahead, assuming the input stays as it is. */
  predict(t: number, out: { x: number; z: number; yaw: number }): { x: number; z: number; yaw: number } {
    const px = velocitySpring(this.x, this.desiredVel.x, this.velocityHalflife, t, { x: 0, v: 0, a: 0 });
    const pz = velocitySpring(this.z, this.desiredVel.z, this.velocityHalflife, t, { x: 0, v: 0, a: 0 });
    const y = { x: this.yaw.x, v: this.yaw.v };
    criticalSpringAngle(y, this.desiredYaw, this.facingHalflife, t);
    out.x = px.x;
    out.z = pz.x;
    out.yaw = y.x;
    return out;
  }
}
