# LLM-Directed Animation

Type what the character should do — "walk to the red cube, touch it, then wave at me" — and it does it.
A language model never touches a joint. It writes a short **program** over an intent-level vocabulary, and
everything below that stays procedural: the stride-wheel biped from study 07 walks, two-bone IK from study 02
points and reaches, a spring-smoothed, cone-limited look-at turns the head.

## Why a program, not poses

Language models are good at intent and order ("first this, then that, while doing this") and bad at
kinematics — asked for joint angles they produce plausible-looking numbers that put hands through tables.
So the interface is the vocabulary a director would use:

| action | parameters | driven by |
|---|---|---|
| walk_to | target, speed 0.3–4.5 m/s | steering into the biped's speed / turn inputs (stride wheel, key poses, springs) |
| turn_to | target | turning on the spot |
| look_at | target or none, seconds | head look-at clamped to ±75° of the chest, critically damped |
| point_at | target, hand, seconds | two-bone IK, arm straight along the shoulder → target line |
| reach_for | target, hand, seconds | two-bone IK to the object's top surface, with a crouch for low things |
| wave, nod, shake_head | hand, times | IK target oscillation / head rotation overlay |
| wait | seconds | |

Steps run in order; `with_previous` starts one together with the step before it (wave while walking).

## Two layers of checking

1. **Structured outputs.** The request carries the program's JSON schema as `output_config.format`, so the
   reply is always valid JSON of that shape — no regex scraping, no half-objects.
2. **A validator** for what a JSON schema cannot say. Numeric ranges (structured outputs do not support
   `minimum` / `maximum`), targets that make sense for the action (you cannot walk to the camera), and limbs
   claimed twice by steps that run together. Its messages are written to be sent back: on failure the
   reply, plus "That program cannot run: …", goes back for one repair round.

The request uses `claude-opus-5-5` with the stable system prompt (vocabulary + scene) cached, medium effort,
and server-side fallbacks enabled.

## Performing (`performer.ts`)

The performer runs on top of the study 07 biped without changing it. It feeds the biped speed and turn
commands, then overlays the upper body after each update:

- **Arms.** Two-bone IK targets blended in and out over ~0.25 s, so arms never pop out of the walk's arm swing.
- **Crouch.** Lowers the upper body and re-solves the legs so the knees bend and the feet stay planted. It
  exists because the first version could not "pick up the ball": the shoulders are 1.33 m up, the ball's top
  0.62 m, the arm 0.54 m long.
- **Head.** Spring-smoothed and clamped to a cone around the chest, with nods and shakes on top.

Every finished step records whether it achieved its intent and by how much. The tests run every example and
require all of it:

| example programs (8, 43 steps) | result |
|---|---|
| steps achieved | 43 / 43 |
| walk_to: stopping distance error | 8 cm |
| point_at: arm vs target direction | < 0.05° |
| reach_for: hand to touch point, including the crouch for the blue ball | 10–11 cm |
| with_previous steps start in the same frame; others wait for their group | ✓ |

## Without an API key

The examples below the prompt box run from programs written in advance, so the page works without a key.
They use the same schema and pass the same validator, but they are **not** recorded API responses. With a key
(stored only in your browser, and only if you tick "remember"), any prompt goes to the API from your browser.

The client is tested against a fake API: it checks the request (model, schema, fallbacks header, browser-access
header, key) and the repair round-trip.

## Failure modes

- The vocabulary is the ceiling: no jumping, sitting or carrying. The model is told to do the closest thing
  and say so in the summary ("Jump up and down!" → an excited two-handed wave and a nod).
- Spatial reasoning beyond named objects ("go between the cube and the ball") is not expressible.
- reach_for succeeds only after walk_to has brought the character within arm's length; a program that skips
  that step reports the reach as not achieved.
- Latency: a request takes seconds; the character finishes its current program meanwhile.

## References

- G. Tevet et al., *Human Motion Diffusion Model* (2022) — the learned text-to-motion contrast
- Anthropic, *Structured outputs* and *Tool use* documentation
- D. Rosen, *An Indie Approach to Procedural Animation* (GDC 2014) — the biped underneath
