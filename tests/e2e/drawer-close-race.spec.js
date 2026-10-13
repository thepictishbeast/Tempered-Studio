// The lesson drawer slides in on the NEXT animation frame. A close that lands
// before that frame (Esc pressed at once, a quick double tap) used to lose:
// the late frame re-opened the drawer, or, when both fell in one frame, no slide
// ran, no transitionend came, and the off-screen drawer never got `hidden`, so
// its links stayed in the Tab order. (Seen as keyboard-5 failing 4 runs in 8.)
const { test, expect } = require('@playwright/test');

async function openPractice(page) {
  await page.goto('/');
  await page.waitForFunction(() => curExercise !== null);
  await expect(page.locator('#lessonLink')).toBeVisible();
}

test('a drawer closed before its opening frame ends closed and hidden', async ({ page }) => {
  await openPractice(page);
  await page.evaluate(() => { document.getElementById('lessonLink').click(); closeLessonDrawer(); });
  await page.waitForTimeout(700); // past the late frame, the slide and any backup timer
  const drawer = page.locator('#lessonDrawer');
  await expect(drawer).not.toHaveClass(/open/);
  await expect(drawer).toBeHidden();
  await expect(page.locator('#lessonDrawerOverlay')).toBeHidden();
});

test('reopening straight after a close is not undone by that close', async ({ page }) => {
  await openPractice(page);
  await page.locator('#lessonLink').click();
  await expect(page.locator('#lessonDrawerBody .lessonbody')).toBeVisible();
  await page.evaluate(() => { closeLessonDrawer(); document.getElementById('lessonLink').click(); });
  await page.waitForTimeout(700);
  const drawer = page.locator('#lessonDrawer');
  await expect(drawer).toHaveClass(/open/);
  await expect(drawer).toBeVisible();
});
