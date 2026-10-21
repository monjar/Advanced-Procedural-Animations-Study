# Webcam Puppeteering

A pose tracker running in the browser on a plain webcam gives 33 landmarks per frame: 3D points in metres,
centred on the hips. Getting from there to a character takes three steps, and each one has a failure the raw
data makes obvious:

1. **Filter.** Landmarks jitter by centimetres every frame, most in depth.
2. **Retarget.** The tracked person and the character have different bone lengths.
3. **Locomotion.** Hip-centred landmarks contain no travel at all. Walk across the room and the tracker reports
   someone walking on a treadmill.

The page starts on a **simulated tracker**: CMU mocap takes turned into landmarks with tracker-like error. That
way every number can be scored against the truth (the grey stick figure is the real person). **Use my webcam**
switches to MediaPipe's Pose Landmarker. Video is processed in the browser and nothing is uploaded. The model
(~9 MB) is downloaded only when you click.

## The error model (`landmarks.ts`)

Per landmark, per frame, at 30 Hz:
- 1.2 cm of jitter across the image, 2.5× that in depth (a single camera judges depth worst);
- 1.5× more at the wrists and feet;
- a slow drift;
- an occasional outlier of ~12 cm lasting 1–3 frames.

This is a stand-in for a real tracker, chosen to look like MediaPipe's world landmarks, not measured from them.

## Filter (`puppet.ts`)

The **One Euro filter** (Casiez, Roussel & Vogel, 2012) is a low-pass whose cutoff rises with the signal's
speed. A slow signal is smoothed hard, which removes jitter; a fast one is smoothed lightly, which keeps lag
down. A moving average (EMA) has to pick one of the two.

Error is RMS against the truth; jitter is the RMS second difference, in mm/frame²:

| filter | standing: error / jitter | walking | running |
|---|---|---|---|
| none | 2.91 cm / 61.8 | 3.02 cm / 63.8 | 3.04 cm / 63.9 |
| EMA α 0.2 | 1.49 / 7.9 | 4.96 / 8.6 | 7.27 / 9.5 |
| EMA α 0.35 | 1.69 / 14.9 | 3.27 / 15.8 | 4.75 / 16.9 |
| EMA α 0.5 | 1.94 / 23.0 | 2.62 / 24.1 | 3.40 / 25.2 |
| **One Euro** (1.5 Hz, β 4) | 1.86 / 15.1 | **2.53** / 23.3 | **3.15** / 28.4 |
| One Euro (1 Hz, β 2) | 1.67 / 10.5 | 2.82 / 17.7 | 3.88 / 22.5 |
| *true motion's own* | / 0.9 | / 5.8 | / 13.1 |

- **Every EMA is a choice of one take.** α 0.2 is the steadiest standing and the worst running (7 cm behind).
  α 0.5 tracks a run and jitters standing.
- **One Euro is about as accurate as the fast EMA while moving and about as steady as the medium one while
  still.** That is the whole claim, and it holds. The gain is real but modest.
- **No filter gets near the truth's smoothness while standing** (15 against 0.9). The rest of the jitter is
  removed only by smoothing so hard that motion lags.

## Retarget

Each bone keeps its **direction** from the landmarks and takes its **length** from the character. A child, a
giant or a long-legged figure can be driven by anyone, and nothing stretches. *Your proportions* are measured
as each bone's median length over the first two seconds with your whole body in view. Measured through the
simulated tracker's noise, the mocap subject's thigh, shin and upper arm come out within 3 cm.

## Locomotion

The body has to be carried by the feet: one foot is planted, and the body moves so that foot stays still. Which
foot is planted is the whole problem.

**Lowest foot.** The obvious rule. Heel-off lifts the planted ankle before the other foot lands, and depth noise
makes the two feet's heights cross at random. It covered 69–77% of the distance walked.

**Sweeping back.** A planted foot moves backward relative to the hips at the body's speed; a swinging one comes
forward. This rule plants the foot sweeping back faster. As a hard switch it is accurate when walking, but a
person *standing still* walks off. On two still feet, the foot that seems to sweep back fastest is the one whose
noise happens to point backward, so the choice selects for noise, and the noise ratchets the body forward.

**Softened, and gated.** Two changes fix this:
- **Soft weights.** Each foot's motion is weighted by how much faster it sweeps back. When the two feet move
  alike, as when standing, the weights stay equal and their noise cancels instead of being selected.
- **A stride gate.** Motion counts only when the feet's fore-aft separation has swung by more than 12–25 cm in
  the last half second. A stride does that; noise on two standing feet doesn't.

How far the puppet ends up from where the person did, using tracker landmarks with One Euro:

| rule | walk, 4.16 m | walk, 4.40 m | 90° turn | slow walk + stop | **standing, 9.5 s** | run, 4.12 m |
|---|---|---|---|---|---|---|
| sweeping back, hard switch | 0.09 m | 0.08 | 0.12 | 0.19 | **2.33** | 1.29 |
| soft weights | 0.06 | 0.14 | 0.07 | 0.08 | **1.69** | 1.30 |
| soft weights + stride gate | 0.14 | 0.36 | 0.12 | 0.02 | **0.13** | 1.34 |

The gate costs a few tens of centimetres per walk, because the first half step is spent proving it is a step.
It buys a figure that stays where you stand. For a webcam puppet, where people mostly stand, that is the right
trade.

**Runs come up a third short** with every rule. A run has a flight phase with no foot planted, so the feet
cannot say how far the body flew.

## Webcam

- MediaPipe Pose Landmarker (BlazePose GHUM, full model) runs in video mode on the GPU.
- It uses world landmarks, converted from MediaPipe's y-down axes.
- **Mirror** (on by default) swaps left and right, so the puppet moves like your reflection.
- **At a desk, your legs are out of view.** Their landmarks are guesses, with low visibility scores. When any
  knee, ankle or toe drops below 0.5 visibility, the puppet stands on straight legs and stops walking.

## Failure modes

- **Depth from one camera is weak.** Arms reaching toward the lens are the least certain motion, and the
  filter can't add what isn't measured.
- **The puppet is driven, not simulated.** Nothing stops a hand passing through the body, or a pose no body
  could hold.
- **Walking backward fools the rule.** Its planted foot comes *forward* relative to the hips, and the swinging
  one sweeps back, so the puppet walks forward while you back away.
- **Side-steps** have no fore-aft swing, so the stride gate stays shut and the puppet stays where it was.
- **The simulated tracker is a model.** A real tracker's errors are correlated with pose (occluded limbs,
  confusing a left foot for a right) in ways this one isn't.

## References

- G. Casiez, N. Roussel, D. Vogel, *1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in
  Interactive Systems* (CHI 2012)
- V. Bazarevsky et al., *BlazePose: On-device Real-time Body Pose Tracking* (2020)
- G. H. Bazavan et al., *GHUM & GHUML: Generative 3D Human Shape and Articulated Pose Models* (CVPR 2020)
- L. Kovar, J. Schreiner, M. Gleicher, *Footskate Cleanup for Motion Capture Editing* (SCA 2002)
