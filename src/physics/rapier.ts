import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

let ready: Promise<typeof RAPIER> | undefined;

/** Load the Rapier WASM once (it is embedded in the JS bundle, so this works in pages, workers and Node). */
export function initRapier(): Promise<typeof RAPIER> {
  return (ready ??= RAPIER.init().then(() => RAPIER));
}

/**
 * Rapier 0.21.0 reports spherical impulse joints as generic (raw type 6 vs the JS enum's 5), so
 * `createImpulseJoint` wraps them in `GenericImpulseJoint`, which has no motor methods. The spherical
 * class's motor methods only forward the handle and axis to the WASM, so re-typing the wrapper restores them.
 */
export function asSpherical(joint: RAPIER.ImpulseJoint): RAPIER.SphericalImpulseJoint {
  if (!(joint instanceof RAPIER.SphericalImpulseJoint)) Object.setPrototypeOf(joint, RAPIER.SphericalImpulseJoint.prototype);
  return joint as RAPIER.SphericalImpulseJoint;
}

export const ANGULAR_AXES = [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ] as const;

/**
 * Drive a spherical joint to a relative rotation q (child frame in parent frame, xyzw). Rapier's angular
 * motor on axis i drives the joint's ang_err component i towards sin(target/2), so with all three axes
 * motorised and target_i = 2·asin(q_i) (q taken with w ≥ 0) the joint tracks the whole quaternion. The motor
 * is implicit (a stable PD), unlike torques applied from JS.
 */
export function driveSpherical(joint: RAPIER.SphericalImpulseJoint, q: ArrayLike<number>, stiffness: number, damping: number): void {
  const s = q[3] < 0 ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    const c = Math.max(-1, Math.min(1, s * q[i]));
    joint.configureMotorPosition(ANGULAR_AXES[i], 2 * Math.asin(c), stiffness, damping);
  }
}

/**
 * Fixed-timestep driver for physics under the display-synced app loop: accumulates frame time, steps at a
 * constant `dt` (stable gains, deterministic results) and reports how far the render is between the last two
 * states so poses can be interpolated.
 */
export class FixedStepper {
  private acc = 0;
  steps = 0;

  constructor(
    public dt: number,
    private readonly step: (dt: number) => void,
    public maxSteps = 16,
  ) {}

  /** Advance by `frameDt`; returns the interpolation fraction in [0, 1). */
  advance(frameDt: number): number {
    this.acc += frameDt;
    let n = 0;
    while (this.acc >= this.dt && n < this.maxSteps) {
      this.step(this.dt);
      this.acc -= this.dt;
      this.steps++;
      n++;
    }
    if (n === this.maxSteps) this.acc = 0;
    return this.acc / this.dt;
  }
}
