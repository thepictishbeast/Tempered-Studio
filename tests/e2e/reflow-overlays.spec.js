// WCAG 1.4.10 at its reference size: 1280x1024 at 400% zoom is 320x256 CSS px (a
// landscape phone is barely taller). A position:fixed sheet can't be page-scrolled,
// so it must fit the viewport and scroll itself, or its lower controls are out of reach.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 320, height: 256 } });

/** Scroll `sel` into view within its sheet; return its box and the viewport height. */
const reach = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, vh: innerHeight };
}, sel);

test('the ⋯ menu reaches its last control (Reading size A+)', async ({ page }) => {
  await page.goto('/');
  await page.locator('#exTitle').waitFor();
  await page.click('#menuBtn');
  await expect(page.locator('#appmenu')).toBeVisible();
  const r = await reach(page, '#rsUp');
  expect(r.bottom, 'A+ ends inside the viewport').toBeLessThanOrEqual(r.vh);
});

test('the XP panel reaches its last badge', async ({ page }) => {
  await page.goto('/');
  await page.locator('#exTitle').waitFor();
  await page.evaluate(() => gamifyTogglePanel());
  const r = await reach(page, '#xppanel .badge:last-child');
  expect(r.bottom, 'the last badge ends inside the viewport').toBeLessThanOrEqual(r.vh);
});

test('the keyboard-shortcuts card fits, and scrolls to its last line', async ({ page }) => {
  await page.goto('/');
  await page.locator('#exTitle').waitFor();
  await page.evaluate(() => toggleKeysHelp(true));
  const head = await page.locator('.keyshelp-card h2').boundingBox();
  expect(head.y, 'the heading is not pushed above the viewport').toBeGreaterThanOrEqual(0);
  const r = await reach(page, '.keyshelp-foot');
  expect(r.bottom, 'the last line ends inside the viewport').toBeLessThanOrEqual(r.vh);
});
