// Colour contrast in states the a11y gate never renders (WCAG 1.4.3): gradient
// labels (axe files gradients under "needs review"), a locked guess, progress-only
// states, the light theme's status colours on the surfaces they really sit on, and
// the Logs view. Each test names the colour that failed.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { ratio, stops, over } = require('./contrast');

/** Theme + the Learn tier, with motion reduced so axe never reads a mid-fade. */
async function prep(page, theme) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((t) => {
    try { localStorage.setItem('ts-theme', t); localStorage.setItem('ts-mode', 'learn'); } catch (e) {}
  }, theme);
}
const contrastViolations = async (page, sel) =>
  (await new AxeBuilder({ page }).include(sel).withRules(['color-contrast']).analyze()).violations.map((v) => v.id);
const ready = (page) => page.locator('.exlist .ex[data-id]').first().waitFor();

for (const theme of ['dark', 'light']) {
  test(`white labels hold 4.5:1 on every stop of the Run gradient (${theme})`, async ({ page }) => {
    // The dark theme's --accent → --accent-soft stops were 3.5:1 → 2.6:1. The
    // question box's OK and the Termux copy button wear the same gradient.
    await prep(page, theme);
    await page.goto('/');
    await ready(page);
    for (const id of ['runbtn', 'askok', 'tmxCopy']) {
      const { fg, image } = await page.evaluate((i) => {
        const cs = getComputedStyle(document.getElementById(i));
        return { fg: cs.color, image: cs.backgroundImage };
      }, id);
      expect(stops(image).length, `#${id} is a gradient`).toBeGreaterThanOrEqual(2);
      for (const s of stops(image)) expect(ratio(fg, s), `#${id}: ${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test(`the locked guess's "change" link passes contrast (${theme})`, async ({ page }) => {
    // No colour rule: it took the UA's #0000EE, 2.0:1 on the dark theme's tinted bar.
    await prep(page, theme);
    await page.goto('/');
    await ready(page);
    await page.locator('.pbtn', { hasText: 'fails' }).click();
    await page.locator('#predlock').click(); // the summary and its link show once the guess is locked
    await page.locator('#predictChange').waitFor();
    expect(await contrastViolations(page, '#predictChange')).toEqual([]);
  });

  test(`the Logs view passes contrast and names an error row's level (${theme})`, async ({ page }) => {
    // Tab counts at opacity .6 were 3.4:1 dark / 2.5:1 light; the light category on
    // the error tint 4.4:1; and only a 6% tint told an error row from an info row.
    await prep(page, theme);
    await page.goto('/');
    await page.locator('#exTitle').waitFor();
    await page.evaluate(() => { logEvent('ui', 'error', 'boom'); logEvent('ui', 'info', 'fine'); return showView('logs'); });
    await page.locator('.logrow.lv-error').first().waitFor();
    expect(await contrastViolations(page, '#docview')).toEqual([]);
    await expect(page.locator('.logrow.lv-error .logcat').first()).toContainText('error');
  });
}

// Light theme only: these colours were the dark theme's, hard-coded, or tuned on
// white (--bg-2) alone.
test.describe('light theme', () => {
  test.beforeEach(async ({ page }) => { await prep(page, 'light'); });

  test('a hot streak on the XP chip (#ff7a3c was 2.6:1)', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await page.evaluate(() => gamifyPaint({ bestDone: 0, streak: 3 })); // a 3-day streak is "hot"
    await expect(page.locator('#xpStreak')).toHaveClass(/hot/);
    expect(await contrastViolations(page, '#xpchip')).toEqual([]);
  });

  test('a fully read Journey stage (#36c46b was 2.1:1)', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await page.evaluate(async () => { // mark every lesson read, so every stage is complete
      const ls = (await fetch('api/lessons').then((r) => r.json())).lessons || [];
      localStorage.setItem('ts-lessons-read', JSON.stringify(ls.map((l) => l.id)));
      await showView('roadmap');
    });
    await page.locator('.roadprog.done').first().waitFor();
    expect(await contrastViolations(page, '.roadphase')).toEqual([]);
  });

  test('the gold phase-milestone heading (#e0a92e was 2.1:1)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#exTitle').waitFor();
    const c = await page.evaluate(() => {
      celebratePhase('control-flow');
      const card = getComputedStyle(document.getElementById('celebrate'));
      return { head: getComputedStyle(document.querySelector('#celebrate .cg-h')).color,
        image: card.backgroundImage, base: card.backgroundColor };
    });
    const [top, gold] = stops(c.image);
    // 19px / weight 800 is large text: 3:1.
    expect(ratio(c.head, top), `${c.head} on the card's top ${top}`).toBeGreaterThanOrEqual(3);
    expect(c.base, 'the gold tint sits on an opaque card, not on what the popup covers').toBe('rgb(255, 255, 255)');
    expect(ratio(c.head, over(gold, c.base)), `${c.head} on the gold end`).toBeGreaterThanOrEqual(3);
  });

  test('the XP toast (#1a1207 on --accent was 3.3:1)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#exTitle').waitFor();
    const t = await page.evaluate(() => {
      xpToast('Level 2!');
      const cs = getComputedStyle(document.getElementById('xptoast'));
      return { fg: cs.color, image: cs.backgroundImage };
    });
    expect(stops(t.image).length).toBeGreaterThanOrEqual(2);
    for (const s of stops(t.image)) expect(ratio(t.fg, s), `${t.fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  test('the prediction summary: --done on its green tint (was 4.4:1)', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await page.locator('.pbtn', { hasText: 'passes' }).click();
    await page.locator('#predlock').click();
    await page.locator('#predictDone').waitFor();
    expect(await contrastViolations(page, '#predictDone')).toEqual([]);
  });

  test('an earned badge: --done on --bg-3 (was 4.3:1)', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('ts-gamify', JSON.stringify({ bestDone: 1, lastDone: 1, streak: 1,
          lastActiveDay: null, lastLevel: 1, earned: ['first'] }));
      } catch (e) {}
    });
    await page.goto('/');
    await ready(page);
    await page.click('#xpchip');
    await page.locator('#xppanel .bgoal.earned').waitFor();
    expect(await contrastViolations(page, '#xppanel')).toEqual([]);
  });

  test('a [~] warning row: --warn on the page (was 4.4:1)', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await page.evaluate(() => {
      setMode('assist'); setInsights(true); // Learn withholds the parsed panel
      renderDiag({ diagnostics: [{ level: 'warning', code: null, message: 'unused variable', span: { line: 1 } }] });
    });
    await page.locator('#diag .diag.warn').waitFor();
    expect(await contrastViolations(page, '#diag')).toEqual([]);
  });
});
