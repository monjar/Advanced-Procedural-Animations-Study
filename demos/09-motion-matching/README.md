# Motion Matching + Inertialization

No state machine, no blend tree. The character plays one frame of motion capture at a time; every few frames
it asks the database *"which frame looks most like where I am and where I'm being told to go?"* and jumps
there. The control comes from the search; the quality comes from the data; **inertialization** hides the
jumps. Drive it with WASD / arrows (Shift runs) or a gamepad — until then an autopilot walks a loop.

## Data (`tools/fetch-cmu16.sh`, `tools/build-mm-db.mjs`)

- **CMU subject 16**: 49 locomotion takes (walk, veer left/right, 90° turns, jog, run, sudden stops) plus the
  standing starts of four jump takes as idle. One subject, so no retargeting.
- True CMU scale (hip height ≈ 1 m), 120 → 60 Hz, fingers dropped (25 joints), per-take floor removed, foot
  contacts labelled, 3 frames trimmed at each end, and 70 one- or two-frame rotation spikes (marker swaps at
  the toes and take starts) interpolated out.
- Local rotations as 16-bit (x, y, z) with w ≥ 0, hips in float: **1.2 MB** for 117 s, max quantisation
  error 0.007°.
- **Mirroring at load** doubles it to 14 040 frames: positions (−x, y, z), rotations (x, −y, −z, w) with left
  and right joints swapped. A left turn becomes a right turn; the tests check it, and that mirroring twice
  returns the input bit for bit.

**Honest scale check:** that is 2 minutes of one person. LaFAN1, the usual research set, is 4.6 hours. CMU
takes are short (runs 1.1–1.8 s) because the capture volume is small, so the trajectory horizon is 0.5 s
instead of the usual 1 s, and the search hops between takes often.

## Features

Everything is measured in the frame of a **simulation bone**: the hips projected to the ground (Gaussian
smoothed, σ = 4 frames) facing the smoothed hip forward (σ = 8). The bone also carries the root motion — its
velocity and turn rate in its own frame.

| group | dims | what |
|---|---|---|
| trajectory position | 6 | where the bone will be in 10 / 20 / 30 frames |
| trajectory direction | 6 | which way it will face then |
| foot position | 6 | both ankles |
| foot velocity | 6 | both ankles |
| hip velocity | 3 | |

Each group is normalised by its own pooled standard deviation (one number per group keeps its geometry) and
weighted (sliders). Past the end of a take the future is extrapolated with its final velocity and turn rate,
or held if it ended at rest. A frame is only a candidate if the take continues for 10 more frames.

## Runtime

1. **Controller** (Holden's "simulation"): input sets a desired velocity and facing; critically damped
   springs smooth them, and the closed-form spring gives the future positions the query needs. Facing
   follows travel — the data has no strafing or backing up.
2. **Search** every 10 frames, immediately when the input changes sharply, and whenever the take runs out:
   query = predicted trajectory (in the character's frame) + the playing frame's own foot and hip features.
   Jump only if the best match is cheaper than continuing and not just a few frames along the same take.
   The search is exact either way: brute force with early exit, or Holden's two-level **bounding boxes**
   (per-dimension min/max of the normalised features over runs of 64 and 16 frames; a run is skipped when
   even its box can't beat the best cost so far). Same frame, same cost — the tests compare them on 1 500
   queries.
3. **Root motion**: the character moves by the database's root velocity — that is what keeps feet planted.
   Two small corrections tie it to the controller: **adjust** pulls the character towards the predicted path
   but never by more than half its own speed (so a standing character never skates), and **clamp** keeps the
   path within 15 cm of the character.
4. **Inertialization**: on a jump, the difference between the pose on screen and the new frame is stored as
   per-joint rotation offsets (and hip position/velocity offsets) that decay with a critically damped
   spring. Only one pose is ever evaluated; there is no cross-fade.

The matcher runs at the database rate (60 Hz) with an accumulator and renders between steps, so it behaves
identically at any display rate.

## Measured (unit tests, scripted input)

| | |
|---|---|
| walk command 1.3 m/s | 1.31 m/s |
| run command 3.2 m/s | 3.23 m/s |
| 90° turn | within 15° after 0.45 s |
| stop | under 0.15 m/s after 0.73 s, then < 6 cm drift |
| clip switches | 3.8 per second |
| per-frame joint jump at a switch (median / worst) | **2.5° / 15°** inertialized vs 15° / 78° hard cut |
| per-frame joint change in the data itself (99th percentile) | 18° |
| 25 / 60 / 144 fps | same path, same switches |

Inertialized switches are no rougher than the mocap itself; hard cuts are 4–6× worse.

Search, over 12 980 candidates: brute force (with early exit) 0.22 ms; bounding boxes evaluate 9 % of the
frames and take 0.11 ms. Only 2× — at two minutes of data brute force is already cheap; the boxes matter at
hours of data.

## Failure modes

- **Too little data shows.** Runs exist only as 1–2 s takes, so running is a chain of short excerpts; starts
  from rest exist (two walks, two runs) but quick restarts lean on inertialization.
- One residual marker glitch (a 50° ankle flick in take 16_29) survives the spike filter: it moves over two
  frames and does not come back, so it can't be told from real motion automatically.
- No foot IK yet: inertialization and the path adjustment can make a planted foot slide a little.
- No idle turning-on-the-spot data: turning while standing walks a small circle.

## References

- S. Clavet, *Motion Matching and The Road to Next-Gen Animation* (GDC 2016)
- D. Bollo, *Inertialization: High-Performance Animation Transitions in Gears of War* (GDC 2018)
- D. Holden, *Code vs Data Driven Displacement* and the Motion Matching reference implementation (2021)
- D. Holden et al., *Learned Motion Matching* (SIGGRAPH 2020)
- CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu (subject 16)
