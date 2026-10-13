// Screen-reader semantics and focus (accessibility audit 2026-10-13, screen-reader
// lens). A screen reader only knows what the page exposes: roles, names, states,
// the one status region that speaks results (#srAnnounce), and where focus lands
// after an action. These tests read exactly that. Nothing here reaches rustc or the
// store: runs, hints, selects and as-you-type checks are answered by page.route.
const { test, expect } = require('@playwright/test');

// A canned failed compile: the GUI's handling of it is under test, not rustc.
const FAILED_RUN = { status: 1, passed: false, duration_ms: 42, raw_stdout: '', diagnostics: [],
  raw_stderr: 'error[E0384]: cannot assign twice to immutable variable `x`\n --> src/main.rs:3:5\n',
  exercise: null, advanced_to: null };
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// Practice with the current exercise loaded (renderCurrent resets the guess, so a
// pick made before it lands would be wiped).
async function openPractice(page) {
  await page.goto('/');
  await page.waitForFunction(() => !!curExercise);
}

test('a shortcut letter typed in the code editor is typed, not run as a shortcut', async ({ page }) => {
  await openPractice(page);
  await page.evaluate(() => window.__cm.set(''));
  await page.locator('.cm-content').click();
  // Outside a text field l, s, b, f and ? open Lessons, the Cheatsheets, the Book,
  // Focus mode and the keys help. In the editor (a contenteditable) they are code.
  await page.keyboard.type('let s = b?; // f');
  await expect.poll(() => page.evaluate(() => window.__cm.get())).toBe('let s = b?; // f');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('main')).not.toHaveClass(/no-list/);
  await expect(page.locator('#keyshelp')).toBeHidden();
});

test('a run, its graded guess and a hint are announced through one status region', async ({ page }) => {
  await openPractice(page);
  await page.route('**/api/run', (route) => json(route, FAILED_RUN));
  await page.route('**/api/hint**', (route) => json(route, { level: 1, max_level: 3, text: 'Read the --> line first.' }));
  const live = page.locator('#srAnnounce');
  await expect(live, 'in the DOM from page load').toHaveAttribute('role', 'status');
  await page.locator('.pbtn[data-pred="fails"]').click();
  await page.locator('#runbtn').click();
  // The verdict and the FIRST raw error line as the console prints it, then the
  // prediction check (#predictDone itself is not a live region).
  await expect(live).toContainText(/^Failed in 42 ms\. error\[E0384\]: cannot assign twice to immutable variable `x`/);
  await expect(live).toContainText('Your prediction: 🎯 ✓ outcome: right');
  await page.locator('#hintbtn').click();
  await expect(live).toHaveText('Hint 1 of 3: Read the --> line first.');
  // The on-device (Termux) result path says the same kind of line.
  await page.evaluate(() => {
    termuxOp = 'run'; termuxPending = 't1';
    return window.__termuxResult('t1', { exit: 101, stdout: '', stderr: "thread 'main' panicked at src/main.rs:2:5:\nboom\n" });
  });
  await expect(live).toHaveText("Failed on-device, exit 101. thread 'main' panicked at src/main.rs:2:5:");
});

