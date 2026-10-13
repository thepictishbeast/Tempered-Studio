// Batch A (#36/#37): every lesson's practice section now routes into the app
// (Sandbox + the "Practice this lesson" exercise links) instead of `cargo new`.
// This pins the lesson -> exercise handoff end-to-end on the ISOLATED store:
// the link select-jumps to Practice, and the soft-gate confirm ("locked — jump
// ahead anyway?") honours both answers. Also guards the Batch-A content shape:
// the Foundations practice sections must name the in-app Sandbox, not open with
// a bare `cargo new` (the audit's #1 systemic finding).
const { test, expect } = require('@playwright/test');

test.describe('Lesson → Practice handoff (Batch A)', () => {
  test('a locked exercise link asks to jump ahead; declining stays, accepting lands in Practice on it', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#exTitle');
    await page.evaluate(() => showView('lessons', '01-bindings-and-immutability'));
    await page.waitForSelector('#docview .lessonpractice .practicelink');
    const target = await page.locator('#docview .practicelink').first().getAttribute('data-id');
    expect(target).toBeTruthy();

    // Decline the soft-gate question (in-page) -> we stay on the lesson, nothing selected.
    await page.locator('#docview .practicelink').first().click();
    await expect(page.locator('#askmsg')).toContainText('Jump ahead');
    await page.locator('#askno').click();
    await page.waitForTimeout(300);
    await expect(page.locator('#docview .lessonbody')).toBeVisible();

    // Accept it -> force-select + jump to Practice with that exercise current.
    await page.locator('#docview .practicelink').first().click();
    await page.locator('#askok').click();
    await page.waitForFunction(
      (want) => (document.getElementById('exId')?.textContent || document.body.textContent).includes(want),
      target,
      { timeout: 5000 },
    );
    // The Practice surface is live (Run button present and view switched).
    await expect(page.locator('#runbtn')).toBeVisible();
  });

  test('Foundations practice sections route in-app (Sandbox named, no bare cargo-new opener)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#exTitle');
    // Spans both Batch-A slices: Foundations (00/04/07) + the L09–L34 pass
    // (10/20/33), incl. a with-exercise and a sandbox-only lesson from each.
    // NOTE: keep these ids current across lesson splits (a split renames files).
    for (const id of ['00-hello-world', '04-constants', '07-functions', '10-loop-and-break', '20c-question-mark', '33-refutability']) {
      const md = await page.evaluate(async (lid) => {
        const j = await fetch('api/lessons?id=' + lid).then((r) => r.json());
        return j.lesson.markdown;
      }, id);
      const section = md.split(/## 5\./)[1] || '';
      // Drop the heading remnant line, then take the first non-empty BODY line —
      // that's the real opener (checking the raw split would let the heading mask it).
      const body = section.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
      expect(section, `${id} practice names the Sandbox`).toContain('Sandbox');
      expect(body[0], `${id} practice opens by routing into the app`).toMatch(/^Type these in the app/);
    }
  });
});
