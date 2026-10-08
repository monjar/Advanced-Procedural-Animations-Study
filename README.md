# Advanced Procedural Animations Study

A deep dive into procedural animation in the browser — from inverse kinematics and spring dynamics, through
procedural locomotion and motion matching, to physics-based, RL-driven and LLM-directed characters.

Every study is a standalone interactive 3D page with live parameters, debug visualisation and a technical
write-up. The full list, techniques and references are in [ROADMAP.md](ROADMAP.md).

## Run locally

```bash
npm install
npm run dev        # dev server
npm run build      # typecheck + production build into dist/
npm test           # unit tests
```

Stack: Vite multi-page app, TypeScript, Three.js, Tweakpane.