test('the prediction is one labelled group, its pick is exposed, and focus survives lock and change', async ({ page }) => {
  await openPractice(page);
  const group = page.getByRole('group', { name: /Your prediction/ });
  await expect(group).toBeVisible();
  const fails = group.getByRole('button', { name: /fails/ });
  await expect(fails).toHaveAttribute('aria-pressed', 'false');
  await fails.click();
  await expect(fails).toHaveAttribute('aria-pressed', 'true');
  await expect(group.getByRole('button', { name: /passes/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(group.getByRole('textbox'), 'named, not only by a placeholder').toHaveAttribute('aria-label', /error code/i);
  await page.locator('#predlock').click();
  await expect(page.locator('#runbtn')).toBeFocused();
  await expect(page.locator('#srAnnounce'), 'the locked guess is said').toHaveText('Predicted: fails. Press Run.');
  // "change" vanishes as the question comes back: focus lands on its first answer.
  await page.locator('#predictChange').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.pbtn[data-pred]').first()).toBeFocused();
  // Enter in the code box runs, and running collapses the box: focus moves to Run.
  await page.route('**/api/run', (route) => json(route, FAILED_RUN));
  await fails.click();
  await page.locator('#predcode').press('Enter');
  await expect(page.locator('#predictbar')).toBeHidden();
  await expect(page.locator('#runbtn')).toBeFocused();
});

test('"Exercises" stays a heading; on a phone its fold is a real button with a state', async ({ page }) => {
  await openPractice(page);
  await expect(page.getByRole('heading', { name: /^Exercises/ })).toBeVisible();
  const fold = page.getByRole('button', { name: 'Exercise list', exact: true });
  await expect(fold, 'the list never folds on a desktop').toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await fold.focus();
  await page.keyboard.press('Enter');
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#exlist .ex').first()).toBeVisible();
});

test('↺ reset is a real button that restores the starter from the keyboard', async ({ page }) => {
  await openPractice(page);
  const starter = await page.evaluate(() => curOriginal);
  await page.evaluate(() => window.__cm.set('// my edit'));
  const reset = page.getByRole('button', { name: /reset code/i });
  await expect(reset).toBeVisible();
  await reset.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__cm.get())).toBe(starter);
});

test('a view change lands focus on the new view’s heading, not on <body>', async ({ page }) => {
  await openPractice(page);
  const learnTab = page.locator('.tab[data-view="learn"]');
  await learnTab.click();
  await expect(learnTab, 'a tab keeps its focus').toBeFocused();
  await page.locator('.hubcard[data-view="lessons"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#docview h1')).toContainText('Lessons');
  await expect(page.locator('#docview h1')).toBeFocused();
  // A link inside a view paints the next one itself (not through showView).
  await page.locator('.lessonjump[data-id="01-bindings-and-immutability"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#docview .lessonbody h1')).toBeFocused();
  // Back to Practice from inside a view: the exercise title.
  await page.keyboard.press('p');
  await expect(page.locator('#lessonTitle')).toBeFocused();
});

test('a Book reference lands focus on the section it cites, not the chapter title', async ({ page }) => {
  await openPractice(page);
  await page.locator('#hintbtn').focus(); // a Practice control, as the Book refs in Insights are
  await page.evaluate(() => showView('book', 'ch04-02-references-and-borrowing', 'the-rules-of-references'));
  await expect(page.locator('#docview #the-rules-of-references')).toBeFocused();
});

// Switching exercise from the list keeps focus on the chosen row (keyboard-10 in
// keyboard.spec.js) and the status line says "switched"; landing on the title
// instead was the other option, and the row was kept.

test('the compiler output is a named region, its fold says if it is open, the spinner is silent', async ({ page }) => {
  await openPractice(page); // desktop: the console starts unfolded
  await expect(page.getByRole('region', { name: /Compiler output/ })).toBeVisible();
  const fold = page.locator('#tfold');
  await expect(fold).toHaveAttribute('aria-controls', 'conout');
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#throb')).toHaveAttribute('aria-hidden', 'true');
  // The IDE's console is a named region too, and not live: it re-read whole dumps.
  await page.evaluate(() => showView('ide'));
  await expect(page.locator('#ideout')).toHaveAttribute('role', 'region');
  await expect(page.locator('#ideout')).not.toHaveAttribute('aria-live');
});

