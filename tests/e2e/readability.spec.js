// Regression guard for the reading controls (Paul 2026-07-07, #41: make the
// textbooks more readable). A ⋯-menu A−/A+ stepper scales the reading text (the
// Book, lessons, the lesson drawer — everything that renders into .bookbody —
// and the Practice task, code, output and Insights) via the --read-scale CSS
// variable, clamped and persisted; a Spacing stepper adds room between lines,
// words and letters. This is pure GUI/localStorage and easy for a refactor to
// silently break.
const { test, expect } = require('@playwright/test');

test.describe('Reading size', () => {
  test('scales long-form text, persists across reload, and clamps', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('ts-read-scale'));
    await page.evaluate(() => showView('lessons', '15-ownership'));
    await page.waitForSelector('.bookbody p');
    const base = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.bookbody p')).fontSize));
    expect(base).toBeCloseTo(15.5, 1); // the tuned default

    // Two steps up → the reading text and the % label both grow; state persists.
    await page.evaluate(() => { setReadScale(1); setReadScale(1); });
    const bigger = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.bookbody p')).fontSize));
    expect(bigger).toBeGreaterThan(base);
    await expect(page.locator('#rsVal')).toHaveText('130%');
    expect(await page.evaluate(() => localStorage.getItem('ts-read-scale'))).toBe('1.3');

    // Headings and code examples scale WITH the prose. They were fixed px, so from
    // 115% up an h2 rendered smaller than the paragraph under it.
    const at130 = await page.evaluate(() => {
      const px = (s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize);
      return { p: px('.bookbody p'), h2: px('.bookbody h2'), code: px('.bookbody pre code') };
    });
    expect(at130.h2, 'an h2 stays larger than body text').toBeGreaterThan(at130.p);
    expect(at130.code, 'code examples grow with the text').toBeGreaterThan(12.5);

    // Persistence: after a reload the larger size is restored.
    await page.reload();
    await page.evaluate(() => showView('lessons', '15-ownership'));
    await page.waitForSelector('.bookbody p');
    const afterReload = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.bookbody p')).fontSize));
    expect(afterReload).toBeCloseTo(bigger, 1);

    // Clamp: hammering "smaller" never drops below the smallest step (layout-safe).
    await page.evaluate(() => { for (let i = 0; i < 12; i++) setReadScale(-1); });
    expect(await page.evaluate(() => localStorage.getItem('ts-read-scale'))).toBe('0.85');
    // ...and "larger" never exceeds the largest step.
    await page.evaluate(() => { for (let i = 0; i < 12; i++) setReadScale(1); });
    expect(await page.evaluate(() => localStorage.getItem('ts-read-scale'))).toBe('1.5');
  });

  test('Practice text follows the size too; the one-row toolbar keeps its size', async ({ page }) => {
    // The stepper used to reach only .bookbody: on the Practice screen, where a
    // learner spends most of their time, its % changed and nothing else did.
    await page.goto('/');
    await page.waitForFunction(() => curExercise !== null); // the exercise is on screen
    const sizes = () => page.evaluate(() => Object.fromEntries(
      ['#lessonTitle', '#predictProse', '.cm-content', '#conout', '#tutorbox', '#runbtn', '#statusline']
        .map((s) => [s, parseFloat(getComputedStyle(document.querySelector(s)).fontSize)])));
    const base = await sizes();
    await page.evaluate(() => { setReadScale(1); setReadScale(1); }); // 130%
    const big = await sizes();
    for (const s of ['#lessonTitle', '#predictProse', '.cm-content', '#conout', '#tutorbox']) {
      expect(big[s], `${s} grows with the reading size`).toBeGreaterThan(base[s]);
    }
    for (const s of ['#runbtn', '#statusline']) {
      expect(big[s], `${s} keeps its size: on a phone the toolbar is one row`).toBe(base[s]);
    }
  });

  test('Spacing adds room between lines, words and letters (not in code), and is remembered', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => showView('lessons', '15-ownership'));
    await page.waitForSelector('.bookbody p');
    const read = () => page.evaluate(() => {
      const n = (v) => parseFloat(v) || 0; // "normal" spacing reads as 0
      const p = getComputedStyle(document.querySelector('.bookbody p'));
      const code = getComputedStyle(document.querySelector('.bookbody pre code'));
      return { lh: n(p.lineHeight), ws: n(p.wordSpacing), ls: n(p.letterSpacing), codeWs: n(code.wordSpacing) };
    });
    const base = await read();
    await page.locator('#menuBtn').click();
    await page.locator('#spUp').click();
    await page.locator('#spUp').click();
    await expect(page.locator('#spVal')).toHaveText('wider');
    const wide = await read();
    expect(wide.lh, 'more space between lines').toBeGreaterThan(base.lh);
    expect(wide.ws, 'more space between words').toBeGreaterThan(base.ws);
    expect(wide.ls, 'more space between letters').toBeGreaterThan(base.ls);
    expect(wide.codeWs, 'code keeps its columns: no word spacing there').toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('ts-read-space'))).toBe('2');
    await page.reload();
    await page.evaluate(() => showView('lessons', '15-ownership'));
    await page.waitForSelector('.bookbody p');
    expect((await read()).lh, 'restored after a reload').toBeCloseTo(wide.lh, 1);
  });
});
