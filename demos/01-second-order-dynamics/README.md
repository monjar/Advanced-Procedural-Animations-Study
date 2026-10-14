# Second-Order Dynamics

Procedural animation usually knows *where* something should be. Making the motion read as physical —
weight, follow-through, overshoot, anticipation — is the job of a filter between the target and the
rendered value. This study builds that filter and stress-tests it.

## The system

Each follower solves

```
y + k1·y' + k2·y'' = x + k3·x'
```

where `x` is the input (the yellow rail) and `y` the output. The constants come from three
designer-friendly parameters:

| parameter | meaning | constant |
|---|---|---|
| `f` | natural frequency (Hz): how fast it responds | `k2 = 1 / (2πf)²` |
| `ζ` | damping: `0` rings forever, `<1` overshoots, `1` critical, `>1` sluggish | `k1 = ζ / (πf)` |
| `r` | initial response: `0` eases in, `1` immediate, `>1` overshoots, `<0` anticipates | `k3 = rζ / (2πf)` |

`x'` is estimated by finite difference when the caller does not supply it. A step input therefore
produces one frame of very large `x'`, and the `k3·x'` term turns it into an instant velocity kick
proportional to `r` — that is where anticipation (`r < 0`) comes from.

## Discretisation and stability

Semi-implicit Euler:

```
y  += dt · y'
y' += dt · (x + k3·x' − y − k1·y') / k2
```

This is only stable while `dt` is small relative to the system's time constant. Set **Integration →
naive euler**, raise **Bouncy → f** to ~8 and drop **Simulation → sim rate** to 30 Hz: the follower
diverges and keeps getting reset.

Two fixes are implemented:

- **Clamped k2** — raise `k2` to `max(k2, dt²/2 + dt·k1/2, dt·k1)`. Always stable, but a fast system
  becomes slower than requested at low rates.
- **Pole matching** — when `ω·dt ≥ ζ`, pick `k1, k2` so the discrete system's poles equal the exact
  poles `e^{s·dt}` of the continuous one. The response stays fast *and* stable. Compare the solid curve
  to the dashed 1 kHz reference in the plot while changing the rate.

## Exact critically damped spring

The purple follower is a different tool: a critically damped spring integrated in closed form
(Holden). It has a single parameter (half-life), cannot overshoot and is exact at any `dt` — two half
steps equal one full step. Cheaper and safer, but it cannot express overshoot or anticipation.

## Secondary motion

The critter reuses the same primitive everywhere:

- **Body position** follows the rail's x with mild overshoot (`r > 0`).
- **Facing** is a smoothed direction vector; **lean** tilts the up axis toward smoothed acceleration.
- **Antennae and tail** are chains. Each joint chases its rest position in the *body* frame through
  its own second-order system, then is projected back to a fixed segment length. Because every joint
  follows the already-lagged joint before it, motion whips down the chain. Low `ζ` on the antennae gives
  the springy wobble; higher `ζ` on the tail keeps it heavy.

Writing the projected position back into the system state (`setOutput`) is important: otherwise the
internal state drifts away from what is rendered and the chain stretches and snaps.

## Failure modes

- Finite-difference `x'` amplifies teleports. Pass the true input velocity when you have it.
- Large `r` with low `ζ` produces huge overshoot after jumps — clamp the input or reset on teleport.
- Pole matching assumes constant `x` over the step; very jerky inputs at low rates still alias.

## References

- t3ssel8r, [Giving Personality to Procedural Animations using Math](https://www.youtube.com/watch?v=KPoeNZZ6H4s) (2022)
- D. Holden, [Spring-It-On: The Game Developer's Spring-Roll-Call](https://theorangeduck.com/page/spring-roll-call) (2021)
