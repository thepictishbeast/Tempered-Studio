// Walkthrough 2026-10-13, findings 4 + 7 (output readability).
//  4. After a failed compile the console stayed pinned to the BOTTOM (write()
//     autoscroll): the learner first saw the trailing "help: …" lines while the
//     error header (the line the Tutor says to read first) sat out of view.
//  7. Explain dumped rustc --explain's raw Markdown (``` fences) into that same
//     console, pinned to its end, under a "✓ passed" verdict.
// Guard: a failed Run/Check opens on its FIRST error line (a runtime panic on its
// panic line), and Explain reads as rendered text in the drawer, top first and
// keyboard-reachable, leaving the console's error alone.
const { test, expect } = require('@playwright/test');

// The walkthrough's exercise (basics/08_use_before_init, E0381). Its output is
// taller than the 240px console, so the scroll position decides what shows.
const SRC = 'fn main() {\n    let count: i32;\n    println!("the count is {count}");\n}\n';
const ERROR_LINE = '^error(\\[E\\d+\\])?:';
const PANIC_LINE = "^thread '[^']*' panicked at";

// In the page: px from the console's top edge to the FIRST line matching `src`
// (null if none), plus how far the output overflows the console.
function lineTop(src) {
  const pre = document.getElementById('conout');
  const i = pre.textContent.search(new RegExp(src, 'm'));
  if (i < 0) return null;
  const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let at = i, n;
  while ((n = w.nextNode()) && at >= n.length) at -= n.length;
  const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + 1);
  return { top: r.getBoundingClientRect().top - pre.getBoundingClientRect().top,
           overflow: pre.scrollHeight - pre.clientHeight };
}

test('a failed compile opens on its first error; Explain reads as text in the drawer', async ({ page }) => {
  await page.goto('/'); // Learn, the default tier, as in the walkthrough
  await expect(page.locator('#conout')).toContainText('current exercise'); // renderCurrent has run
  await page.evaluate((v) => window.__cm.set(v), SRC);
  await page.locator('.pbtn[data-pred="fails"]').click();
  await page.locator('#runbtn').click();
  await expect(page.locator('#statusline')).toContainText('failed', { timeout: 30_000 });

  let pos = await page.evaluate(lineTop, ERROR_LINE);
  expect(pos, 'the console holds the compile error').not.toBeNull();
  expect(pos.overflow, 'output taller than the console (else the scroll proves nothing)').toBeGreaterThan(0);
  // ≈ the 8px top padding once anchored; pinned to the bottom it sat far ABOVE the view.
  expect(pos.top, 'the first error line is at the top of the view').toBeGreaterThanOrEqual(0);
  expect(pos.top, '…on the first visible row').toBeLessThan(20);

  // Check prints a "Checking …" line ABOVE the error: it must still open on the error.
  await page.locator('#checkbtn').click();
  await expect(page.locator('#conout')).toContainText('Checking', { timeout: 30_000 });
  pos = await page.evaluate(lineTop, ERROR_LINE);
  expect(pos, 'the Check output holds the error').not.toBeNull();
  expect(pos.top, 'Check opens on the error line, not the status line above it').toBeGreaterThanOrEqual(0);
  expect(pos.top).toBeLessThan(20);

  // Explain from the Assist diagnostics chip, by KEYBOARD → rendered text in the drawer.
  await page.locator('#menuBtn').click(); // the ⋯ menu holds the tier switch
  await page.locator('#modesw button[data-mode="assist"]').click();
  const chip = page.locator('.diag .diagcode').first();
  await expect(chip).toContainText('E0381');
  await chip.focus();
  await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/run') && (r.postData() || '').includes('"explain"')),
    page.keyboard.press('Enter'),
  ]);
  await expect(page.locator('#lessonDrawer'), 'the explanation opens in the drawer').toHaveClass(/open/);
  await expect(page.locator('#lessonDrawerTitle')).toContainText('E0381');
  const body = page.locator('#lessonDrawerBody');
  await expect(body.locator('pre code').first(), 'its example renders as a code block').toBeVisible();
  expect(await body.innerText(), 'no raw Markdown fences').not.toContain('```');
  await expect(body, 'focus moves into the write-up, so arrows / PgDn read it').toBeFocused();
  // The console still shows the error being explained, and a lookup is no "pass".
  await expect(page.locator('#conout')).toContainText('error[E0381]');
  await expect(page.locator('#conout')).not.toContainText('```');
  await expect(page.locator('#statusline')).toContainText('explained');
  // Esc closes it and hands focus back to the chip that asked.
  await page.keyboard.press('Escape');
  await expect(page.locator('#lessonDrawer')).not.toHaveClass(/open/);
  await expect(chip, 'focus returns to the chip').toBeFocused();
});

