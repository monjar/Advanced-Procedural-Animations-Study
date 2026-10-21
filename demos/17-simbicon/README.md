# Physics-Based Walker

Study 10's ragdoll walks because pins hold it to the animation. This one has nothing: a 71 kg biped in MuJoCo,
every joint driven by a torque the controller computes 2 000 times a second, and it stays up because of how it
places its feet. Push it and it takes a wider or longer step. Steer it and it turns. That is SIMBICON — the
*SIMple BIped CONtroller* of Yin, Loken & van de Panne (2007) — on a 3D body.

## The controller (`simbicon.ts`)

1. **State machine.** Left stance, right stance; switch after 0.3 s or when the swing foot touches down.
2. **PD control** toward per-state targets: swing knee bent, swing ankle up, stance knee almost straight.
   Stiff hips and knees (kp 300–400), deliberately soft ankles (kp 60) — stiff ankles fight the ground.
3. **Balance feedback**, the whole idea. The swing hip's target is set in the *world* frame:

       θ_swing = θ₀ + c_d · d + c_v · v

   where d is the horizontal distance from the stance ankle to the centre of mass and v the centre of mass's
   velocity. If the body is ahead of the stance foot or moving fast, the next foot lands further forward and
   catches it. The same law runs in the coronal plane, stepping wider when the body drifts sideways.
4. **Torso in the world frame.** A PD drives the torso's pitch, roll and heading to their targets. The torque
   is applied by the stance hip, which takes whatever the swing hip does not: τ_stance = τ_torso − τ_swing.
   The torso hangs between the hips, so the hips are the only way to hold it upright.

Steering turns the swing leg toward the desired heading a little each step, with the heading itself
rate-limited: a sudden 180° request is a stumble in the making. Gait changes blend over a few steps,
because an abrupt change of parameters is itself a push.

## Tuning, measured

The paper's walk parameters did not transfer to this body. Parameter sweeps (walk 20 s, measure forward and
sideways speed and turning; then shove sideways harder every 2 s) found:

- **A crab.** At low speed the gait settled into a stable *sideways* walk (0.5 m/s sideways, 0.1 m/s forward,
  turning slowly). Nothing was asymmetric in the controller: it was simply an attractor of the feedback system.
  Enough forward drive (torso lean, or weaker sagittal feedback) removes it, and so does controlling heading.
- **Lean is the speed knob.** For the same feedback, lean 0.10 / 0.15 / 0.20 rad gave 0.46 / 0.61 / 0.92 m/s.
- **Speed costs robustness.** A 1.4 m/s variant fell to the first small shove; the shipped walk is 0.9 m/s.
- **The stable region is narrow.** Many single-parameter changes fell within seconds, which matches the
  experience behind SIMBICON's successors (optimised gains, Coros et al. 2010).

| | stroll | walk |
|---|---|---|
| speed (straight, 20 s) | 0.38 m/s | 0.91 m/s |
| sideways drift | 0.00 m/s | 0.02 m/s |
| shove survived on every trial, sideways | 0.5 m/s (36 N·s) | 0.5 m/s |
| … front or back | 0.6 m/s | 0.2 m/s |
| steering course (straight, 90°, 180°, back) | no falls | no falls |
| heading wobble | < 14° | ±15–25° |

"Every trial" means both sides and three points in the gait cycle. Bigger shoves are survived at some timings,
not others. The unit tests pin all of these, and one more: with the feedback gains set to zero, the same
character falls within seconds. The balance really is the feedback.

One bug worth recording: reading MuJoCo's contact list returns a C++ vector *and* C++ element objects. Freeing
only the vector leaked one object per contact per physics step, and at 2 000 steps a second that exhausted the
WASM heap within a few dozen test runs (and would have crashed a long session on the page).

## Interaction

- **A / D** steer, or **click** the ground to walk there. **Drag** the character to pull it (a capped
  spring–damper force on the torso).
- **Push** buttons shove it from any side; strength 0.1–1.2 m/s.
- The **balance overlay** draws the centre of mass, its ground projection and its offset d from the stance
  foot. The **plot** shows d, v and the resulting swing-hip target step by step.
- If it falls, it is stood back up after 1.5 s.

## Failure modes

- It cannot stop: SIMBICON is a walking controller, and standing still is a different one.
- It cannot turn sharply: the walk turns at most 0.2 rad/s.
- Flat ground only; slopes and stairs need gait changes the controller does not make.
- It looks like a robot: there are no arms, and the gait is a limit cycle, not a human style.

## References

- K. Yin, K. Loken, M. van de Panne, *SIMBICON: Simple Biped Locomotion Control* (SIGGRAPH 2007)
- S. Coros, P. Beaudoin, M. van de Panne, *Generalized Biped Walking Control* (SIGGRAPH 2010)
- M. H. Raibert, *Legged Robots That Balance* (1986) — foot placement as balance
