// Keyboard focus must be visible (WCAG 2.4.7) at 3:1 (1.4.11). The ⋯ menu rows, the
// IDE explorer's group headers + file rows and the glossary ✕ swapped the UA ring
// for a --bg-2 → --bg-3 shift (1.1–1.2:1) or a glyph tint (2.3–2.7:1).
const { test, expect } = require('@playwright/test');

/** Focus `sel` in keyboard modality (a Tab first, so :focus-visible applies); read its outline. */
async function ring(page, sel) {
  await page.keyboard.press('Tab');
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    el.focus();
    const cs = getComputedStyle(el);
    return { visible: el.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
  }, sel);
}

test('menu rows, explorer rows and the glossary ✕ show a 2px focus ring', async ({ page }) => {
  await page.goto('/');
  await page.locator('.exlist .ex[data-id]').first().waitFor();
  await page.click('#menuBtn');
  const menu = await ring(page, '.appmenu .menuitem');
  expect(menu.visible, 'keyboard modality').toBe(true);
  expect(menu, 'a ⋯ menu row').toMatchObject({ style: 'solid', width: 2 });
  await page.keyboard.press('Escape');
  await page.locator('#conceptChip').click();
  await page.locator('#glX').waitFor();
  expect(await ring(page, '#glX'), 'the glossary ✕').toMatchObject({ style: 'solid', width: 2 });
  await page.evaluate(() => showView('ide'));
  await page.locator('.ide-file').first().waitFor();
  expect(await ring(page, '.ide-group-h'), 'an explorer group header').toMatchObject({ style: 'solid', width: 2 });
  expect(await ring(page, '.ide-file'), 'an explorer file row').toMatchObject({ style: 'solid', width: 2 });
});
