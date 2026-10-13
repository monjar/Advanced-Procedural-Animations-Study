import { expect, test, type Page } from '@playwright/test';
import { DEMOS } from '../../src/demos';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('gallery lists every study and links the live ones', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./');
  for (const d of DEMOS) await expect(page.getByRole('heading', { name: d.title })).toBeVisible();
  const live = DEMOS.filter((d) => d.status === 'live');
  await expect(page.locator('a.card')).toHaveCount(live.length);
  expect(errors).toEqual([]);
});

for (const demo of DEMOS.filter((d) => d.status === 'live')) {
  test(`${demo.id} ${demo.title} runs and renders`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`./demos/${demo.slug}/`);
    await expect(page.locator('.demo-header h1')).toContainText(demo.title);
    await expect(page.locator('.writeup h1')).toHaveCount(1);

    // Simulation advances.
    await page.waitForFunction(() => {
      const app = (window as unknown as { __app?: { loop: { time: number } } }).__app;
      return !!app && app.loop.time > 1;
    });

    // Canvas is not blank: sample a grid of pixels right after a render and require variation.
    const variance = await page.evaluate(() => {
      const app = (window as unknown as { __app: { render(): void; renderer: { getContext(): WebGLRenderingContext } } })
        .__app;
      app.render();
      const gl = app.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(4);
      const values: number[] = [];
      for (let i = 0; i < 16; i++) {
        for (let j = 0; j < 16; j++) {
          gl.readPixels(Math.floor(((i + 0.5) * w) / 16), Math.floor(((j + 0.5) * h) / 16), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          values.push(px[0] + px[1] + px[2]);
        }
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    });
    expect(variance).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });
}
