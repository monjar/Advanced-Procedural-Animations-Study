# Active Ragdoll (pinned)

A ragdoll that plays animation: fourteen rigid capsules in Rapier, each following one bone of a kinematic
target (the CMU walk from study 08, or a standing pose). Hit it and it reacts physically, staggers, falls if
the hit is big enough, lies limp, and gets back up. This is the model behind Unity's PuppetMaster and most
game "active ragdolls" — **not** a physics-based walker: balance comes from the pins (see failure modes).
Click a body part to hit it.

## The body

- **14 capsules** sized from the CMU skeleton: pelvis, abdomen, chest, head, upper arms, forearms (+hands),
  thighs, shins, feet. Masses from de Leva's segment fractions for a 70 kg body.
- **Body frame = bone frame.** In a BVH rest pose every bone has identity orientation, so each body is
  created at identity with its capsule rotated inside it. The joint target is then simply
  `q_parentBone⁻¹ · q_childBone` from the animated skeleton — merged bones (clavicles, lower back, neck)
  fold in automatically.
- **13 spherical joints**, contacts between jointed bodies off, no self-collision (only the floor).

## Muscles: implicit joint motors

Each joint's three angular motors drive the relative rotation to the target's. Rapier's angular motor on axis
*i* drives the joint error's component *i* towards sin(θᵢ/2), so targets θᵢ = 2·asin(qᵢ) (with w ≥ 0) track the
full quaternion — verified in a unit test to < 1° on random targets.

Gains come from what each joint holds up: stiffness = m·g·d / 0.04 rad (the joint would sag 2.3° under its own
subtree's weight), damping = 2√(k·I) (critical, with the subtree's inertia about the joint). The motors are
implicit, so unlike torques applied from script they stay stable at any stiffness — the step rate only
changes how tightly joints hold together (below).

*Rapier 0.21.0 bug, worked around:* spherical joints come back from the WASM typed as generic, so the JS
wrapper has no motor methods; `asSpherical()` restores the right class (`src/physics/rapier.ts`).

## Pins: the hand of god

Each step every body's linear and angular velocity is blended towards closing the gap to its target body
(close the gap in 0.08 s, blend time constant 0.015 s). The pin weight goes through a cube, as PuppetMaster's
*pin power*: a half-lost pin is an eighth as strong, which is what makes hits read.

## Hits, falls, recovery

- A hit applies the impulse at the clicked point and knocks strength out: the body hit loses all of its pin
  at 40 N·s, its neighbours 60 % as much per joint away, and the whole body loses pin in proportion to
  impulse / 220 N·s. Strength regains over ~1.5 s.
- **Down** = pelvis under 0.5 m, head under 0.85 m, chest tilted past 55°, or pelvis 0.6 m off target. Pins
  go to zero and muscles to 12 % (residual tone — the spherical joints have no limits, so a fully limp body
  would fold through itself).
- After 2 s the target is moved to where the pelvis lies and the pins fade back in over 1.5 s.

## Measured (unit tests, 240 Hz)

| | |
|---|---|
| standing: joint orientation / pelvis error | 1.1° / 1.1 cm mean |
| walking the CMU clip | 5.6° / 2.6 cm mean, pelvis 1.5 cm |
| muscles only, pins off | down after 1.3 s |
| 120 N·s shove to the chest | staggers 18 cm, back within 3 cm in 0.3 s, no fall |
| 250 N·s hit | down in 0.2 s, back on its target 3.7 s later |
| worst joint separation, 60 / 240 Hz | 8 / 1 mm (tracking error nearly identical) |
| no NaN, no body below the floor by > 1 cm, over 20 s standing and 20 s walking | |

Cost: about 0.15 ms per physics step for 14 bodies, 4 steps per 60 Hz frame.

## Failure modes

- **The pins are not physics.** They add momentum from nowhere to keep the body on its animation; a walking
  ragdoll with pins off falls in a second. Physically valid balance needs a controller (SIMBICON-style foot
  placement, or a learned policy — study 13).
- **Getting up is a puppet being lifted:** there is no get-up animation, the pins just fade back in where
  the body lies.
- Spherical joints have no limits in Rapier's JS API; residual muscle tone stands in for them, so a hard
  enough hit can still bend a knee sideways.
- No self-collision: an arm can pass through the torso.

## References

- PuppetMaster (Root Motion), documentation on pin weight, pin power and muscle weight
- T. Geijtenbeek & N. Pronost, *Interactive Character Animation Using Simulated Physics* (Eurographics STAR 2012)
- K. Yin, K. Loken, M. van de Panne, *SIMBICON: Simple Biped Locomotion Control* (SIGGRAPH 2007)
- P. de Leva, *Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters* (J. Biomechanics 1996)
