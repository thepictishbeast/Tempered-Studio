// Keyboard access to Practice and its overlays (accessibility audit 2026-10-13,
// keyboard lens). Each test is named for the finding it guards; the comment before
// its key assertion says what happened before the fix. Nothing here compiles:
// Learn's predict gate holds r / c and no test presses Run (the prediction box's
// Enter-runs path is in predict.spec.js, which does). Nothing here writes the store
// either: keyboard-10 answers its select in the page, since the other 'ui' specs
// select exercises on the same store at the same time.
const { test, expect } = require('@playwright/test');

// Practice with whichever exercise is current (Learn, the default tier). Every
// exercise has a concept chip and a "read the lesson" link.
async function openPractice(page) {
  await page.goto('/');
  await page.waitForFunction(() => curExercise !== null); // ids aren't on the page: ask the app
}
const focusIn = (page, sel) => page.evaluate((s) => !!document.activeElement.closest(s), sel);
const focusIs = (page, sel) => page.evaluate((s) => document.activeElement.matches(s), sel);

test.describe('keyboard-1: typing code never fires a single-key shortcut', () => {
  test('Practice editor: l, t, b and Rust ? are typed, not obeyed', async ({ page }) => {
    await openPractice(page);
    await page.locator('#cmhost .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// let b = x?;');
    // Before: `l` opened Lessons (the editor went away), `?` opened the help, and
    // the letters never reached the code.
    await expect(page.locator('#docview'), 'l / t / b switched no view').toBeHidden();
    await expect(page.locator('#keyshelp'), 'Rust ? is code, not the help').toBeHidden();
    expect(await page.evaluate(() => window.__cm.get())).toContain('// let b = x?;');
  });

  test('IDE editor: p and b are typed and the IDE stays open', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => showView('sandbox')); // the IDE, on a scratch file
    const ed = page.locator('#idehost .cm-content');
    await expect(ed).toBeVisible();
    await ed.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// pub');
    // Before: `p` jumped back to Practice and threw the IDE away.
    await expect(page.locator('#docview'), 'still in the IDE').toBeVisible();
    await expect(ed).toContainText('// pub');
  });
});

test('keyboard-2: ↺ reset is a real button, and Enter restores the starter code', async ({ page }) => {
  await openPractice(page);
  const starter = await page.evaluate(() => curOriginal);
  await page.evaluate(() => window.__cm.set('// scribbled over'));
  // Before: a click-only <span>: no button for assistive tech, no Tab stop.
  await expect(page.getByRole('button', { name: /reset code/i }), 'exposed as a button').toHaveCount(1);
  const reset = page.locator('#resetbtn');
  await reset.focus();
  await expect(reset, 'a Tab stop').toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__cm.get()), 'the starter code is back').toBe(starter);
});

test('keyboard-3: the way out of the code editor (Esc, then Tab) is stated, and works', async ({ page }) => {
  await openPractice(page);
  // Tab indents in both editors, so the exit must be stated (WCAG 2.1.2). Before:
  // no keybar entry, no help entry, no description on either editor.
  await expect(page.locator('.footer'), 'the desktop keybar').toContainText('Esc then Tab leave the editor');
  await page.keyboard.type('?');
  await expect(page.locator('#keyshelp'), 'the shortcuts help').toContainText('Esc then Tab Leave the editor');
  await page.keyboard.press('Escape');
  const practice = page.locator('#cmhost .cm-content');
  await expect(practice, 'read out on entering the editor').toHaveAttribute('aria-describedby', 'cmKeysHint');
  await expect(page.locator('#cmKeysHint')).toContainText('press Escape, then Tab');
  // …and it works: Tab alone indents and stays; Esc then Tab moves on.
  await practice.click();
  await page.keyboard.press('Tab');
  expect(await focusIn(page, '.cm-editor'), 'Tab alone stays, to indent').toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  expect(await focusIn(page, '.cm-editor'), 'Esc then Tab leaves').toBe(false);
  await page.evaluate(() => showView('sandbox'));
  await expect(page.locator('#idehost .cm-content'), 'the IDE editor says it too')
    .toHaveAttribute('aria-describedby', 'cmKeysHint');
});

