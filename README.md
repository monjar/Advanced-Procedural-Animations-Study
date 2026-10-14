# Advanced Procedural Animations Study

A deep dive into procedural animation in the browser — from inverse kinematics and spring dynamics, through
procedural locomotion and motion matching, to physics-based, RL-driven and LLM-directed characters.

Every study is a standalone interactive 3D page with live parameters, debug visualisation and a technical
write-up. The full list, techniques and references are in [ROADMAP.md](ROADMAP.md).

## Studies

| # | Study | Status |
|---|---|---|
| 01 | [Second-Order Dynamics](demos/01-second-order-dynamics/README.md) — frame-rate-stable springs, pole matching, secondary motion | live |
| 02 | [Analytic IK](demos/02-analytic-ik/README.md) — two-bone IK, soft IK, swing-twist wrist limits, cone-limited look-at | live |
| 03–15 | Iterative IK, XPBD, procedural locomotion, motion matching, active ragdoll, GPU crowds, evolved creatures, RL, LLM-directed animation | see [ROADMAP.md](ROADMAP.md) |

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
src/core/                    app shell: renderer, fixed-timestep loop, debug draw, Tweakpane helpers
src/math/                    second-order dynamics, exact springs, quaternion utilities
src/ik/                      IK solvers
src/ui/                      demo page frame (header, write-up panel, controls column)
src/demos.ts                 study registry (drives the gallery)
demos/NN-slug/               one page per study: index.html, main.ts, README.md (the write-up)
tests/unit, tests/e2e        vitest and playwright suites
```

Adding a study: create `demos/NN-slug/` with `index.html` + `main.ts` + `README.md`, register it in
`src/demos.ts`. The Vite config picks up every `demos/*/index.html` automatically.

## Deployment

`.github/workflows/deploy.yml` runs unit tests, the build and the smoke tests on every push and pull
request, and deploys `dist/` to GitHub Pages from `master`. Enable it once under
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

Stack: Vite multi-page app, TypeScript, Three.js, Tweakpane.
