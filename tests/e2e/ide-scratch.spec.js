// Regression guard for the Sandbox→IDE merge (Paul 2026-07-08: "the sandbox and
// fullscreen ide should be the same thing ... improve the way the files work
// with it"). The IDE file explorer now carries a "🧪 Scratch" group of free-play
// files — the SAME localStorage store the standalone Sandbox uses (ts-sandbox-
// files) — so a learner has ONE coding environment holding both the course's
// exercise files AND their own scratch files. Scratch files auto-persist to the
// browser (no disk Save), can be created and deleted right in the tree, and never
// touch progress. Exercise files keep their disk Save + progress-neutral gates.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 390, height: 844 } }); // drive it as a phone

test.describe('Sandbox merged into the IDE', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-file');
  });

  test('the explorer shows a Scratch group with files and a New-scratch button', async ({ page }) => {
    await expect(page.locator('.ide-group-h', { hasText: 'Scratch' })).toBeVisible();
    expect(await page.locator('.ide-file.st-scratch').count()).toBeGreaterThan(0);
    await expect(page.locator('.ide-file-new')).toBeVisible();
    // Exercise groups still render beside the scratch group (both coexist).
    expect(await page.locator('.ide-group').count()).toBeGreaterThan(1);
  });

  test('opening a scratch file adapts the toolbar: auto-save, no disk Save/Reset, Delete shown', async ({ page }) => {
    await page.locator('.ide-file.st-scratch').first().click();
    await page.waitForSelector('#idehost .cm-editor, #idehost textarea');
    await expect(page.locator('#ideopenname')).not.toHaveText(/no file open/);
    await expect(page.locator('#idesave')).toBeHidden();
    await expect(page.locator('#idereset')).toBeHidden();
    await expect(page.locator('#idedelete')).toBeVisible();
  });

  test('scratch edits persist to the shared Sandbox store and survive a reload', async ({ page }) => {
    await page.locator('.ide-file.st-scratch').first().click();
    await page.waitForSelector('#idehost .cm-editor');
    await page.evaluate(() => window.ideView.dispatch({ changes: { from: 0, insert: '// SCRATCH-EDIT\n' } }));
    // The edit lands in the SAME key the Sandbox view reads (ts-sandbox-files).
    await expect.poll(() => page.evaluate(() => (localStorage.getItem('ts-sandbox-files') || '').includes('SCRATCH-EDIT'))).toBe(true);
    // Reload (proxy for app-close): the scratch file re-opens with its edit intact
    // via the st.openScratch restore branch — no disk draft involved.
    await page.goto('/');
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('#idehost .cm-editor');
    await page.waitForFunction(() => window.ideView && window.ideView.state.doc.toString().includes('// SCRATCH-EDIT'));
  });

  test('creating and deleting scratch files works, keeping at least one', async ({ page }) => {
    const before = await page.locator('.ide-file.st-scratch').count();
    await page.locator('.ide-file-new').click();
    await page.locator('#askinput').fill('mytest'); // the name is asked in-page
    await page.locator('#askok').click();
    await expect(page.locator('.ide-file.st-scratch')).toHaveCount(before + 1);
    // The freshly-created file becomes the open one.
    await expect(page.locator('#ideopenname')).toHaveText(/mytest/);
    // Delete it (in-page confirm) → back to the original count.
    await page.locator('#idedelete').click();
    await page.locator('#askok').click();
    await expect(page.locator('.ide-file.st-scratch')).toHaveCount(before);
  });

  test('exercise files still open as a progress-neutral workshop (disk Save, no Delete)', async ({ page }) => {
    const exId = await page.evaluate(async () => {
      const d = await (await fetch('api/workspace')).json();
      const ids = d.groups.flatMap(g => g.files.map(f => f.id));
      for (const id of ids) { if ((await fetch('api/workspace/file?id=' + encodeURIComponent(id))).status === 200) return id; }
      return null;
    });
    expect(exId).toBeTruthy();
    await page.evaluate((id) => ideOpenFile(id, null), exId);
    await page.waitForSelector('#idehost .cm-editor, #idehost textarea');
    await expect(page.locator('#ideopenname')).not.toHaveText(/no file open/);
    // Exercise files keep the disk Save + Reset, and hide the scratch-only Delete.
    await expect(page.locator('#idesave')).toBeVisible();
    await expect(page.locator('#idedelete')).toBeHidden();
  });
});
