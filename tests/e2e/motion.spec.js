// Regression guard for the motion-polish pass (Paul 2026-07-07, #40: "fun and
// cool and modern … animations"). Two properties matter and both are easy for a
// refactor to break: (1) the delight cues exist — the XP bar fills smoothly, a
// view fades in, a level-up pulses the chip; (2) they ALL collapse under
// prefers-reduced-motion, so the app stays usable/accessible for opt-outs; and
// (3) nothing moves on its own forever beside the task (WCAG 2.2.2), while
// ⋯ → Reduce motion does in the app what the OS setting does.
const { test, expect } = require('@playwright/test');

test.describe('Motion polish', () => {
  test('progress + view + level-up cues are present', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#xpchip');
    // The XP bar animates its fill (matching the progress gauge) rather than jumping.
    expect(await page.evaluate(() =>
      getComputedStyle(document.querySelector('#xpchip .xp-bar i')).transitionProperty)).toContain('width');
    // A level-up pulses the chip: seed at 0, jump to Lv 2, the .levelup class fires.
    await page.evaluate(() => { localStorage.removeItem('ts-gamify'); gamifyUpdate(0); gamifyUpdate(5); });
    expect(await page.evaluate(() => document.getElementById('xpchip').classList.contains('levelup'))).toBe(true);
    // A document view fades in on navigation.
    await page.evaluate(() => showView('lessons'));
    await page.waitForSelector('.docview');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.docview')).animationName)).toBe('fadein');
  });

  test('a perfect prediction shows the verdict visibly and celebrates', async ({ page }) => {
    // The predict-first payoff ("were you right?") lives in the VISIBLE locked
    // summary (#predictbar collapses once answered, so the verdict must not hide
    // with it). A perfect guess (outcome + code) earns a 🎯 pop; an imperfect one
    // does not. Driven directly — no rustc round-trip needed.
    await page.goto('/');
    await page.waitForSelector('#exTitle');
    await page.evaluate(() => showView('practice'));
    await page.waitForSelector('#predictbar');
    await page.locator('.pbtn', { hasText: 'fails' }).click();
    await page.locator('#predlock').click(); // lock → #predictDone shows
    const perfect = await page.evaluate(() => {
      predict.code = 'E0384'; lastCode = 'E0384';
      showPrediction({ passed: false, raw_stderr: 'error[E0384]: x' });
      const d = document.getElementById('predictDone');
      const r = d.getBoundingClientRect();
      return { visible: getComputedStyle(d).display !== 'none' && r.height > 0,
        text: d.textContent, celebrated: !!d.querySelector('.pv-perfect'), change: !!d.querySelector('#predictChange') };
    });
    expect(perfect.visible, 'the verdict is actually shown, not in the collapsed bar').toBe(true);
    expect(perfect.text).toContain('🎯');
    expect(perfect.text).toContain('nailed it');
    expect(perfect.celebrated).toBe(true);
    expect(perfect.change, 'a graded guess is final: no "change", no re-grade').toBe(false);
    // Right outcome but WRONG code → no celebration.
    const imperfect = await page.evaluate(() => {
      predict.code = 'E0502'; lastCode = 'E0384';
      showPrediction({ passed: false, raw_stderr: 'error[E0384]: x' });
      const d = document.getElementById('predictDone');
      return { bull: d.textContent.includes('🎯'), celebrated: !!d.querySelector('.pv-perfect') };
    });
    expect(imperfect.bull, 'no bullseye when the code guess was wrong').toBe(false);
    expect(imperfect.celebrated).toBe(false);
  });

  test('prefers-reduced-motion collapses all of it', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto('/');
    await page.waitForSelector('#xpchip');
    // The global guard forces near-zero durations, so nothing animates for opt-outs.
    const barDur = await page.evaluate(() => getComputedStyle(document.querySelector('#xpchip .xp-bar i')).transitionDuration);
    expect(parseFloat(barDur)).toBeLessThan(0.01);
    await page.evaluate(() => showView('lessons'));
    await page.waitForSelector('.docview');
    const viewDur = await page.evaluate(() => getComputedStyle(document.querySelector('.docview')).animationDuration);
    expect(parseFloat(viewDur)).toBeLessThan(0.01);
    await ctx.close();
  });

  test('nothing pulses or spins forever beside the task (WCAG 2.2.2)', async ({ page }) => {
    // Motion that starts on its own and lasts over 5s needs a way to stop it. The
    // terminal throbber spun at 11fps forever (idle too), and the prediction
    // spotlight and Run's call to action pulsed as long as you read or coded.
    await page.goto('/'); // Learn: the unanswered prediction is spotlit
    await page.waitForSelector('#predictbar.needs-answer');
    const iters = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).animationIterationCount, sel);
    expect(await iters('#predictbar'), 'the spotlight pulses briefly, not forever').not.toBe('infinite');
    const throb = page.locator('#throb');
    const idle = await throb.textContent();
    await page.waitForTimeout(450);
    expect(await throb.textContent(), 'the idle throbber stands still').toBe(idle);
    await page.evaluate(() => { opBusy = true; }); // as while a run is in flight
    await expect.poll(() => throb.textContent(), { message: 'it spins while work is in flight' }).not.toBe(idle);
    await page.evaluate(() => { opBusy = false; });
    await expect(throb, 'and is blank again once the work is done').toHaveText('');
    await page.locator('.pbtn[data-pred="fails"]').click(); // Run becomes the call to action
    await expect(page.locator('#runbtn')).toHaveClass(/cta/);
    expect(await iters('#runbtn'), 'Run’s call to action pulses briefly, not forever').not.toBe('infinite');
  });

  test('a Termux call that fails at once leaves the throbber still', async ({ page }) => {
    // On a phone the throbber spins until Termux answers (termuxPending). A bridge
    // call that throws never answers, so it must not leave the spinner going.
    await page.addInitScript(() => {
      window.AndroidSeam = { termuxInstalled: () => true, runViaTermux: () => { throw new Error('no bridge'); } };
      try { localStorage.setItem('ts-mode', 'assist'); } catch (e) {} // no predict gate in the way
    });
    await page.route('**/api/run', (route) => route.abort()); // no server run: the on-device path
    await page.goto('/');
    await page.waitForFunction(() => curExercise !== null);
    await page.evaluate(() => runOp('run'));
    await expect(page.locator('#statusline'), 'the on-device path ran, and failed').toHaveText('error');
    await expect(page.locator('#throb'), 'nothing is in flight, so nothing spins').toHaveText('');
  });

  test('reduced motion: the completion popup still shows; busy work shows a still "…"', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto('/');
    await page.waitForSelector('#exTitle');
    // The .001ms guard used to jump the popup's fade straight to its opacity:0 end.
    await page.evaluate(() => celebrate('basics/next', 'Next one'));
    await page.waitForTimeout(200);
    const op = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('celebrate')).opacity));
    expect(op, 'the popup is shown, just without moving').toBeGreaterThan(0.9);
    await page.evaluate(() => { opBusy = true; });
    await expect(page.locator('#throb')).toHaveText('…');
    await ctx.close();
  });

  test('⋯ Reduce motion does in the app what the OS setting does, and is remembered', async ({ page }) => {
    // For a learner whose device has no reduce-motion setting, or who wants calm
    // only here: the same guard, from a checkbox in the ⋯ menu.
    await page.goto('/');
    await page.locator('#menuBtn').click();
    await page.locator('#motionChk').check();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
    const dur = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('predictbar')).animationDuration));
    expect(dur, 'the spotlight no longer pulses').toBeLessThan(0.01);
    await page.evaluate(() => celebrate('basics/next', 'Next one'));
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('celebrate')).opacity)),
      'the completion popup still shows').toBeGreaterThan(0.9);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
    await expect(page.locator('#motionChk')).toBeChecked();
  });

  test('finishing a whole phase fires a gold milestone celebration (once)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#exTitle');
    await page.evaluate(() => localStorage.removeItem('ts-phase-celebrated'));
    // The detector: a fully-done phase fires once then dedupes; a partial phase never does.
    const logic = await page.evaluate(() => {
      const allDone = { exercises: [{ id: 'x/a', status: 'done' }, { id: 'x/b', status: 'done' }] };
      const partial = { exercises: [{ id: 'y/a', status: 'done' }, { id: 'y/b', status: 'current' }] };
      return {
        first: maybeCelebratePhase(allDone, 'x'),
        again: maybeCelebratePhase(allDone, 'x'),
        partial: maybeCelebratePhase(partial, 'y'),
      };
    });
    expect(logic.first, 'a fully-done phase celebrates').toBe(true);
    expect(logic.again, 'the same phase never re-celebrates').toBe(false);
    expect(logic.partial, 'a partial phase does not celebrate').toBe(false);
    // The milestone popup is the distinct GOLD variant with a phase name.
    await page.evaluate(() => celebratePhase('control-flow'));
    const c = page.locator('#celebrate');
    await expect(c).toHaveClass(/milestone/);
    await expect(c.locator('.cg-h')).toHaveText(/Phase complete/);
    await expect(c.locator('.cg-s')).toContainText('Control Flow');
  });

  test('under reduced motion the completion popups still SHOW (they just do not move)', async ({ browser }) => {
    // The old reduced-motion fade ended at opacity 0, and the global guard's .001ms
    // durations jumped straight to that end, so these learners never saw the popup.
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto('/');
    await page.waitForSelector('#exTitle');
    const opacity = () => page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('celebrate')).opacity));
    await page.evaluate(() => celebrate('basics/next', 'Next one'));
    await page.waitForTimeout(200);
    expect(await opacity(), 'the exercise popup shows').toBeGreaterThan(0.9);
    await page.evaluate(() => celebratePhase('control-flow'));
    await page.waitForTimeout(200);
    expect(await opacity(), 'the phase milestone shows').toBeGreaterThan(0.9);
    await ctx.close();
  });

  test('nothing moves forever while idle: a still throbber, pulses that stop', async ({ page }) => {
    // WCAG 2.2.2: the terminal throbber spun at 11 frames a second with nothing
    // running, and the Run / prediction pulses looped forever beside the text.
    await page.goto('/');
    await page.locator('.exlist .ex[data-id]').first().waitFor();
    await page.waitForTimeout(120);
    const before = await page.locator('#throb').textContent();
    await page.waitForTimeout(450);
    expect(await page.locator('#throb').textContent(), 'the idle throbber is still').toBe(before);
    const loops = await page.evaluate(() => {
      const run = document.getElementById('runbtn'), bar = document.getElementById('predictbar');
      run.classList.add('cta'); bar.classList.add('needs-answer');
      return [getComputedStyle(run).animationIterationCount, getComputedStyle(bar).animationIterationCount];
    });
    expect(loops, 'Run and prediction pulse counts').not.toContain('infinite');
  });
});
