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
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), ...demoEntries() },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    passWithNoTests: true,
  },
});
