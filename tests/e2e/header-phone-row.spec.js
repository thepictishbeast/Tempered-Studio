// On a phone the header's controls sit on one row. At 390px the ⋯ button
// wrapped onto a line of its own under the others (seen in a screenshot).
const { test, expect } = require('@playwright/test');

for (const width of [360, 390, 412]) {
  test(`phone ${width}px: the header controls share one row`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.waitForFunction(() => curExercise !== null);
    const tops = await page.evaluate(() => ['.brand', '#xpchip', '#insightsBtn', '#theme', '#menuBtn']
      .map((s) => document.querySelector(s))
      .filter((el) => el && el.getClientRects().length)
      .map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
    expect(Math.max(...tops) - Math.min(...tops), `vertical centres: ${tops}`).toBeLessThan(6);
  });
}
