// The Tutor USED to be a single hard-coded question that never changed — Paul:
// "there is no answer to the question it asks; the questions should disappear
// once it's satisfied." It now reacts to the last run. Guard both the reaction
// and the charter rule that it stays guide-only (never types the fix).
const { test, expect } = require('@playwright/test');

test('the Tutor reacts to the run and stays guide-only', async ({ page }) => {
  await page.goto('/');
  const tutor = page.locator('#tutorbox');
  // Pre-run: the generic predict prompt.
  await expect(tutor).toContainText(/prediction say/i);

  // Assist mode (no predict gate) + a definite compile error (E0384).
  await page.locator('#menuBtn').click(); // open the ⋯ menu (mode switcher lives there now)
  await page.locator('.modesw [data-mode="assist"]').click();
  await page.evaluate((v) => window.__cm.set(v), 'fn main() {\n    let x = 5;\n    x = 6;\n    println!("{x}");\n}');
  await page.locator('#runbtn').click();

  // It now names the real error and asks a contextual question — but never the fix.
  await expect(tutor).toContainText(/E0384/, { timeout: 30_000 });
  await expect(tutor).toContainText(/never type your fix/i);
});

// Check only type-checks; a clean Run is what completes an exercise (some
// exercises compile fine and then panic, so "it compiles" can't be the success
// condition). Guard the wording, that Check completes nothing, and that the
// auto-advance after a passing Run hands over a CLEAN next exercise
// (walkthrough 2026-10-13, findings 9 + 10). Pins basics/08_use_before_init:
// no other spec selects or passes it, so it lands on a fresh store (e2e.sh).
test('Check never claims a run or completes; a passing Run advances to a clean exercise', async ({ page, request }) => {
  const EX = 'basics/08_use_before_init';
  const FIX = 'fn main() {\n    let count: i32 = 0;\n    println!("the count is {count}");\n}\n';
  const sel = await request.post('/api/select', { data: { id: EX, force: true } });
  expect(sel.ok(), 'pin-select must succeed (fresh store — scripts/e2e.sh)').toBeTruthy();
  await page.goto('/');
  await expect(page.locator('.cm-content')).toBeVisible();
  // The editor mounts before the exercise loads: wait for EX, or a late load
  // would reset the guess and the buffer set below.
  // Ids are no longer printed on the page (titles are), so ask the app.
  await page.waitForFunction((want) => curExercise === want, EX);
  // Learn mode (the default), as a learner meets it: lock a guess, then fix it.
  await page.locator('.pbtn[data-pred="fails"]').click();
  await page.evaluate((v) => window.__cm.set(v), FIX);

  await page.locator('#checkbtn').click();
  await expect(page.locator('#statusline')).toHaveText(/type-checks/, { timeout: 30_000 });
  const tutor = page.locator('#tutorbox');
  await expect(tutor).not.toContainText(/Solved|compiles and runs/);
  await expect(tutor).toContainText(/press Run/i);
  // Nothing ran: the prediction stays ungraded and the exercise stays current.
  await expect(page.locator('#predictDone')).not.toContainText(/you said|outcome/);
  expect((await (await request.get('/api/current')).json()).exercise, 'Check completes nothing').toBe(EX);
  // Assist re-renders that same Check as parsed Diagnostics (no re-run): no "passed" there either.
  await page.locator('#menuBtn').click();
  await page.locator('#modesw button[data-mode="assist"]').click();
  await expect(page.locator('#diag')).toContainText('no errors');
  await expect(page.locator('#diag')).not.toContainText('passed');
  await page.locator('#menuBtn').click();
  await page.locator('#modesw button[data-mode="learn"]').click();

  // A clean Run completes it and auto-advances…
  await page.locator('#runbtn').click();
  await expect(page.locator('#conout')).toContainText(/exercise complete/, { timeout: 30_000 });
  expect((await (await request.get('/api/current')).json()).exercise, 'a clean Run completes it').not.toBe(EX);
  // …to a next exercise that starts clean: no old output, badge, diagnostics or open gate.
  await expect(page.locator('#statusline')).toHaveText('ready');
  await expect(page.locator('#conout')).not.toContainText('the count is 0');
  await expect(page.locator('#diag')).toContainText('no run yet');
  await expect(page.locator('#runbtn'), 'Learn re-arms predict-first for the new exercise').toBeDisabled();
});
