// E2E for the RECALL (spaced-repetition) chips becoming active-recall prompts:
// after you OVERCOME an exercise (pass it), its error code enters the review queue
// and shows as a chip; the chip is a button whose code you try to recall, and
// activating it reveals the explanation (reuses the Explain op).
const { test, expect } = require('@playwright/test');

const EX = 'basics/01_immutable_assign'; // expected error E0384
const FIX = 'fn main() {\n    let mut count = 0;\n    count = count + 1;\n    println!("count is {count}");\n}\n';

test('a passed exercise adds an actionable RECALL chip that explains on activation', async ({ page }) => {
  // pass the exercise (Assist = no predict-gate) so its code is recorded as "overcome"
  await page.goto('/');
  await expect(page.locator('.cm-content')).toBeVisible();
  // MUST land (force bypasses Locked but NOT Done): on a polluted store this
  // 409'd silently and the FIX below then ran against whatever exercise was
  // current — quietly PASSING it and advancing the real store's progress.
  const selOk = await page.evaluate((id) => fetch('api/select', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, force: true }),
  }).then((r) => r.ok), EX);
  expect(selOk, 'pin-select basics/01 must succeed (run against a FRESH store — scripts/e2e.sh)').toBeTruthy();
  await page.goto('/');
  await page.locator('#menuBtn').click(); // open the ⋯ menu (mode switcher lives there now)
  await page.locator('#modesw button[data-mode="assist"]').click();
  await page.evaluate((v) => window.__cm.set(v), FIX);
  // Wait on the run itself: its response says whether the fix passed.
  const [runRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/run') && r.request().method() === 'POST', { timeout: 30_000 }),
    page.locator('#runbtn').click(),
  ]);
  expect((await runRes.json()).passed, 'the fix passes, so its code is recorded as overcome').toBe(true);

  // reload so the RECALL queue re-fetches; the overcome code now shows as a chip
  await page.goto('/');
  await expect(page.locator('#recall')).toBeVisible({ timeout: 10_000 });
  const chip = page.locator('#recallCodes .rc[data-code]').first();
  await expect(chip).toBeVisible();
  expect(await chip.getAttribute('role'), 'chip is a button').toBe('button');
  const code = await chip.getAttribute('data-code');
  expect(code, 'chip carries the overcome error code').toMatch(/E0\d{3}/);

  // activate via keyboard (the footer bar overlays the chip, so click is flaky) →
  // an Explain request for THIS code is sent (deterministic; xterm's scrolled
  // buffer is unreliable to scrape). That's the active-recall self-check firing.
  await page.locator('#menuBtn').click(); // open the ⋯ menu (mode switcher lives there now)
  await page.locator('#modesw button[data-mode="assist"]').click();
  await chip.focus();
  const [req] = await Promise.all([
    page.waitForRequest(
      (r) => r.url().includes('/api/run') && r.method() === 'POST' && (r.postData() || '').includes('"explain"'),
      { timeout: 15_000 },
    ),
    page.keyboard.press('Enter'),
  ]);
  const body = JSON.parse(req.postData());
  expect(body.op, 'activation runs the Explain op').toBe('explain');
  expect(body.code, 'for the chip\'s own code').toBe(code);
});
