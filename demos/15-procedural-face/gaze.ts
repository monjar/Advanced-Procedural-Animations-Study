/**
 * Procedural gaze: saccades, fixational eye movements, eye–head coordination and blinks.
 *
 * Angles are degrees in the body frame (yaw left +, pitch up +); the partner (the camera) is at (0, 0).
 * Gaze — where the eyes point in the world — moves only by saccades, smooth pursuit and fixational jitter.
 * The head follows large gaze shifts more slowly, and the eye-in-head angle is gaze − head: while the head
 * catches up the eyes counter-rotate and the fixation holds (the vestibulo-ocular reflex), with no extra code.
 *
 * Numbers used:
 *   - main sequence: saccade duration D ≈ 21 ms + 2.2 ms/° (Carpenter, Movements of the Eyes, 1988)
 *   - ~86 % of natural saccades are 15° or less (Bahill, Adler & Stark, 1975) → exponential sizes, mean 7.6°
 *   - spontaneous blinks ≈ 17/min at rest, ≈ 26/min in conversation (Bentivoglio et al., 1997)
 *   - listeners look at the speaker much more than speakers look at listeners (Argyle & Cook, 1976)
 *   - microsaccades under 1°, one or two a second, between which the eye drifts (Martinez-Conde et al., 2004)
 *   - the head joins gaze shifts beyond ~15–20° (Freedman & Sparks, 1997)
 * The interval distributions are tuned to give those proportions, not fitted to eye-tracking data.
 */

import { Rng } from '../../src/math/random';

export type GazeMode = 'listening' | 'talking' | 'idle' | 'track';

export interface Angles {
  yaw: number;
  pitch: number;
}

export interface SaccadeEvent {
  t: number;
  amplitude: number;
  duration: number;
  kind: 'saccade' | 'micro' | 'catch-up';
}

export const EYE_RANGE = { yaw: 40, pitch: 28 };
const HEAD_THRESHOLD = 12;
const MEAN_SACCADE = 7.6; // degrees: P(A ≤ 15°) = 1 − e^(−15/7.6) ≈ 0.86

/** Saccade duration from its amplitude (s). */
export function saccadeDuration(amplitude: number): number {
  return 0.021 + 0.0022 * amplitude;
}

