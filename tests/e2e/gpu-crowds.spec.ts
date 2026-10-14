import { expect, test } from '@playwright/test';

interface Verify {
  n: number;
  ordered: boolean;
  permutation: boolean;
  keysMatch: boolean;
  cellMismatches: number;
  withinTolerance: number;
  worstError: number;
  countMismatches: number;
}

test('GPU boids match the CPU reference: sort, cell table and one update step', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('./demos/11-gpu-crowds/');
  await page.waitForFunction(() => !!(window as unknown as { __crowd?: unknown }).__crowd);
  // Let the school form so cells are crowded, then check several states.
  await page.waitForTimeout(1500);
  for (let round = 0; round < 3; round++) {
    const r = (await page.evaluate(() => (window as unknown as { __crowd: { verify(): Verify } }).__crowd.verify())) as Verify;
    console.log(JSON.stringify(r));
    expect(r.ordered).toBe(true);
    expect(r.permutation).toBe(true);
    expect(r.keysMatch).toBe(true);
    expect(r.cellMismatches).toBe(0);
    expect(r.withinTolerance).toBeGreaterThanOrEqual(0.995);
    expect(r.countMismatches / r.n).toBeLessThan(0.005);
    await page.waitForTimeout(500);
  }
  expect(errors).toEqual([]);
});

test('the check also holds at 16 384 boids (128² textures, 105 sort passes)', async ({ page }) => {
  await page.goto('./demos/11-gpu-crowds/');
  await page.waitForFunction(() => !!(window as unknown as { __crowd?: unknown }).__crowd);
  const r = (await page.evaluate(() => {
    const c = (window as unknown as { __crowd: { rebuild(n: number): void; verify(): Verify } }).__crowd;
    c.rebuild(16384);
    return c.verify();
  })) as Verify;
  console.log(JSON.stringify(r));
  expect(r.n).toBe(16384);
  expect(r.ordered && r.permutation && r.keysMatch).toBe(true);
  expect(r.cellMismatches).toBe(0);
  expect(r.withinTolerance).toBeGreaterThanOrEqual(0.995);
});
