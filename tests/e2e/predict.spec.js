// E2E for the predict-first step (walkthrough 2026-10-13, findings 3 and 8).
// 3: clicking passes/fails must NOT lock the guess: the optional error-code box
//    stays usable until the learner confirms it (Lock guess, Enter, or Run).
// 8: the guess is graded ONCE, on the first real run of the code it was made on,
//    and never re-graded after the learner fixes the code.
// traits/03_trait_object_dyn fails to compile (E0308). No spec marks it Done:
// these only Run failing code, and Check (Check never advances progress).
const { test, expect } = require('@playwright/test');

const EX = 'traits/03_trait_object_dyn';

async function openInLearn(page, request) {
  const sel = await request.post('/api/select', { data: { id: EX, force: true } });
  expect(sel.ok(), 'pin-select the trait exercise (fresh store — scripts/e2e.sh)').toBeTruthy();
  await page.goto('/'); // Learn is the default mode
  await expect(page.locator('.cm-content')).toBeVisible();
  // THIS exercise's starter is in the editor (the guess is about the code on screen).
  // Ids are no longer printed on the page (titles are), so ask the app.
  await page.waitForFunction((want) => curExercise === want, EX);
}

test.describe('predict-first step', () => {
  test('picking an outcome keeps the error-code box until the guess is locked', async ({ page, request }) => {
    await openInLearn(page, request);
    await page.locator('.pbtn[data-pred="fails"]').click();
    await expect(page.locator('#predcode'), 'the code box survives the outcome click').toBeVisible();
    await page.locator('#predcode').fill('E0308');
    await page.locator('#predlock').click();
    await expect(page.locator('#predictbar'), 'confirming collapses the question').toBeHidden();
    await expect(page.locator('#predictDone')).toContainText('fails');
    await expect(page.locator('#predictDone')).toContainText('E0308');
    await expect(page.locator('#runbtn')).toBeEnabled();
  });

  test('graded once on the first run, never re-graded after a fix', async ({ page, request }) => {
    await openInLearn(page, request);
    await page.locator('.pbtn[data-pred="fails"]').click();
    await page.locator('#predcode').fill('E0308');
    await page.locator('#predcode').press('Enter'); // Enter in the box locks the guess + runs
    await expect(page.locator('#statusline')).toContainText('failed', { timeout: 30_000 });
    await expect(page.locator('#predictbar'), 'the run locked the guess').toBeHidden();
    await expect(page.locator('#predictDone')).toContainText('outcome: right');
    // "Fix" it (any program that compiles) and Check. The verdict must stay about
    // the code the guess was made on, not flip to "you said it fails, it passed".
    await page.evaluate(() => window.__cm.set('fn main() {}\n'));
    await page.locator('#checkbtn').click();
    // A passing Check only type-checks (it never reads as "passed", which means ran).
    await expect(page.locator('#statusline')).toContainText('compiles', { timeout: 30_000 });
    await expect(page.locator('#predictDone')).toContainText('outcome: right');
    await expect(page.locator('#predictDone')).not.toContainText('you said it fails');
    await expect(page.locator('#predictChange'), 'a graded guess is final').toHaveCount(0);
  });

  test('a guess made on already-edited code (a restored draft) is graded on that code', async ({ page, request }) => {
    await openInLearn(page, request);
    // Edit BEFORE guessing, as a draft restored from an earlier visit is: the guess
    // is about the code on screen, so its first run is graded (no Reset needed).
    await page.evaluate(() => window.__cm.set('// my notes\n' + window.__cm.get()));
    await page.locator('.pbtn[data-pred="fails"]').click();
    await page.locator('#runbtn').click();
    await expect(page.locator('#statusline')).toContainText('failed', { timeout: 30_000 });
    await expect(page.locator('#predictDone')).toContainText('outcome: right');
  });

  test('code changed AFTER the guess is not graded, and the summary says so', async ({ page, request }) => {
    await openInLearn(page, request);
    await page.locator('.pbtn[data-pred="fails"]').click();
    // Edited after guessing (it still fails, so nothing is marked Done): this run
    // is not the code the guess was about.
    await page.evaluate(() => window.__cm.set('// edited\n' + window.__cm.get()));
    await page.locator('#runbtn').click();
    await expect(page.locator('#statusline')).toContainText('failed', { timeout: 30_000 });
    await expect(page.locator('#predictDone')).toContainText('not checked');
    await expect(page.locator('#predictDone')).not.toContainText('press Run');
    await expect(page.locator('#predictChange'), 'final: no re-guess after seeing the output').toHaveCount(0);
  });

  test('a toolchain error or timeout (status null) does not use up the guess', async ({ page, request }) => {
    await openInLearn(page, request);
    await page.locator('.pbtn[data-pred="fails"]').click();
    // The server folds a toolchain error or a killed (timed-out) run into
    // passed:false with status null. Nothing ran, so it must not be graded.
    await page.route('**/api/run', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: null, raw_stdout: '', raw_stderr: 'could not run the toolchain: test',
        passed: false, duration_ms: 0, diagnostics: [], exercise: EX, advanced_to: null }) }));
    await page.locator('#runbtn').click();
    await expect(page.locator('#statusline')).toContainText('failed');
    await expect(page.locator('#predictDone')).toContainText('press Run');
    await expect(page.locator('#predictDone')).not.toContainText('outcome');
    // A real run afterwards still grades the guess.
    await page.unroute('**/api/run');
    await page.locator('#runbtn').click();
    await expect(page.locator('#predictDone')).toContainText('outcome: right', { timeout: 30_000 });
  });
});
