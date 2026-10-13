// The copy toast ("copied ✓" / "copy failed") is the only answer the 📋 copy
// buttons give. It was created on first use with no role, so a screen reader
// never heard it (WCAG 4.1.3); and a live region must exist BEFORE its first
// message for that message to be read out. Read-only on the store.
const { test, expect } = require('@playwright/test');

test('copy feedback is a status message that is there from the start', async ({ page }) => {
  await page.goto('/');
  const toast = page.locator('#toast');
  await expect(toast, 'the live region exists before any copy').toHaveAttribute('role', 'status');
  await page.evaluate(() => copyText('fn main() {}'));
  await expect(toast).toHaveText(/copied|copy failed/);
  await expect(toast).toHaveAttribute('role', 'status');
});
