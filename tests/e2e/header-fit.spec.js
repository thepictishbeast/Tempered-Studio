// Desktop layout in a narrow window or at 200% zoom (761–1099 CSS px): the one-row
// header's fixed widths overflowed. The tab labels wrapped, and the icon buttons were
// pushed past the right edge, where body{overflow:hidden} hid them; the ⋯ menu is the
// only way to Editor mode and Reading size (WCAG 1.4.4 / 1.4.10).
const { test, expect } = require('@playwright/test');

async function header(page, width) {
  await page.setViewportSize({ width, height: 700 });
  await page.goto('/');
  await page.locator('.exlist .ex[data-id]').first().waitFor(); // progress text + XP chip filled in
  return page.evaluate(() => ({
    height: document.querySelector('header').getBoundingClientRect().height,
    rights: ['focusBtn', 'insightsBtn', 'theme', 'menuBtn']
      .map((id) => [id, document.getElementById(id).getBoundingClientRect().right]),
  }));
}

for (const width of [780, 860, 960, 1020]) {
  test(`the header keeps every control on one row at ${width}px`, async ({ page }) => {
    const wide = await header(page, 1280);
    const h = await header(page, width);
    for (const [id, right] of h.rights) expect(right, `#${id} ends inside ${width}px`).toBeLessThanOrEqual(width);
    expect(h.height, 'one row: no label wrapped').toBeLessThanOrEqual(wide.height + 0.5);
  });
}
