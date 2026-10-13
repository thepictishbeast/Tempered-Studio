// Explain (?) — walkthrough 2026-10-13, findings 5 and 6. It used to open a NATIVE
// prompt() seeded from lastCode, which Learn never sets (its Diagnostics are read
// by hand), so the learner had to retype the code the terminal was showing — and
// the Android app's WebView drops native dialogs outright. Then the explain op's
// own success painted "passed" / "✓ passed in Nms" as if the EXERCISE had passed.
// Now Explain takes the code(s) on screen — one: straight away; several: an
// in-page choice; none: an in-page input — and the status names the explanation,
// never a pass. Any native dialog fails the spec.
const { test, expect } = require('@playwright/test');

// Its starter fails to compile with exactly ONE code, E0381 (no spec passes it,
// so the force-select always lands on the fresh store from scripts/e2e.sh).
const EX = 'basics/08_use_before_init';
// Two independent type errors → two different codes in one run.
const TWO_ERRORS = 'fn main() {\n    let n: i32 = "five";\n    let s = 5u8.shout();\n    println!("{n} {s}");\n}\n';

const isExplain = (r) => r.url().includes('/api/run') && r.method() === 'POST'
  && (r.postData() || '').includes('"explain"');

test.describe('Explain uses the code on screen, in-page, and never reads as a pass', () => {
  let nativeDialogs;
  test.beforeEach(async ({ page, request }) => {
    nativeDialogs = [];
    page.on('dialog', (d) => { nativeDialogs.push(d.type()); d.dismiss().catch(() => {}); });
    const sel = await request.post('/api/select', { data: { id: EX, force: true } });
    expect(sel.ok(), 'pin-select must succeed (fresh store — scripts/e2e.sh)').toBeTruthy();
    await page.goto('/'); // Learn is the default tier
    await expect(page.locator('.cm-content')).toBeVisible();
  });
  test.afterEach(() => {
    expect(nativeDialogs, 'no native alert/confirm/prompt').toEqual([]);
  });

  test('Learn: the one code on screen is explained straight away', async ({ page }) => {
    await page.locator('.pbtn[data-pred="fails"]').click();
    await page.locator('#runbtn').click();
    await expect(page.locator('#statusline')).toContainText(/failed/, { timeout: 30_000 });
    const [req] = await Promise.all([
      page.waitForRequest(isExplain, { timeout: 15_000 }),
      page.locator('#explainbtn').click(),
    ]);
    expect(JSON.parse(req.postData()).code, 'the code the terminal shows').toBe('E0381');
    // The explain op succeeding is not the exercise passing.
    await expect(page.locator('#statusline')).toHaveText('explained E0381', { timeout: 30_000 });
    await expect(page.locator('#conout')).not.toContainText(/passed in \d+ms/);
  });

  test('several codes → an in-page choice, and the run\'s Diagnostics stay', async ({ page }) => {
    await page.locator('#menuBtn').click(); // the mode switcher lives in the ⋯ menu
    await page.locator('#modesw button[data-mode="assist"]').click(); // Assist: no predict gate
    await page.evaluate((v) => window.__cm.set(v), TWO_ERRORS);
    await page.locator('#runbtn').click();
    await expect(page.locator('#statusline')).toContainText(/failed/, { timeout: 30_000 });
    await page.locator('#explainbtn').click();
    const choices = page.locator('#askdlg #askchoices button');
    await expect(choices).toHaveCount(2);
    expect((await choices.allTextContents()).sort()).toEqual(['E0308', 'E0599']);
    await expect(choices.first(), 'focus moves into the question').toBeFocused();
    const [req] = await Promise.all([
      page.waitForRequest(isExplain, { timeout: 15_000 }),
      choices.filter({ hasText: 'E0599' }).click(),
    ]);
    expect(JSON.parse(req.postData()).code).toBe('E0599');
    await expect(page.locator('#statusline')).toHaveText('explained E0599', { timeout: 30_000 });
    // Explain is reference text: the run's parsed codes stay (no "passed" row).
    await expect(page.locator('#diag .diagcode')).toHaveCount(2);
    await expect(page.locator('#diag')).not.toContainText('passed');
  });

  test('no code on screen yet → an in-page input', async ({ page }) => {
    await page.locator('#explainbtn').click();
    const input = page.locator('#askinput');
    await expect(input, 'focus moves into the question').toBeFocused();
    await input.fill('E0384');
    const [req] = await Promise.all([
      page.waitForRequest(isExplain, { timeout: 15_000 }),
      input.press('Enter'),
    ]);
    expect(JSON.parse(req.postData()).code).toBe('E0384');
    await expect(page.locator('#statusline')).toHaveText('explained E0384', { timeout: 30_000 });
  });
});