test('keyboard-4: single-key shortcuts switch off in the ⋯ menu, and stay off', async ({ page }) => {
  await page.goto('/');
  await page.locator('#menuBtn').click();
  const toggle = page.locator('#keysToggle');
  // Before: no way to turn them off, so r / h / b … acted on any button or link
  // that had focus (WCAG 2.1.4).
  await expect(toggle, 'an off switch, on by default').toBeChecked();
  await toggle.uncheck();
  await page.locator('#hintbtn').focus();
  await page.keyboard.press('b');
  await expect(page.locator('#docview'), 'b no longer opens the Book').toBeHidden();
  await expect(page.locator('.footer > span').first(), 'the keybar stops offering them').toBeHidden();
  await expect(page.locator('.footer .fedit'), 'but keeps the editor exit').toBeVisible();
  await page.reload();
  await page.locator('#menuBtn').click();
  await expect(toggle, 'remembered').not.toBeChecked();
  await page.locator('#hintbtn').focus();
  await page.keyboard.press('b');
  await expect(page.locator('#docview'), 'still off after a reload').toBeHidden();
});

test('keyboard-5: the lesson drawer takes focus as it opens and hands it back', async ({ page }) => {
  await openPractice(page);
  const link = page.locator('#lessonLink'), drawer = page.locator('#lessonDrawer');
  await link.focus();
  await page.keyboard.press('Enter');
  // Before: focus stayed on the link, behind the overlay, and Tab walked the page under it.
  await expect(page.locator('#lessonDrawerBody'), 'focus moves into the drawer').toBeFocused();
  await expect(page.locator('#lessonDrawerBody .lessonbody')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toHaveClass(/open/);
  await expect(link, 'and back to "read the lesson"').toBeFocused();
  // A click on the overlay closes it too. That click leaves nothing focused, and
  // focus still goes back to the link (as it did for an explanation before).
  await expect(drawer).toBeHidden(); // the slide-out has finished
  await page.keyboard.press('Enter');
  await expect(page.locator('#lessonDrawerBody')).toBeFocused();
  await page.locator('#lessonDrawerOverlay').click();
  await expect(drawer).not.toHaveClass(/open/);
  await expect(link, 'a click outside hands focus back too').toBeFocused();
});

test('keyboard-6: the ? help takes focus, keeps Tab inside, and gives focus back', async ({ page }) => {
  await page.goto('/');
  const hint = page.locator('#hintbtn');
  await hint.focus();
  await page.keyboard.type('?');
  await expect(page.locator('#keyshelp')).toBeVisible();
  // Before: focus stayed on Hint, under a dialog that tells screen readers
  // (aria-modal) the page behind it is inert.
  expect(await focusIn(page, '#keyshelp'), 'focus moves into the dialog').toBe(true);
  await page.keyboard.press('Tab');
  expect(await focusIn(page, '#keyshelp'), 'Tab stays in it').toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#keyshelp')).toBeHidden();
  await expect(hint, 'focus is back where it was').toBeFocused();
});

test('keyboard-7: the ⋯ menu hands focus back to ⋯, and closes as Tab moves on', async ({ page }) => {
  await page.goto('/');
  const btn = page.locator('#menuBtn'), menu = page.locator('#appmenu');
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab'); // into the panel: it follows the header in the DOM
  expect(await focusIn(page, '#appmenu'), 'focus is in the panel').toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // Before: hiding the panel took its focused control with it, and focus fell to <body>.
  await expect(btn, 'Escape gives focus back to ⋯').toBeFocused();
  await page.keyboard.press('Enter');
  await page.locator('#modesw button[data-mode="learn"]').focus();
  await page.keyboard.press('Enter'); // choosing a mode closes the panel too
  await expect(menu).toBeHidden();
  await expect(btn, 'so does a choice').toBeFocused();
  await page.keyboard.press('Enter');
  await page.locator('#keysToggle').focus(); // the panel's last control
  await page.keyboard.press('Tab');
  // Before: it stayed open, floating over the page, while focus moved on beneath it.
  await expect(menu, 'Tab past the end closes it').toBeHidden();
});

test('keyboard-8: after "change", focus is back on the question', async ({ page }) => {
  await openPractice(page); // Learn: Run waits for a locked guess
  await page.locator('.pbtn[data-pred="fails"]').focus();
  await page.keyboard.press('Enter'); // pick
  await page.locator('#predlock').focus();
  await page.keyboard.press('Enter'); // lock: the question collapses to a summary
  await expect(page.locator('#runbtn'), 'Run is next').toBeFocused();
  await page.locator('#predictChange').focus();
  await page.keyboard.press('Enter'); // re-open the question
  await expect(page.locator('#predictbar')).toBeVisible();
  // Before: "change" hid with the summary, and focus fell to <body>.
  await expect(page.locator('.pbtn[data-pred]').first(), 'focus is on the question again').toBeFocused();
});

test('keyboard-9: moving between views by keyboard keeps focus in the new view', async ({ page }) => {
  await page.goto('/');
  await page.locator('.tab[data-view="learn"]').click();
  const card = page.locator('.hubcard[data-view="glossary"]');
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#glq')).toBeVisible();
  // Before: the card went with the old view, and focus fell to <body>.
  expect(await page.evaluate(() => document.activeElement !== document.body
    && document.getElementById('docview').contains(document.activeElement)), 'focus is in the new view').toBe(true);
});

test('keyboard-10: choosing an exercise by keyboard keeps focus on its row', async ({ page }) => {
  await openPractice(page);
  // Answer the select here: a real one would move the current exercise under the
  // 'ui' specs running alongside. The list is still fetched again and rebuilt.
  await page.route('**/api/select', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const id = await page.locator('#exlist .ex.sel').getAttribute('data-id'); // the current one
  const row = page.locator(`#exlist .ex[data-id="${id}"]`);
  await row.evaluate((el) => { el.dataset.stale = '1'; }); // marks this node; the rebuild drops it
  await row.focus();
  await page.keyboard.press('Enter'); // select it: the list is then re-rendered
  await expect(page.locator('#exlist .ex[data-stale]'), 'the list was rebuilt').toHaveCount(0);
  // Before: the rebuild destroyed the focused row, and focus fell to <body>.
  await expect(row, 'focus survives the rebuild').toBeFocused();
});

test('keyboard-11: Tab onto the editor scroll region shows a ring inside its box', async ({ page }) => {
  await openPractice(page);
  await page.evaluate(async () => { await document.fonts.ready; });
  const host = page.locator('#cmhost'), scroller = host.locator('.cm-scroller');
  await page.locator('#hintbtn').focus();
  const before = await host.screenshot();
  for (let n = 0; n < 3 && !(await focusIs(page, '#cmhost .cm-scroller')); n++) {
    await page.keyboard.press('Tab'); // Hint → ↺ reset → the scroll region
  }
  await expect(scroller).toBeFocused();
  const ring = await scroller.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), offset: parseFloat(cs.outlineOffset) };
  });
  // Before: the browser's own 'auto' ring, drawn outside the box, where #cmhost's
  // overflow:hidden clipped it away: a Tab stop with nothing to show for it.
  expect(ring.style, 'a solid ring').toBe('solid');
  expect(ring.width, 'at least 2px').toBeGreaterThanOrEqual(2);
  expect(ring.offset + ring.width, 'drawn inside the box, where nothing clips it').toBeLessThanOrEqual(0);
  expect(Buffer.compare(before, await host.screenshot()), 'and it shows').not.toBe(0);
});

