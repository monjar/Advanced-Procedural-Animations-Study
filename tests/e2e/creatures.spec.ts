import { expect, test } from '@playwright/test';

test('a shipped champion re-simulated in a browser worker scores exactly its Node fitness', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('./demos/12-evolved-creatures/');
  await page.waitForFunction(() => !!(window as unknown as { __creatures?: unknown }).__creatures);
  const r = await page.evaluate(async () => {
    const c = (window as unknown as { __creatures: { champions: number[]; replay(i: number): Promise<number> } }).__creatures;
    const out: { stored: number; replay: number }[] = [];
    for (let i = 0; i < c.champions.length; i++) out.push({ stored: c.champions[i], replay: await c.replay(i) });
    return out;
  });
  console.log(JSON.stringify(r));
  expect(r.length).toBeGreaterThan(0);
  for (const x of r) expect(x.replay).toBe(x.stored);
  expect(errors).toEqual([]);
});
