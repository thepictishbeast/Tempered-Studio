// Regression guard (walkthrough 2026-10-13, mobile): the 📖 Lesson pull-tab is
// position:fixed on the left edge, but on a phone the Practice view is ONE
// column that scrolls under it, so at 390x844 the tab sat over the prediction
// box's left edge, and the editor, terminal, exercise list and Insights each
// slid under it in turn. Phones now keep a strip as wide as the tab clear, so
// the check is scroll-proof: no panel may START left of the tab's right edge.
// Every pane is opened first (a display:none pane can't fail the check), the
// prediction box is hit-tested where the tab sits, and the toolbar the strip
// narrows must still fit a long status without wrapping ▷ Run, and must keep
// "passed" / "failed" whole. Read-only on the store: no select, no run.
const { test, expect } = require('@playwright/test');

const PANELS = ['main > .pane', '#exlist .ex', '#predictbar', '.editor', '.terminal', '#diag', '#tutorbox'];

for (const width of [320, 360, 390, 430]) {
  test(`phone ${width}px: the Lesson tab covers no panel`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.locator('#lessonHandle'), 'the tab shows (every exercise has a lesson)').toBeVisible();
    await page.click('#exTitle');     // open the exercise-list accordion
    await page.click('#insightsBtn'); // and the Insights pane
    await expect(page.locator('#exlist .ex').first()).toBeVisible();
    await expect(page.locator('#tutorbox')).toBeVisible();

    const r = await page.evaluate((sels) => {
      const tab = document.getElementById('lessonHandle');
      const t = tab.getBoundingClientRect();
      const missing = [], under = [];
      for (const sel of sels) {
        const els = [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length);
        if (!els.length) missing.push(sel);
        for (const el of els) {
          const x = el.getBoundingClientRect().left;
          if (x < t.right - 0.5) under.push(`${sel} @ x=${x.toFixed(1)}`);
        }
      }
      // The walkthrough's case: scroll the prediction box into the tab's band,
      // then see what a tap just inside the box's left edge lands on.
      const box = document.getElementById('predictbar');
      window.scrollBy(0, box.getBoundingClientRect().top - t.top);
      const b = box.getBoundingClientRect(), t2 = tab.getBoundingClientRect();
      const y = Math.max(b.top, t2.top) + 4;
      const hit = document.elementFromPoint(b.left + 2, y);
      return { tabRight: t.right, missing, under, inBand: y < Math.min(b.bottom, t2.bottom), hitsBox: !!hit && box.contains(hit) };
    }, PANELS);
    expect(r.missing, 'every panel is on the page (else the check proves nothing)').toEqual([]);
    expect(r.under, `nothing starts left of the tab's right edge (x=${r.tabRight})`).toEqual([]);
    expect(r.inBand, "the prediction box reached the tab's band").toBe(true);
    expect(r.hitsBox, "a tap at the box's left edge reaches the box, not the tab").toBe(true);

    // The strip narrows the editor toolbar: a long status (the same textContent
    // write the app makes on-device) must not wrap ▷ Run or run off the editor.
    const bar = await page.evaluate(() => {
      const st = document.getElementById('statusline'), run = document.getElementById('runbtn');
      st.textContent = 'ready';
      const before = run.getBoundingClientRect().height;
      st.textContent = 'explaining on-device…';
      return {
        runSame: run.getBoundingClientRect().height === before,
        inside: st.getBoundingClientRect().right <= document.querySelector('.editor').getBoundingClientRect().right - 0.5,
      };
    });
    expect(bar.runSame, '▷ Run stays on one line').toBe(true);
    expect(bar.inside, 'the status ends inside the editor (shortened with "…")').toBe(true);

    // ...but a narrower bar must not cut the outcome itself: "passed" and
    // "failed" stay whole (no "…"), even at 320px, and from 360px (most phones)
    // every status word does.
    const whole = await page.evaluate((w0) => {
      const st = document.getElementById('statusline');
      const words = ['passed', 'failed'].concat(w0 >= 360 ? ['compiles ✓', 'explained', 'explain ✗', 'ran ✓'] : []);
      return words.map((w) => { st.textContent = w; return st.scrollWidth <= st.clientWidth || w; });
    }, width);
    expect(whole.filter((x) => x !== true), 'status words are not cut short (from 360px: every status)').toEqual([]);
  });
}

test('desktop keeps its layout: no strip, list column intact, tab still shown', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('#lessonHandle')).toBeVisible();
  const d = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('main'));
    return { pad: cs.paddingLeft, cols: cs.gridTemplateColumns };
  });
  expect(d.pad, 'the strip is phone-only').toBe('0px');
  expect(d.cols.startsWith('248px'), `exercise-list column intact (${d.cols})`).toBe(true);
});