test('keyboard-12: ⋯ menu items and IDE explorer rows get a solid focus ring', async ({ page }) => {
  const ringed = () => page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return cs.outlineStyle === 'solid' && parseFloat(cs.outlineWidth) >= 2;
  });
  await page.goto('/');
  await page.locator('#menuBtn').focus();
  await page.keyboard.press('Enter');
  for (let n = 0; n < 6 && !(await focusIs(page, '.menuitem')); n++) {
    await page.keyboard.press('Tab'); // Learn / Assist / Dev, then the first "Go to" item
  }
  expect(await focusIs(page, '.menuitem'), 'on a Go to item').toBe(true);
  // Before: no outline at all, only a #101010 → #1c1c1c background shift (about 1.1:1).
  expect(await ringed(), 'menu item').toBe(true);
  await page.keyboard.press('Escape');
  await page.evaluate(() => showView('ide'));
  await page.waitForSelector('#idetree .ide-group-h');
  await page.locator('#idefoldall').focus();
  await page.keyboard.press('Tab'); // the first group header (Scratch)
  expect(await focusIs(page, '.ide-group-h'), 'on a group header').toBe(true);
  expect(await ringed(), 'explorer header').toBe(true);
});

test('keyboard-13: on a phone, the closed IDE explorer takes no keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => showView('ide'));
  await page.waitForSelector('#idetree .ide-file', { state: 'attached' });
  const filter = page.locator('#idefilter');
  await page.evaluate(() => ideSetSidebar(false));
  await page.waitForTimeout(400); // the .22s slide-out
  await filter.focus();
  // Before: the drawer was only slid off-screen, so every control in it stayed a Tab stop.
  await expect(filter, 'an off-screen control takes no focus').not.toBeFocused();
  await page.evaluate(() => ideSetSidebar(true));
  await filter.focus();
  await expect(filter, 'the open drawer works as before').toBeFocused();
});

