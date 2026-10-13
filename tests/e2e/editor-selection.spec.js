// Selected code must stay readable (WCAG 1.4.3). CM6's base theme paints the FOCUSED
// selection #d7d4f0 through a selector that out-ranked the app theme's, so selected
// dark-theme code sat at 1.3–2.4:1 (and keywords at 1.0:1 under the old unfocused
// --accent-soft), including the whole line an Assist/Dev "L#" jump selects.
const { test, expect } = require('@playwright/test');
const { ratio } = require('./contrast');

const EDITORS = [
  { label: 'Practice', host: '#cmhost', ide: false },
  { label: 'Sandbox / IDE', host: '#idehost', ide: true },
];

for (const theme of ['dark', 'light']) {
  for (const ed of EDITORS) {
    test(`selected code stays at least 4.5:1 in the ${ed.label} editor (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => {
        try { localStorage.setItem('ts-theme', t); localStorage.setItem('ts-mode', 'learn'); } catch (e) {}
      }, theme);
      await page.goto('/');
      await page.locator('.exlist .ex[data-id]').first().waitFor(); // the exercise's code is in
      if (ed.ide) await page.evaluate(() => showView('sandbox'));
      await page.locator(`${ed.host} .cm-line span`).first().waitFor(); // ...and highlighted
      // Focused, as after typing or an "L#" jump: the state CM6's base theme painted.
      await page.evaluate((ide) => {
        const v = ide ? ideView : cmView;
        v.focus();
        v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
      }, ed.ide);
      await expect(page.locator(`${ed.host} .cm-editor`), 'measured while focused: the rule that painted #d7d4f0').toHaveClass(/cm-focused/);
      await page.locator(`${ed.host} .cm-selectionBackground`).first().waitFor();
      const { bg, fgs } = await page.evaluate((h) => ({
        bg: getComputedStyle(document.querySelector(`${h} .cm-selectionBackground`)).backgroundColor,
        fgs: [...new Set([...document.querySelectorAll(`${h} .cm-line, ${h} .cm-line span`)]
          .map((e) => getComputedStyle(e).color))],
      }), ed.host);
      for (const fg of fgs) {
        expect(ratio(fg, bg), `${fg} on the selection ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}