test('results are said as a count, not re-read as whole lists', async ({ page }) => {
  await openPractice(page);
  // No longer live: a run is summed up by announceRun() instead.
  await expect(page.locator('#recallCodes')).not.toHaveAttribute('aria-live');
  await expect(page.locator('#diag')).not.toHaveAttribute('aria-live');
  const live = page.locator('#srAnnounce');
  // The glossary's visible "N matches" is a status message.
  await page.evaluate(() => showView('glossary'));
  await page.locator('#glq').fill('borrow');
  await expect(page.locator('#docview').getByRole('status')).toHaveText(/^\d+ match/);
  // "No lessons match" is said when it shows.
  await page.evaluate(() => showView('lessons'));
  await page.locator('.lessonfilter').fill('zqxjv');
  await expect(live).toHaveText(/^No lessons match/);
  // The Book's and the hub's searches say their count, not every hit.
  await page.evaluate(() => showView('book'));
  await expect(page.locator('#bsr')).not.toHaveAttribute('aria-live');
  await page.locator('#bsq').fill('ownership');
  await expect(live).toHaveText(/^\d+ chapters? match/);
  await page.evaluate(() => showView('learn'));
  await expect(page.locator('#hubresults')).not.toHaveAttribute('aria-live');
  await page.locator('#hubsearch').fill('zqxjv');
  await expect(live).toHaveText('No matches');
});

test('Dev’s as-you-type check says its problem count, and only when it changes', async ({ page }) => {
  await openPractice(page);
  let checks = 0;
  await page.route('**/api/diagnostics', (route) => { checks++; return json(route, { available: true,
    diagnostics: [{ level: 'error', code: 'E0308', message: 'mismatched types', span: { line: 1 } }] }); });
  await page.locator('#menuBtn').click();
  await page.locator('#modesw button[data-mode="dev"]').click();
  await page.evaluate(() => window.__cm.set('fn main() { let n: i32 = "five"; }'));
  const live = page.locator('#srAnnounce');
  await expect(live).toHaveText('1 problem found as you type');
  // The same count is not said again (#diag used to re-read on every pause).
  await page.evaluate(() => {
    window.__said = 0;
    new MutationObserver((m) => { window.__said += m.length; })
      .observe(document.getElementById('srAnnounce'), { childList: true, characterData: true, subtree: true });
  });
  const before = checks;
  await page.evaluate(() => window.__cm.set('fn main() { let m: i32 = "six"; }'));
  await expect.poll(() => checks).toBeGreaterThan(before);
  await page.waitForTimeout(300); // past the reply and announce()'s 80 ms
  expect(await page.evaluate(() => window.__said)).toBe(0);
});

test('toasts are status regions from load; a level-up and its badge share one; the chip says its values', async ({ page }) => {
  await page.goto('/');
  await page.locator('#exlist .ex[data-id]').first().waitFor(); // the boot-time gamifyUpdate has run
  for (const id of ['#toast', '#xptoast', '#celebrate']) {
    await expect(page.locator(id), id + ' is in the DOM before its first use').toHaveAttribute('role', 'status');
  }
  // Last in the page, so a message one still holds is not read out before the header.
  expect(await page.evaluate(() => ['srAnnounce', 'toast', 'xptoast', 'celebrate'].every((id) =>
    !!(document.querySelector('header').compareDocumentPosition(document.getElementById(id)) & Node.DOCUMENT_POSITION_FOLLOWING))),
  'the status regions follow the page content').toBe(true);
  await page.evaluate(() => { localStorage.removeItem('ts-gamify'); gamifyUpdate(4); gamifyUpdate(5); });
  await expect(page.locator('#xptoast')).toContainText('Level 2');
  await expect(page.locator('#xptoast')).toContainText('Getting going');
  const chip = page.getByRole('button', { name: /^Lv 2, 1-day streak/ });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
});

