// "↺ reset" (back to the starter code) was a click-only <span>: no Tab stop and
// no button role, so a keyboard or screen-reader learner had no way back to the
// starter (WCAG 2.1.1, 4.1.2). It is a real <button> now. Read-only on the store.
const { test, expect } = require('@playwright/test');

test('↺ reset is a keyboard button that restores the starter code', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => curExercise !== null); // the exercise and its starter loaded
  const starter = await page.evaluate(() => curOriginal);
  await page.evaluate(() => window.__cm.set('// scribbled over'));
  const reset = page.getByRole('button', { name: 'Reset code to the original starter' });
  await expect(reset, 'exposed as a button').toBeVisible();
  await reset.focus();
  await expect(reset, 'a Tab stop').toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__cm.get()), 'the starter code is back').toBe(starter);
});
