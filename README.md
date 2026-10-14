# Advanced Procedural Animations Study

A deep dive into procedural animation in the browser — from inverse kinematics and spring dynamics, through
procedural locomotion and motion matching, to physics-based, RL-driven and LLM-directed characters.

Every study is a standalone interactive 3D page with live parameters, debug visualisation and a technical
write-up. The full list, techniques and references are in [ROADMAP.md](ROADMAP.md).

## Studies

| # | Study | Highlights |
|---|---|---|
| 01 | [Second-Order Dynamics](demos/01-second-order-dynamics/README.md) | frame-rate-stable springs, pole matching, secondary motion |
| 02 | [Analytic IK](demos/02-analytic-ik/README.md) | two-bone IK, soft IK, swing-twist wrist limits, cone-limited look-at |
| 03 | [Iterative IK Lab](demos/03-iterative-ik/README.md) | CCD vs constrained FABRIK vs Jacobian (transpose / pinv / DLS), multi-effector FABRIK |
| 04 | [XPBD Ropes, Tails & Cloth](demos/04-xpbd/README.md) | compliance vs PBD stiffness, cape on a walker, rope bridge, aerodynamic drag |
| 05 | [Procedural Hexapod](demos/05-hexapod/README.md) | raycast footholds, gait arbitration, floor → wall → over the top |
| 06 | [Procedural Quadruped](demos/06-quadruped/README.md) | Hildebrand gait table, continuous walk/trot/canter/gallop blending, digitigrade legs |
| 07 | [Procedural Biped](demos/07-biped/README.md) | Overgrowth-style key poses on a stride wheel, planted feet, springs |
| 08 | [Foot IK over Mocap](demos/08-foot-ik/README.md) | CMU walk on stairs and slopes: pelvis adjust, foot-flat locking, IK on the skeleton |
| 09 | [Motion Matching](demos/09-motion-matching/README.md) | CMU subject 16 database, exact AABB search, spring trajectories, inertialization, foot locking |
| 10 | [Active Ragdoll](demos/10-active-ragdoll/README.md) | Rapier capsules, joint-motor muscles, PuppetMaster pins, hits, falls and recovery |
| 11 | [GPU Procedural Crowds](demos/11-gpu-crowds/README.md) | WebGL2 GPGPU boids with a bitonic-sorted grid, verified against a CPU reference; swimming in the vertex shader |
| 12 | [Evolved Virtual Creatures](demos/12-evolved-creatures/README.md) | Sims-style body plans and oscillator brains, GA across Web Workers, deterministic replays |
| 13–15 | RL locomotion, LLM-directed animation, procedural face | see [ROADMAP.md](ROADMAP.md) |

The studies are tested headlessly, not only eyeballed: the hexapod's wall traversal, the quadruped's gait
blending, the mocap foot penetration, motion matching under scripted input, the ragdoll's hit recovery, the GPU
boids against a CPU reference and the evolved creatures' determinism are all checked by unit or browser
tests.

## Run locally

```bash
npm install
npm run dev        # dev server with the gallery at /
npm run build      # typecheck + production build into dist/
npm test           # unit tests (vitest)
npm run test:e2e   # build + browser smoke tests (playwright)
```

## Layout

```
index.html, src/gallery.ts   gallery page
src/core/                    app shell: renderer, fixed-timestep loop, debug draw, Tweakpane helpers, camera follow
src/math/                    second-order dynamics, exact springs, quaternion utilities, noise
src/ik/                      two-bone, CCD, FABRIK (chain + tree), Jacobian solvers
src/physics/                 XPBD particle solver, Rapier helpers (init, motor driver, fixed stepper)
src/gpu/                     WebGL2 GPGPU passes, bitonic sort, boids CPU reference
src/rig/                     instanced segment rendering, spring chains
src/anim/                    clip player, motion database + features + search, FK, inertialization
src/world/                   height fields, BVH raycasting
src/input/                   keyboard and gamepad state
src/ui/                      demo page frame, plots, footfall chart
src/demos.ts                 study registry (drives the gallery)
demos/NN-slug/               one page per study: index.html, main.ts, README.md (the write-up)
tests/unit, tests/e2e        vitest and playwright suites
tools/bvh-to-clip.mjs        CMU BVH → loopable JSON clip (contacts, loop fix, root motion)
tools/fetch-cmu16.sh, tools/build-mm-db.mjs   CMU subject 16 → motion-matching database
tools/evolve.ts              offline evolution of the study 12 champions (node --experimental-transform-types)
public/assets/mocap/         converted motion capture (CMU, with attribution)
public/assets/creatures/     evolved champions
```

Adding a study: create `demos/NN-slug/` with `index.html` + `main.ts` + `README.md`, register it in
`src/demos.ts`. The Vite config picks up every `demos/*/index.html` automatically.

## Deployment

`.github/workflows/deploy.yml` runs unit tests, the build and the smoke tests on every push and pull
request, and deploys `dist/` to GitHub Pages from `master`. Enable it once under
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

Stack: Vite multi-page app, TypeScript, Three.js, Tweakpane, three-mesh-bvh.

Motion capture: the data used in this project was obtained from mocap.cs.cmu.edu. The database was created
with funding from NSF EIA-0196217.