test('⋯ is a disclosure, not a menu; mode and theme expose their state; focus comes back', async ({ page }) => {
  await openPractice(page);
  await page.locator('#menuBtn').click();
  await expect(page.locator('#appmenu')).toBeVisible();
  await expect(page.getByRole('menu'), 'no ARIA menu without a menu’s arrow keys').toHaveCount(0);
  const assist = page.locator('#modesw button[data-mode="assist"]');
  await assist.focus();
  await page.keyboard.press('Enter');
  await expect(assist).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#modesw button[data-mode="learn"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#menuBtn'), 'closing the menu hands focus back to ⋯').toBeFocused();
  // A "Go to" lands on the view it opens.
  await page.keyboard.press('Enter'); // ⋯ again
  await page.locator('#appmenu .menuitem[data-goto="glossary"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#docview h1')).toBeFocused();
  // 🌓 is a toggle named "Light theme": pressed = the light theme is on.
  const theme = page.getByRole('button', { name: 'Light theme' });
  const isLight = () => page.evaluate(() => String(document.documentElement.dataset.theme === 'light'));
  await expect(theme).toHaveAttribute('aria-pressed', await isLight());
  await theme.click();
  await expect(theme).toHaveAttribute('aria-pressed', await isLight());
});

test('overlays take focus and give it back: the lesson drawer, the keys help, the badges', async ({ page }) => {
  await openPractice(page);
  // The lesson drawer is a modal dialog: focus moves into the reading and the page
  // behind goes inert; Esc hands focus back to the link that opened it.
  const link = page.locator('#lessonLink');
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: /Lesson/ })).toBeVisible();
  await expect(page.locator('#lessonDrawerBody')).toBeFocused();
  await expect(page.locator('main')).toHaveJSProperty('inert', true);
  await page.keyboard.press('Escape');
  await expect(page.locator('main')).toHaveJSProperty('inert', false);
  await expect(link).toBeFocused();
  // The keys help (role=dialog, aria-modal).
  await page.locator('#hintbtn').focus();
  await page.keyboard.type('?');
  await expect(page.locator('.keyshelp-card')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#keyshelp')).toBeHidden();
  await expect(page.locator('#hintbtn')).toBeFocused();
  // The XP and badges panel.
  await page.locator('#xpchip').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#xppanel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#xppanel')).toHaveCount(0);
  await expect(page.locator('#xpchip')).toBeFocused();
});

test('the drawer, closed and quickly reopened, stays open with the page inert behind it', async ({ page }) => {
  await openPractice(page);
  const drawer = page.locator('#lessonDrawer');
  await page.evaluate(() => openLessonDrawer('01-bindings-and-immutability', 'Bindings'));
  await expect(drawer).toHaveClass(/open/);
  // Close, let the slide-out start (two frames), then reopen before it ends: the
  // slide-out's end hid the reopened drawer, and with the page behind it inert,
  // nothing could be pressed any more.
  await page.evaluate(() => new Promise((done) => {
    closeLessonDrawer();
    requestAnimationFrame(() => requestAnimationFrame(() => { openLessonDrawer('01-bindings-and-immutability', 'Bindings'); done(); }));
  }));
  await page.waitForTimeout(700); // well past the 280 ms slide
  await expect(drawer).toBeVisible();
  await expect(page.locator('main')).toHaveJSProperty('inert', true);
  await page.keyboard.press('Escape');
  await expect(page.locator('main')).toHaveJSProperty('inert', false);
});

test('the unshown "↑ Top" button is out of the Tab order and the a11y tree', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => showView('book', 'ch04-01-what-is-ownership'));
  await page.waitForSelector('#docview .bookbody');
  await page.evaluate(() => showView('practice'));
  const top = page.locator('#totop');
  await expect(top, 'the chapter made it, and it stays on <body>').toHaveCount(1);
  await expect(top).toBeHidden();
  expect(await top.evaluate((el) => { el.focus(); return document.activeElement === el; }), 'it cannot take focus').toBe(false);
});

test('"↑ Top" hands focus to the heading it returns to, not to <body>', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => showView('book', 'ch04-01-what-is-ownership'));
  await page.waitForSelector('#docview .bookbody');
  await page.waitForFunction(() => { const dv = document.querySelector('#docview'); return dv.scrollHeight - dv.clientHeight > 1400; });
  await page.evaluate(() => { const dv = document.querySelector('#docview'); dv.scrollTop = 1200; dv.dispatchEvent(new Event('scroll')); });
  const top = page.locator('#totop');
  await expect(top).toBeVisible();
  await top.focus();
  await page.keyboard.press('Enter');
  // At the top the button hides and leaves the Tab order: focus must not go with it.
  await expect(page.locator('#docview .bookbody h2').first()).toBeFocused();
});

