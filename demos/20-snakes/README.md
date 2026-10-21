# Snakes & Worms

Nothing in this study is animated. Each creature only changes its **shape**: where its body points are in its
own frame, which of them touch the ground, and how hard each grips. Where it goes is whatever Newton's laws say
happens when the ground's friction pushes back on the moving points. That is why a snake on ice goes nowhere,
and a sidewinder crosses sand that would defeat a slithering one.

## One model, four gaits

`slither.ts` follows Hu, Nirody, Scott & Shelley, *The mechanics of slithering locomotion* (PNAS 2009):

- The centre of mass obeys M dV/dt = Σ Fᵢ.
- The angular momentum about it obeys dL/dt = Σ rᵢ × Fᵢ, with L = I·Ω + Σ mᵢ qᵢ × q̇ᵢ. The second term is the
  spin a shape change carries by itself. A body that changes shape in the air turns (the falling cat), but its
  centre of mass cannot move.
- Each point feels Coulomb friction against its velocity, with its own coefficients forward (μ_f), backward
  (μ_b) and sideways (μₙ). Near zero velocity the friction is regularised, so resting points don't chatter.

The four creatures differ only in the shape they write each step (`gaits.ts`):

| creature | shape | contact and grip |
|---|---|---|
| snake | serpenoid curve, φ(s,t) = A cos(2π(ks/L + ft)): bending waves travel head → tail (Hirose 1993) | optionally lifts its most curved parts |
| sidewinder | the same bending wave plus a lifting wave a quarter-period behind | only the momentarily still parts touch |
| earthworm | a wave of segment stretching; volume is conserved, so short segments are fat | bristles grip backward (μ_b ≫ μ_f) |
| inchworm | an arch that rises and falls between the two gripping ends | the ends take turns gripping |

Steering is a curvature bias toward the clicked point. Speed is never set; it comes out of the friction.

## Measured

Lateral undulation (1 m snake, 1 Hz, 1.5 waves on the body), forward speed in m/s:

| μₙ / μₜ | 1 | 1.5 | 2 | 3 | 5 | 8 |
|---|---|---|---|---|---|---|
| flat | **−0.04** | 0.02 | 0.07 | 0.16 | 0.26 | 0.35 |
| lifting the bends | 0.04 | 0.11 | 0.17 | 0.25 | 0.34 | 0.41 |

- **Equal friction in every direction** goes nowhere (slightly backwards). Thrust comes only from the
  sideways/lengthwise difference, which is why snakes have belly scales and why one on ice slips in place.
- **On a corn snake's measured friction** (μ_f 0.11, μ_b 0.14, μₙ 0.20, from Hu et al.) the flat snake manages
  0.05 m/s. Lifting the bends, which real snakes do, raises it to 0.15 m/s. Lifting takes the parts that would
  drag sideways off the ground and leaves the weight on the parts that push.
- **Sidewinding** moves at 0.45–0.47 m/s on friction from μ 0.2 to 0.8. Equal friction is no handicap: the
  contact patches are momentarily still, so they don't slide. It travels at 87–97° to its body axis, as real
  sidewinders do, and leaves separate J-shaped tracks (turn on "leave tracks"). Without the lifting wave, the
  same bending wave thrashes at 0.05 m/s, slightly backwards.
- **The earthworm** (18 cm, 1 Hz) crawls at 26 mm/s with backward-gripping bristles (μ_b 0.6), the same order as a
  real one's 1–2 cm/s. With μ_b = μ_f it stays put, whichever way the wave runs, and it crawls forward either way
  too. The ratchet decides the direction, not the wave.
- **The inchworm** covers 91–95% of its reach per cycle (14.5 mm of 16, 30.3 of 32). The loss is the sliding
  end's friction (μ 0.05) pulling the planted one back: with none it covers 100%, and with μ 0.2, 83%.

## Rendering

The body is a tube through the points: Catmull-Rom subdivided, capped at both ends, and vertex-coloured per
creature (corn-snake saddles, sidewinder spots, the worm's segment rings and saddle, the caterpillar's side
stripe). The snake's tongue flicks. Points that rest on the ground leave marks.

## Failure modes

- The ground is a plane with Coulomb friction. There is no granular sand to dig into, and no pegs to push
  against, which real snakes use too.
- The snake's lifting is a weight distribution, not a 3-D body, and nothing checks that it is balanced.
- Concertina and rectilinear snake gaits, which need grip that changes along the body over time, are not
  modelled.

## References

- D. L. Hu, J. Nirody, T. Scott, M. J. Shelley, *The mechanics of slithering locomotion* (PNAS 2009)
- H. Marvi et al., *Sidewinding with minimal slip: Snake and robot ascent of sandy slopes* (Science 2014)
- S. Hirose, *Biologically Inspired Robots: Snake-Like Locomotors and Manipulators* (1993)
- K. J. Quillin, *Kinematic scaling of locomotion by hydrostatic animals: ontogeny of peristaltic crawling by
  the earthworm* (J. Exp. Biol. 1999)
