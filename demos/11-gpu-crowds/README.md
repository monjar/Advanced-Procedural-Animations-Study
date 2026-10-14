# GPU Procedural Crowds

Sixteen thousand fish, simulated and animated entirely on the GPU with WebGL2 — no WebGPU, no compute
shaders: every stage is a full-screen pass writing float render targets. A predator cruises through; a rock
sits in the way.

## Boids (Reynolds 1987)

Each fish steers by its neighbours within 1.6 m: **alignment** to their mean velocity, **cohesion** towards
their centre, **separation** (∝ 1/d inside 0.6 m), plus soft tank walls, the rock and fleeing the predator.
Speed is clamped to [1.2, 4] m/s.

## Finding neighbours on a GPU without compute shaders

Testing all pairs is N² — 268 million distance checks at 16 384. A uniform grid with cells as wide as the
neighbour radius limits the search to 27 cells, but a fragment shader cannot append fish to cells (no
scattered writes). So the grid is built by **sorting**:

1. **Key pass** — each fish writes (cell index, own index).
2. **Bitonic sort** — log₂N·(log₂N+1)/2 passes (105 at 16 384), each comparing texel *i* with *i ⊕ j* and
   keeping the smaller or larger by the block direction. Pairs sort by (key, index), a total order, so the
   result is unique.
3. **Cell pass** — each cell finds its [start, end) in the sorted list by binary search (14 texel reads).
4. **Update pass** — each fish visits its 27 cells, at most 24 fish per cell, and writes position and
   velocity (two render targets at once). Neighbour count and swim phase ride in the spare `w` channels.

State lives in RGBA32F textures read with `texelFetch` at integer coordinates — exact for indices below 2²⁴.
Cell keys use a multiply by 1/cell size (correctly rounded in GLSL; division isn't), so the CPU can reproduce
them bit for bit.

## Swimming in the vertex shader

One instanced draw: each vertex looks up its fish's position and velocity by instance index, builds a frame
from the velocity, and bends the body with a wave travelling head → tail — lateral offset ∝ u²·sin(φ − 5u)
(u = 0 at the head, 1 at the tail), amplitude growing with speed. The phase φ is **integrated per fish** in
the update pass (faster when swimming faster); computing it from time × speed would make it jump whenever
speed changed. Normals are bent with the body for the lighting.

## Measured

**The GPU is checked against a CPU reference** (`src/gpu/boidsCpu.ts`, the same algorithm in JS) by an
end-to-end test that reads the textures back:

| | 1 024 boids | 16 384 boids |
|---|---|---|
| sorted (key, index) identical to the CPU's | yes | yes |
| cell table identical | yes | yes |
| neighbour counts identical after one step | yes | yes |
| worst position difference after one step | 2 µm | 2 µm |

Only one step is compared: float32 vs float64 rounding makes two flocks diverge chaotically after that.

On the CPU reference (1 024 boids, 20 s):

| | |
|---|---|
| local alignment (mean of \|average heading\| over each fish's neighbourhood): random start | 0.56 |
| … after 20 s with alignment | 0.97 |
| … after 20 s without alignment | 0.63 |
| fish leaving the tank | 0 |
| nearest-neighbour distance, 5th percentile | 0.59 m (separation radius 0.6 m) |

Whole-tank polarisation stays low (≈ 0.1) even with alignment: the fish form several schools circling in
different directions, which is why the test measures neighbourhoods instead.

Not measured here: frame rate on a real GPU. The test machines render in software (SwiftShader), where the
page starts at 1 024 fish; it detects that and picks 16 384 on hardware.

## Failure modes

- **The per-cell cap** (24) keeps the cost bounded but truncates dense cells: a fish in a packed school sees
  only the first 24 of a crowded cell (by index), not the nearest. Colour by neighbours to see where.
- Sorting the whole array every frame is O(N log²N) work; past ~64 k a counting sort with atomics (WebGPU
  compute) is the better tool.
- No banking into turns, no tail-fin physics; the predator follows a fixed path rather than hunting.

## References

- C. Reynolds, *Flocks, Herds, and Schools: A Distributed Behavioral Model* (SIGGRAPH 1987)
- K. Batcher, *Sorting networks and their applications* (1968)
- S. Green, *Particle Simulation using CUDA* (NVIDIA, 2010) — sort-based uniform grids
