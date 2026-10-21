# Procedural Climbing

A climber gets up a randomly generated wall it has never seen. Nothing is animated: each move is chosen by
search, and the body is placed by geometry. "New wall" gives it a new problem.

## Search over stances (`climb.ts`)

A **stance** is which hold each limb is on: (left hand, right hand, left foot, right foot). A **move** changes one
limb, so the other three always hold the climber. Weighted A* finds a sequence of moves from the four start
holds until both hands are on the top hold.

**Where does the body go?** A stance is possible only if there is a torso position, in the wall's plane, from
which every limb reaches its hold (arm 0.62 m, leg 0.86 m, measured from the shoulders and hips). That is four
reach constraints on two unknowns. Projected Gauss–Seidel solves it: pull the torso toward a comfortable spot
(over the feet, between the hands and the feet), then push it back inside every limb's reach.

**Each candidate move is checked twice.** First, while the limb is moving, can the other three hold the body?
The torso is solved without that limb. Second, does the new stance fit?

**Technique is encoded as constraints and costs:**
- hands at least 35 cm above the feet;
- hands not crossed far, feet not crossed;
- one unit per move, plus a penalty for stretched stances and for going down.

The heuristic is the height still to gain over the most a hand can gain in one move.

**Weighted A\*** (f = g + 3h) gives up the guarantee of the fewest moves for speed. Plain A* (weight 1) and even
weight 2 expand far more stances. Every stance is checked by solving the torso, so expansions are the cost.

## Animation

Each move has three phases:
1. Shift the weight onto the three holding limbs: the torso moves to where those three alone place it (0.35 s).
2. Move the free limb in an arc away from the wall while the torso settles into the new stance (0.55 s).
3. Pause (0.15 s).

Arms and legs are two-bone IK (study 02), with elbows down and out and knees out and away from the wall. Turn
on "show route & reach" to see each hand's path through the plan and the four reach circles.

## Measured

24 random 2.4 × 4 m walls (Poisson-disc holds):

| hold spacing | heuristic weight | routes found | moves | search time |
|---|---|---|---|---|
| 0.32 m | 2 | 19 / 24 | 9.8 | 0.98 s |
| 0.32 m | 3 | **24 / 24** | 10.6 | 0.58 s |
| 0.40 m | 3 | 24 / 24 | 10.6 | 0.11 s |
| 0.25 m | 3 | 7 / 24 | 9.9 | 2.8 s |

Every stance along every route is checked by the tests:
- all four limbs reach their holds (to 1 cm);
- exactly one limb moves at a time;
- the other three hold the body during the move;
- hands stay above feet, and the feet never cross.

**More holds make the problem harder, not easier.** At 25 cm spacing there are about 60% more holds, so each
stance has many more possible moves. Within a 20,000-stance budget the search runs out more often than on a
sparser wall. A person finds a dense wall easier, because they don't consider every hold.

## Failure modes

- Statics are reach-only. Nothing checks that friction can hold a foot on a sloping hold, or that the climber can
  hang from its arms on an overhang (tilting the wall changes only the drawing).
- No dynamic moves (dynos), heel hooks or matching feet: techniques that would expand the moves considered.
- The torso stays parallel to the wall; real climbers twist into the wall to extend their reach.

## References

- S. Kalisiak, M. van de Panne, *A grasp-based motion planning algorithm for character animation* (J. Visualization
  and Computer Animation 2001)
- K. Naderi, J. Rajamäki, P. Hämäläinen, *Discovering and synthesizing humanoid climbing movements* (SIGGRAPH
  2017)
- P. E. Hart, N. J. Nilsson, B. Raphael, *A Formal Basis for the Heuristic Determination of Minimum Cost Paths*
  (1968); I. Pohl, *Heuristic search viewed as path finding in a graph* (1970), for weighted A*
