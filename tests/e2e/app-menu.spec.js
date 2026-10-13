// The ⋯ menu is a disclosure (a button + a group), not an ARIA menu: role=menu
// promised arrow-key menu keys that never existed, while the panel holds a mode
// switch and the reading steppers. Keyboard contract: Tab walks into it; Esc
// closes it and puts focus back on ⋯ (it was dropped with a hidden item). It
// also carries Help, since ⋯ is the one control in the same place on every view
// (WCAG 3.2.6): the shortcut sheet opened only with `?`. Its Study Guide item has
// the name of the Learn hub card that opens it (3.2.4). Read-only on the store.
const { test, expect } = require('@playwright/test');

test('⋯ by keyboard: Tab reaches its controls; Esc closes it and returns focus to ⋯', async ({ page }) => {
  await page.goto('/');
  await page.locator('#menuBtn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#appmenu')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#modesw button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#appmenu')).toBeHidden();
  await expect(page.locator('#menuBtn'), 'focus is not dropped with the hidden menu').toBeFocused();
  expect(await page.locator('#appmenu[role="menu"], #appmenu [role="menuitem"], #menuBtn[aria-haspopup]').count()).toBe(0);
});

test('⋯ → Keyboard shortcuts opens the sheet without pressing `?`', async ({ page }) => {
  await page.goto('/');
  await page.locator('#menuBtn').click();
  await page.locator('#menuKeys').click();
  await expect(page.locator('#keyshelp')).toBeVisible();
  await expect(page.locator('#appmenu')).toBeHidden();
});

test('⋯ → Study Guide opens it from another view, named as on the Learn hub', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => showView('book'));
  await page.locator('#menuBtn').click();
  const item = page.locator('#appmenu .menuitem[data-goto="studyguide"]');
  await expect(item, 'one name for one place: the hub card says Study Guide too').toContainText('Study Guide');
  await item.click();
  await expect(page.locator('#docview h1')).toContainText('Study Guide');
});