test('the concept chip is a disclosure; closing its definition gives focus back to it', async ({ page }) => {
  await openPractice(page);
  const chip = page.locator('#conceptChip');
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Close the definition' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#glossbox')).toBeHidden();
  await expect(chip).toBeFocused();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
});

test('Run keeps its focus while it runs, and a second press does not run it twice', async ({ page }) => {
  await openPractice(page);
  let runs = 0, release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/run', async (route) => { runs++; await held; await json(route, FAILED_RUN); });
  await page.locator('.pbtn[data-pred="fails"]').click();
  const run = page.locator('#runbtn');
  await run.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#statusline')).toHaveText('run…');
  // Mid-run it is aria-disabled, not disabled: disabling it dropped its focus to <body>.
  await expect(run).toHaveJSProperty('disabled', false);
  await expect(run).toHaveAttribute('aria-disabled', 'true');
  await expect(run).toBeFocused();
  await page.keyboard.press('Enter'); // ignored while it runs
  release();
  await expect(page.locator('#statusline')).toHaveText('failed');
  await expect(run).toBeEnabled();
  await expect(run).toBeFocused();
  expect(runs).toBe(1);
});

test('an example’s ▷ Run and the last hint keep their focus too', async ({ page }) => {
  await openPractice(page);
  // The last rung of the hint ladder.
  await page.route('**/api/hint**', (route) => json(route, { level: 3, max_level: 3, text: 'Re-read the Book section.' }));
  const hint = page.locator('#hintbtn');
  await hint.focus();
  await page.keyboard.press('Enter');
  await expect(hint).toHaveAttribute('aria-disabled', 'true');
  await expect(hint).toHaveJSProperty('disabled', false);
  await expect(hint).toBeFocused();
  // A lesson example's ▷ Run, held mid-run.
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/sandbox', async (route) => { await held; await json(route, { status: 0, passed: true, raw_stdout: 'hi\n', raw_stderr: '' }); });
  await page.evaluate(() => openLessonDrawer('01-bindings-and-immutability', 'Bindings'));
  const ex = page.locator('#lessonDrawerBody .coderun-btn').first();
  await ex.focus();
  await page.keyboard.press('Enter');
  await expect(ex).toHaveText('running…');
  await expect(ex).toHaveJSProperty('disabled', false);
  await expect(ex).toBeFocused();
  release();
  await expect(ex).toHaveText('▷ Run');
  await expect(ex).toBeFocused();
});

test('the IDE status is a status region that speaks only when its text changes', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => showView('sandbox')); // a scratch file: saved in the browser, never to disk
  await expect(page.locator('#idehost .cm-scroller'), 'a named stop, like Practice’s').toHaveAttribute('aria-label', /scroll region/);
  const status = page.locator('#docview').getByRole('status');
  await expect(status).toHaveText('ready');
  await page.locator('#idehost .cm-content').click();
  await page.keyboard.type('x');
  await expect(status).toHaveText('scratch · saved in your browser ✓');
  // From here on, count rewrites: a live region re-reads a rewrite of the same text.
  await page.evaluate(() => {
    window.__statusWrites = 0;
    new MutationObserver((m) => { window.__statusWrites += m.length; })
      .observe(document.getElementById('idestatus'), { childList: true, characterData: true, subtree: true });
  });
  await page.keyboard.type('yw');
  await expect.poll(() => page.evaluate(() => window.ideView.state.doc.toString())).toContain('xyw');
  await page.evaluate(() => new Promise(requestAnimationFrame)); // let the observer report
  expect(await page.evaluate(() => window.__statusWrites)).toBe(0);
}); 
