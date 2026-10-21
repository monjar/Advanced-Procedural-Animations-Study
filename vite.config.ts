import { defineConfig } from 'vitest/config';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Every demos/<slug>/index.html becomes its own page in the multi-page build.
function demoEntries(): Record<string, string> {
  const dir = resolve(root, 'demos');
  if (!existsSync(dir)) return {};
  const entries: Record<string, string> = {};
  for (const slug of readdirSync(dir)) {
    const html = resolve(dir, slug, 'index.html');
    if (existsSync(html)) entries[slug] = html;
  }
  return entries;
}

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages project sites).
  base: './',
  build: {
    target: 'es2022',
    // three.js alone is ~700 kB minified; shared across demos as one cached chunk. Rapier (studies 10, 12) is
    // ~4.4 MB because its WASM is embedded as base64 — loaded only by the pages that use physics.
    chunkSizeWarningLimit: 4600,
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), ...demoEntries() },
    },
  },
  // MuJoCo's loader finds its .wasm next to itself (new URL(…, import.meta.url)); pre-bundling would move it.
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  worker: {
    // Module workers (study 12 imports Rapier inside its worker).
    format: 'es',
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    passWithNoTests: true,
  },
});
