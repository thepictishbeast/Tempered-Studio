// Regression guard for the motion-polish pass (Paul 2026-07-07, #40: "fun and
// cool and modern … animations"). Two properties matter and both are easy for a
// refactor to break: (1) the delight cues exist — the XP bar fills smoothly, a
// view fades in, a level-up pulses the chip; (2) they ALL collapse under
// prefers-reduced-motion, so the app stays usable/accessible for opt-outs.
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
});
