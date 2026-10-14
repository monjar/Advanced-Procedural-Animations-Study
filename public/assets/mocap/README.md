# Motion capture

The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from
NSF EIA-0196217. CMU permits use in research and commercial projects; the data itself must not be resold.
Both files come from Bruce Hahne's MotionBuilder-friendly BVH conversion of the CMU database.

- `cmu-02_01-walk.json` — one gait cycle of subject 02, trial 01 ("walk"), for study 08. Converted with
  `tools/bvh-to-clip.mjs` (metres, 60 Hz, single loop-fixed cycle, foot contact labels).
- `cmu16-mm.bin` — the study 09 motion-matching database: 49 locomotion takes of subject 16 (walks, veers,
  90° turns, jogs, runs, stops) plus the standing starts of four jump takes as idle data; 117 s, 25 joints,
  60 Hz, true CMU scale. Built with `bash tools/fetch-cmu16.sh && node tools/build-mm-db.mjs`; the layout is
  documented in the tool and decoded by `src/anim/mmdb.ts`.
