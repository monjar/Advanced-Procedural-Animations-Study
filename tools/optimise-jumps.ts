// Precompute study 23's preset jumps:
//
//   npx rolldown tools/optimise-jumps.ts --platform node -o /tmp/jumps.mjs && node /tmp/jumps.mjs
//
// Writes public/assets/spacetime/jumps.json: each preset's spline control points and its checks.
import { readFileSync, writeFileSync } from 'node:fs';
import { optimiseJump } from '../demos/23-spacetime/optimise';
import { PRESETS } from '../demos/23-spacetime/presets';

// ONLY=<substring> recomputes just the matching presets and keeps the others from the existing file.
const only = process.env.ONLY;
const previous: { name: string }[] = only ? JSON.parse(readFileSync('public/assets/spacetime/jumps.json', 'utf8')) : [];
const out: unknown[] = [];
for (const preset of PRESETS) {
  if (only && !preset.name.includes(only)) {
    const kept = previous.find((p) => p.name === preset.name);
    if (kept) out.push(kept);
    continue;
  }
  const t0 = performance.now();
  // Up to five seeds until one is feasible; keep the lowest cost (a jump that falls short is a local minimum).
  const feasible = (x: ReturnType<typeof optimiseJump>) => {
    const c = x.contactCheck();
    return x.terms.landingError < 0.01 && c.minFy > 0 && c.maxFriction <= preset.spec.friction + 0.02 && c.maxCop <= 0.13;
  };
  const gens = Number(process.env.GENERATIONS ?? 1000);
  let j = optimiseJump(preset.spec, { seed: 3, generations: gens });
  for (const seed of [7, 11, 19, 23]) {
    if (feasible(j)) break;
    const k = optimiseJump(preset.spec, { seed, generations: gens });
    if (k.cost < j.cost) j = k;
  }
  const contact = j.contactCheck();
  const seconds = (performance.now() - t0) / 1000;
  console.log(`${preset.name}: cost ${j.cost.toFixed(1)} effort ${j.terms.effort.toFixed(2)} landing ${(j.terms.landingError * 100).toFixed(1)} cm, tilt ${(j.terms.landingTilt * 57.3).toFixed(1)}°, ground min ${contact.minFy.toFixed(1)} N, friction ${contact.maxFriction.toFixed(2)}, CoP ${(contact.maxCop * 100).toFixed(1)} cm, ${seconds.toFixed(0)} s`);
  out.push({ name: preset.name, spec: preset.spec, p: Array.from(j.p, (v) => Math.round(v * 1e6) / 1e6), terms: j.terms, contact, seconds });
}
writeFileSync('public/assets/spacetime/jumps.json', JSON.stringify(out));