test('keyboard-14: ↑ Top takes focus up with the view, and is no Tab stop while hidden', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => showView('book', 'ch04-01-what-is-ownership'));
  await page.waitForFunction(() => {
    const dv = document.querySelector('#docview');
    return dv && dv.querySelector('.bookbody') && dv.scrollHeight - dv.clientHeight > 900;
  });
  const top = page.locator('#totop');
  await page.evaluate(() => { const dv = document.querySelector('#docview'); dv.scrollTop = 700; dv.dispatchEvent(new Event('scroll')); });
  await expect(top).toHaveClass(/\bshow\b/);
  await top.focus();
  await page.keyboard.press('Enter');
  // Before: focus stayed on the button, which then hid at the top.
  await expect(page.locator('#docview'), 'focus goes up with the view').toBeFocused();
  await page.waitForFunction(() => document.querySelector('#docview').scrollTop < 5);
  await expect(top).not.toHaveClass(/\bshow\b/);
  await page.evaluate(() => showView('practice'));
  await page.waitForTimeout(300); // the .2s fade-out
  await top.focus();
  // Before: only opacity:0, so an invisible last Tab stop on every view.
  await expect(top, 'hidden, so not focusable').not.toBeFocused();
});

test('keyboard-15: a control focused at the reading view\'s bottom edge comes clear of the keybar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.evaluate(() => showView('book', 'ch04-01-what-is-ownership'));
  await page.waitForFunction(() => document.querySelectorAll('#docview .bookbody button').length > 4); // Run, Copy, terms
  const clear = await page.evaluate(() => {
    const d = document.getElementById('docview');
    const els = [...d.querySelectorAll('.bookbody a[href], .bookbody button')].filter((el) => el.offsetParent);
    const el = els[Math.floor(els.length / 2)];
    // Park it just inside the view's bottom edge, where Tab can find the next
    // control, then focus it: focus scrolling decides whether it comes into sight.
    d.scrollTop += el.getBoundingClientRect().bottom - (d.getBoundingClientRect().bottom - 4);
    el.focus();
    const r = el.getBoundingClientRect();
    return r.top >= d.getBoundingClientRect().top && r.bottom <= document.querySelector('.footer').getBoundingClientRect().top;
  });
  // Before: that edge sat under the fixed keybar (and a few px past the window), and
  // focusing a control there scrolled nothing, so it stayed hidden (WCAG 2.4.11).
  expect(clear, 'the whole focused control sits above the keybar').toBe(true);
});

test('keyboard-15: the Recall chips at the foot of the exercise column clear the keybar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPractice(page);
  // Draw one due code in the page (the queue comes from /api/review; nothing is stored).
  await page.evaluate(() => renderReview({ tracked: 1, mastered: 0, due: ['E0384'] }));
  await page.locator('#recallCodes .rc').focus();
  const clear = await page.evaluate(() => {
    const chip = document.querySelector('#recallCodes .rc').getBoundingClientRect();
    return chip.bottom <= document.querySelector('.footer').getBoundingClientRect().top;
  });
  // Before: the column ran on under the keybar and nothing scrolls it, so a focused
  // chip sat behind the bar (recall-chip.spec.js presses Enter there, not click).
  expect(clear, 'the whole focused chip sits above the keybar').toBe(true);
});

test('keyboard-16: closing the concept definition by keyboard hands focus back to the chip', async ({ page }) => {
  await openPractice(page);
  const chip = page.locator('#conceptChip');
  await chip.focus();
  await page.keyboard.press('Enter');
  const x = page.locator('#glX');
  await expect(x).toBeVisible();
  await x.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#glossbox')).toBeHidden();
  // Before: the ✕ went with the box, and focus fell to <body>.
  await expect(chip, 'focus is back on the chip').toBeFocused();
});

test('keyboard-17: the Exercises heading is a button only where it toggles (phones)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.waitForSelector('#exlist .ex[data-id]');
  // Before: an inert role=button Tab stop on desktop, which also hid the heading.
  await expect(page.getByRole('button', { name: /^Exercises/ }), 'no inert button on desktop').toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Exercises/ }), 'a heading there').toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole('button', { name: /^Exercises/ });
  await expect(toggle, 'the phone accordion toggle').toHaveCount(1);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