test('a runtime panic under compiler warnings opens on the panic line', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#conout')).toContainText('current exercise'); // the intro is in; nothing else writes
  // The shape runOp writes for a failed Run: stdout, then stderr (warnings first,
  // then the panic), with no `error:` line anywhere.
  const warn = 'warning: unused variable: `x`\n --> src/main.rs:2:9\n  |\n2 |     let x = 1;\n'
    + '  |         ^ help: if this is intentional, prefix it with an underscore: `_x`\n\n';
  await page.evaluate((w) => {
    term.clear();
    term.write(w.repeat(4) + "thread 'main' panicked at src/main.rs:7:20:\nattempt to divide by zero\n"
      + 'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n');
    term.scrollToFirstError();
  }, warn);
  const pos = await page.evaluate(lineTop, PANIC_LINE);
  expect(pos, 'the console holds the panic').not.toBeNull();
  expect(pos.overflow, 'output taller than the console (else the scroll proves nothing)').toBeGreaterThan(0);
  expect(pos.top, 'the panic line is at the top of the view, not the warnings').toBeGreaterThanOrEqual(0);
  expect(pos.top).toBeLessThan(20);
});

test('a rejected lookup answers in the drawer and leaves the console alone', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#conout')).toContainText('current exercise');
  // Junk typed at the ? prompt: the server only takes letters/digits, so it 400s.
  await page.evaluate(() => runOp('explain', { code: 'E0381?' }));
  await expect(page.locator('#lessonDrawerBody')).toContainText("Couldn't get an explanation");
  await expect(page.locator('#statusline')).toContainText('explain failed');
  await expect(page.locator('#conout'), 'the console keeps what it showed').toContainText('current exercise');
});

test('an explanation borrows the lesson drawer without breaking it', async ({ page }) => {
  await page.goto('/');
  // Long enough to scroll, so "opens at the top" is a check that can fail.
  const md = 'Erroneous code example:\n\n```\nfn main() {}\n```\n\n' + 'More about this error.\n\n'.repeat(80);
  await page.evaluate((m) => showExplanation('E0381', m), md);
  await expect(page.locator('#lessonDrawerTitle')).toContainText('E0381');
  await expect(page.locator('#lessonDrawerBody pre code')).toContainText('fn main');
  await expect(page.locator('#lessonDrawerFull'), 'no "full view" link for an explanation').toBeHidden();
  const body = page.locator('#lessonDrawerBody');
  await body.evaluate((el) => { el.scrollTop = 600; });
  expect(await body.evaluate((el) => el.scrollTop), 'precondition: the write-up scrolls').toBeGreaterThan(0);
  await page.evaluate((m) => showExplanation('E0382', m), md);
  expect(await body.evaluate((el) => el.scrollTop), 'the next explanation opens at its top').toBe(0);
  // The next lesson opened in the drawer gets its full-view link back.
  await page.evaluate(() => openLessonDrawer('01-bindings-and-immutability', 'Bindings'));
  await page.waitForSelector('#lessonDrawerBody .lessonbody');
  await expect(page.locator('#lessonDrawerFull')).toBeVisible();
});