/** Minimum-jerk position profile: 0 → 1 with zero velocity and acceleration at both ends. */
function minJerk(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

function logNormal(rng: Rng, median: number, sigma: number): number {
  return median * Math.exp(sigma * rng.normal());
}

export class GazeModel {
  mode: GazeMode = 'listening';
  /** External fixation target (track mode), in degrees. */
  readonly target: Angles = { yaw: 0, pitch: 0 };
  /** Where the conversation partner is (the camera), in degrees; conversation gaze is relative to it. */
  readonly partner: Angles = { yaw: 0, pitch: 0 };
  /** Blink rate multiplier and saccade-interval multiplier (UI). */
  blinkRate = 1;
  saccadeRate = 1;

  readonly gaze: Angles = { yaw: 0, pitch: 0 };
  readonly head: Angles = { yaw: 0, pitch: 0 };
  readonly eye: Angles = { yaw: 0, pitch: 0 };
  /** 0 open … 1 closed. */
  blink = 0;
  /** True while looking at the partner (conversation modes). */
  mutual = true;
  time = 0;
  readonly events: SaccadeEvent[] = [];
  readonly blinks: number[] = [];

  private readonly rng: Rng;
  private readonly from: Angles = { yaw: 0, pitch: 0 };
  private readonly to: Angles = { yaw: 0, pitch: 0 };
  private readonly fixation: Angles = { yaw: 0, pitch: 0 };
  private readonly headGoal: Angles = { yaw: 0, pitch: 0 };
  private readonly headVel: Angles = { yaw: 0, pitch: 0 };
  private readonly drift: Angles = { yaw: 0, pitch: 0 };
  private saccadeT = -1;
  private saccadeDur = 0;
  private nextShift = 0;
  private nextScan = 0;
  private nextMicro = 0;
  private nextBlink = 0;
  private blinkT = -1;
  private stateEnd = 0;
  private idleCentre: Angles = { yaw: 0, pitch: 0 };

  constructor(seed = 1) {
    this.rng = new Rng(seed);
    this.nextBlink = this.blinkInterval();
    this.nextMicro = this.rng.range(0.2, 0.8);
  }

  /**
   * Blink interval (s): exponential with a 0.6 s refractory period. Gaze-evoked blinks come on top, so the
   * spontaneous rate is set ~13 % below the target for the total to match it.
   */
  private blinkInterval(): number {
    const perMinute = (this.mode === 'talking' ? 26 : 17) * 0.87 * this.blinkRate;
    const mean = 60 / Math.max(1, perMinute);
    const refractory = 0.6;
    return refractory + -Math.log(1 - this.rng.next()) * Math.max(0.05, mean - refractory);
  }

  private startBlink(): void {
    if (this.blinkT >= 0) return;
    this.blinkT = 0;
    this.blinks.push(this.time);
    if (this.blinks.length > 400) this.blinks.shift();
    this.nextBlink = this.time + this.blinkInterval();
  }

  /** Begin a saccade to `goal`; large shifts also move the head and often trigger a blink. */
  private saccadeTo(goal: Angles, kind: SaccadeEvent['kind']): void {
    const dy = goal.yaw - this.gaze.yaw;
    const dp = goal.pitch - this.gaze.pitch;
    const amp = Math.hypot(dy, dp);
    if (amp < 0.05) return;
    this.from.yaw = this.gaze.yaw;
    this.from.pitch = this.gaze.pitch;
    this.to.yaw = goal.yaw;
    this.to.pitch = goal.pitch;
    this.saccadeT = 0;
    this.saccadeDur = saccadeDuration(amp);
    this.events.push({ t: this.time, amplitude: amp, duration: this.saccadeDur, kind });
    if (this.events.length > 4000) this.events.shift();
    if (kind !== 'micro') {
      // The head takes over most of what lies beyond the eyes' comfortable range.
      const headShare = (a: number, h: number) => {
        const rel = a - h;
        return Math.abs(rel) > HEAD_THRESHOLD ? h + (rel - Math.sign(rel) * HEAD_THRESHOLD * 0.6) * 0.75 : h;
      };
      this.headGoal.yaw = headShare(goal.yaw, this.headGoal.yaw);
      this.headGoal.pitch = headShare(goal.pitch, this.headGoal.pitch) * 0.8;
      // Gaze-evoked blinks: rare for small shifts, likely for large ones.
      if (this.rng.chance(Math.min(0.85, Math.max(0, (amp - 12) / 35)))) this.startBlink();
    }
  }

  private conversationTarget(mutual: boolean): Angles {
    if (mutual) {
      // Scan the partner's face: eyes and mouth (a few degrees apart at conversational distance).
      const spot = this.rng.pick([
        { yaw: -1.6, pitch: 0.8 },
        { yaw: 1.6, pitch: 0.8 },
        { yaw: 0, pitch: -2.4 },
      ]);
      return { yaw: this.partner.yaw + spot.yaw + this.rng.normal() * 0.3, pitch: this.partner.pitch + spot.pitch + this.rng.normal() * 0.3 };
    }
    // Gaze aversion: mostly sideways, often down while thinking.
    const amp = Math.min(30, 5 + -Math.log(1 - this.rng.next()) * MEAN_SACCADE);
    const dir = this.rng.chance(0.75) ? (this.rng.chance(0.5) ? 0 : Math.PI) + this.rng.normal() * 0.35 : -Math.PI / 2 + this.rng.normal() * 0.6;
    return { yaw: this.partner.yaw + Math.cos(dir) * amp, pitch: this.partner.pitch + Math.sin(dir) * amp * 0.7 };
  }

  private plan(): void {
    const rate = Math.max(0.1, this.saccadeRate);
    if (this.mode === 'talking' || this.mode === 'listening') {
      if (this.time >= this.stateEnd) {
        // Alternate mutual gaze and aversion; listeners hold mutual gaze longer, speakers look away longer.
        const talking = this.mode === 'talking';
        this.mutual = !this.mutual;
        const median = this.mutual ? (talking ? 1.4 : 2.6) : talking ? 1.6 : 0.9;
        this.stateEnd = this.time + logNormal(this.rng, median, 0.5) / rate;
        const goal = this.conversationTarget(this.mutual);
        this.fixation.yaw = goal.yaw;
        this.fixation.pitch = goal.pitch;
        this.saccadeTo(goal, 'saccade');
        this.nextScan = this.time + logNormal(this.rng, 0.55, 0.4) / rate;
      } else if (this.time >= this.nextScan) {
        const goal = this.mutual ? this.conversationTarget(true) : { yaw: this.fixation.yaw + this.rng.normal() * 2.5, pitch: this.fixation.pitch + this.rng.normal() * 1.5 };
        this.saccadeTo(goal, 'saccade');
        this.nextScan = this.time + logNormal(this.rng, 0.55, 0.4) / rate;
      }
      return;
    }
    if (this.mode === 'idle') {
      if (this.time >= this.nextShift) {
        // Free viewing: exponential saccade sizes around a slowly wandering centre of interest.
        this.idleCentre.yaw = Math.max(-35, Math.min(35, this.idleCentre.yaw * 0.7 + this.rng.normal() * 8));
        this.idleCentre.pitch = Math.max(-15, Math.min(15, this.idleCentre.pitch * 0.7 + this.rng.normal() * 4));
        const amp = -Math.log(1 - this.rng.next()) * MEAN_SACCADE;
        const toCentre = Math.atan2(this.idleCentre.pitch - this.gaze.pitch, this.idleCentre.yaw - this.gaze.yaw);
        const dir = this.rng.chance(0.6) ? toCentre + this.rng.normal() * 0.6 : this.rng.range(-Math.PI, Math.PI);
        this.saccadeTo(
          {
            yaw: Math.max(-60, Math.min(60, this.gaze.yaw + Math.cos(dir) * amp)),
            pitch: Math.max(-30, Math.min(30, this.gaze.pitch + Math.sin(dir) * amp * 0.75)),
          },
          'saccade',
        );
        this.nextShift = this.time + logNormal(this.rng, 0.45, 0.45) / rate;
      }
      return;
    }
    // Track: pursuit handles slow targets; a catch-up saccade fires when the error grows past 1.5°.
    const err = Math.hypot(this.target.yaw - this.gaze.yaw, this.target.pitch - this.gaze.pitch);
    if (err > 1.5 && this.saccadeT < 0) this.saccadeTo(this.target, 'catch-up');
  }

  update(dt: number): void {
    this.time += dt;
    if (this.saccadeT < 0) this.plan();

    // --- Gaze.
    if (this.saccadeT >= 0) {
      this.saccadeT += dt;
      const s = minJerk(this.saccadeT / this.saccadeDur);
      this.gaze.yaw = this.from.yaw + (this.to.yaw - this.from.yaw) * s;
      this.gaze.pitch = this.from.pitch + (this.to.pitch - this.from.pitch) * s;
      if (this.saccadeT >= this.saccadeDur) this.saccadeT = -1;
    } else {
      if (this.mode === 'track') {
        // Smooth pursuit: velocity gain below 1, so the eye lags and catch-up saccades fix the rest.
        const k = 1 - Math.exp(-dt * 6);
        this.gaze.yaw += (this.target.yaw - this.gaze.yaw) * k;
        this.gaze.pitch += (this.target.pitch - this.gaze.pitch) * k;
        this.headGoal.yaw = Math.abs(this.target.yaw - this.headGoal.yaw) > HEAD_THRESHOLD ? this.target.yaw * 0.6 : this.headGoal.yaw;
        this.headGoal.pitch = Math.abs(this.target.pitch - this.headGoal.pitch) > HEAD_THRESHOLD ? this.target.pitch * 0.5 : this.headGoal.pitch;
      }
      // Fixational eye movements: slow drift plus microsaccades that undo it.
      this.drift.yaw += this.rng.normal() * 0.25 * Math.sqrt(dt);
      this.drift.pitch += this.rng.normal() * 0.25 * Math.sqrt(dt);
      this.gaze.yaw += this.drift.yaw * dt;
      this.gaze.pitch += this.drift.pitch * dt;
      this.drift.yaw *= Math.exp(-dt * 2);
      this.drift.pitch *= Math.exp(-dt * 2);
      if (this.time >= this.nextMicro) {
        const amp = this.rng.range(0.1, 0.8);
        const dir = this.rng.range(-Math.PI, Math.PI);
        this.saccadeTo({ yaw: this.gaze.yaw + Math.cos(dir) * amp, pitch: this.gaze.pitch + Math.sin(dir) * amp }, 'micro');
        this.nextMicro = this.time + this.rng.range(0.4, 1.0);
      }
    }

    // --- Head: a critically damped spring toward its goal (≈ 120 ms half-life), slower than the eyes.
    for (const k of ['yaw', 'pitch'] as const) {
      const y = (4 * Math.LN2) / 0.12 / 2;
      const j0 = this.head[k] - this.headGoal[k];
      const j1 = this.headVel[k] + j0 * y;
      const e = Math.exp(-y * dt);
      this.head[k] = e * (j0 + j1 * dt) + this.headGoal[k];
      this.headVel[k] = e * (this.headVel[k] - j1 * y * dt);
    }

    // --- Eyes in the head: gaze minus head, within the oculomotor range. While the head catches up after a
    // gaze shift the eyes counter-rotate (VOR); at the range limit the head is forced to make up the rest.
    this.eye.yaw = Math.max(-EYE_RANGE.yaw, Math.min(EYE_RANGE.yaw, this.gaze.yaw - this.head.yaw));
    this.eye.pitch = Math.max(-EYE_RANGE.pitch, Math.min(EYE_RANGE.pitch, this.gaze.pitch - this.head.pitch));
    const overYaw = this.gaze.yaw - this.head.yaw - this.eye.yaw;
    const overPitch = this.gaze.pitch - this.head.pitch - this.eye.pitch;
    if (overYaw !== 0 || overPitch !== 0) {
      this.headGoal.yaw += overYaw;
      this.headGoal.pitch += overPitch;
    }

    // --- Blinks: closing ≈ 70 ms, closed ≈ 40 ms, opening ≈ 160 ms (opening is the slow part).
    if (this.time >= this.nextBlink) this.startBlink();
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const t = this.blinkT;
      if (t < 0.07) this.blink = minJerk(t / 0.07);
      else if (t < 0.11) this.blink = 1;
      else if (t < 0.27) this.blink = 1 - minJerk((t - 0.11) / 0.16);
      else {
        this.blink = 0;
        this.blinkT = -1;
      }
    }
  }

  /** True when the gaze is in the middle of a (non-micro) saccade. */
  get inSaccade(): boolean {
    return this.saccadeT >= 0;
  }
}
