# Procedural Hands & Grasping

A 21-joint hand plans its own grasps around six objects, then each grasp is tested the only way that settles
it: the same hand is rebuilt in MuJoCo, closes on the object, and lifts it 20 cm. The planner proposes; physics
decides.

## The hand

Four fingers (abduction plus three flexion joints each) and a thumb with opposition, abduction and three
flexion joints. Every link is a capsule with adult proportions. One forward-kinematics function (`hand.ts`)
drives both the planner and the MJCF it writes for MuJoCo, and the two agree to within 10⁻⁶ m.

## Planning a grasp

In the spirit of GraspIt!'s autograsp (Miller & Allen 2004), with the objects as signed distance functions:

1. **Approach.** 40 directions over the upper hemisphere × 4 palm rolls × 4 hand shapes (three thumb
   oppositions for power grasps, plus a pinch).
2. **Slide in.** The pre-shaped hand moves along the approach until the palm or a digit is about to touch.
   Approaches where the hand would hit the table first are dropped.
3. **Close.**
   - *Power grasps:* each digit curls joint by joint. A joint freezes when its link, or any link beyond it,
     touches, so the fingers wrap around the shape.
   - *Pinches:* the thumb, index and middle move together along a straight line in joint space, from an open
     pinch to the tips meeting. This is a hand synergy (Santello 1998; Ciocarlie & Allen's eigengrasps).
     Curling the thumb's flexion joints alone never brings its tip to the index; the tips meet mostly through
     opposition.
4. **Score.** Each contact gets a friction cone (μ 0.6) and soft-finger torsion. That gives three numbers:
   - **ε** (Ferrari–Canny): the radius of the largest wrench-space ball inside the hull of the contact
     wrenches. ε > 0 means force closure: the grasp can resist a push in any direction.
   - **Opposition:** how directly the thumb (or the palm) pushes against the fingers.
   - **Lift quality:** the most weight held per unit of grip force.

   Grasps are ranked force closure first, then by opposition.

All six objects take 0.25–0.85 s to plan (290–525 closed grasps each). One MuJoCo lift (2.1 s simulated)
takes 35–75 ms.

## Measured

| | held the 20 cm lift |
|---|---|
| top 5 ranked, per object (ball · apple · block · can · mug · marker) | 5 · 5 · 5 · 5 · 3 · 0 (23 / 30) |
| rank of the first grasp that holds | 1 · 1 · 1 · 1 · 2 · 10 |
| random grasps **in** force closure | 52 / 95 (55 %) |
| random grasps **not** in force closure | 7 / 180 (4 %) |
| force-closure power grasps / pinches | 46 / 80 · 6 / 15 |
| the same top 5, hand parented to a mocap body | **0 / 30** |

**Force closure is necessary but far from sufficient.** Without it almost nothing lifts. With it, about
half does. Among 190 force-closure grasps, the magnitude of ε did not separate the ones that held (AUC
0.49), and nor did lift quality (0.52). Opposition did (0.73). A hand draped over a can with its palm on the lid
is in force closure on paper, but it holds only while the table pushes back. Hence the ranking: closure as a
gate, then opposition.

**The lying marker** (2.2 cm thick, flat on the table) defeats the best-scored grasps. They hold it end to
end, with contacts above its equator, and drop it. With "next if dropped" on, the page works down the list.
The first grasp that lifts it is ranked 10th: a fingertip pinch.

## What it took

- **Weld the hand, don't teleport it.** A MuJoCo mocap body is moved by assignment, so it has no velocity, and
  its contacts produce no friction drag. A hand parented to one closes perfectly and rises without the object:
  0 of 30. Even a two-jaw gripper slid off a can. Here the hand is a free body welded to the mocap target.
  It moves under physics and follows the target within millimetres.
- **Phantom contacts.** At first, a digit that curled to its joint limits and happened to end within 3 mm of
  the surface counted as touching. That put thumbless pinches at the top of the apple's list. In MuJoCo the
  thumb never arrived, and 0 of the top 5 held. Counting only digits that stopped *on* the object fixed it:
  5 of 5.
- **Sampled ε overestimates.** 3000 random directions are sparse in 6-D. They rated a two-fingertip pinch at
  ε 0.10 when its true value, set by the torsion limit, was 0.01. The best few directions are now refined by
  projected subgradient descent on the support function.
- **Squeeze along the grasp's own closing direction.** The servo targets aim past the planned pose, which is
  what produces grip force. For a pinch that direction is the synergy, not the flexion joints. Squeezing the
  wrong joints halved the pinches that held.
- **MJCF angles.** Without `<compiler angle="radian"/>` joint ranges are read in degrees, and every finger
  stopped at about 2°.

## Failure modes

- The contact model is one point per link. Real finger pads and palms touch over patches. That is why a few
  grasps that are not in force closure on paper still hold in MuJoCo, and why ε's magnitude says little.
- The planner is static. It never asks what happens while the hand closes: the first finger to arrive can push
  the object out of reach of the others. The physics check starts each grasp just short of its planned
  contacts for that reason.
- Thin, flat objects need strategies this planner doesn't have. People slide a pen to the table's edge or
  roll it into their fingers.

## References

- A. T. Miller, P. K. Allen, *GraspIt! A Versatile Simulator for Robotic Grasping* (IEEE RAM 2004)
- C. Ferrari, J. Canny, *Planning Optimal Grasps* (ICRA 1992)
- M. Ciocarlie, P. K. Allen, *Hand Posture Subspaces for Dexterous Robotic Grasping* (IJRR 2009)
- M. Santello, M. Flanders, J. F. Soechting, *Postural Hand Synergies for Tool Use* (J. Neurosci. 1998)
- R. M. Murray, Z. Li, S. S. Sastry, *A Mathematical Introduction to Robotic Manipulation* (1994), ch. 5
- E. Todorov et al., *MuJoCo* (IROS 2012)
