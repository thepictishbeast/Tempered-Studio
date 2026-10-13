// Accessibility audit of the web surface (the "a11y" half of #12), via axe-core
// driven through the same Playwright Chromium. Hard gate: zero CRITICAL or SERIOUS
// WCAG 2 A/AA violations. Moderate/minor issues are logged as findings, not failures.
//
// Covers the main Practice view AND the content surfaces built out since — the
// Lessons list (Continue CTA + filter), an open lesson (book cross-links + Tutor-
// adjacent chrome), the offline Library list, and the Book TOC — so an a11y
// regression in any of them is caught, not just on the landing screen.
//
// EVERY view is audited in BOTH themes: dark is the default everyone verifies
// against; light was never audited until it shipped defects, so it now has the
// same permanent gate. The theme is applied via the app's own persistence
// (localStorage ts-theme, read at boot).
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

/** Run axe on the current DOM; log every violation, return the blocking ids. */
async function blockingViolations(page, label) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  for (const v of violations) {
    console.log(`  [${label}] a11y [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node(s))`);
    if (v.impact === 'critical' || v.impact === 'serious') {
      for (const n of v.nodes.slice(0, 8)) {
        console.log(`      @ ${n.target}  ::  ${(n.html || '').replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
  }
  return violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => v.id);
}

/** Settle the UI for auditing: reduced motion (collapses the fade-in so axe never
 *  composites a mid-fade opacity into its contrast math) + the requested theme. */
async function prep(page, theme) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('ts-theme', t);
      // Audit the DEFAULT (Learn) tier deterministically — a prior spec may have
      // left ts-mode=assist/dev, so pin it here (Assist has its own test below).
      localStorage.setItem('ts-mode', 'learn');
    } catch (e) {}
  }, theme);
}

for (const theme of ['dark', 'light']) {
  test.describe(`a11y (${theme} theme)`, () => {
    test(`main view — no critical or serious violations`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.locator('#exTitle').waitFor();
      await page.locator('.exlist .ex').first().waitFor(); // exercise list populated
      expect(await blockingViolations(page, `main/${theme}`), 'main view').toEqual([]);
    });

    test(`Lessons list + an open lesson`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.evaluate(() => showView('lessons'));
      await page.locator('.continuecta, .booktoc li').first().waitFor();
      expect(await blockingViolations(page, `lessons-list/${theme}`), 'lessons list').toEqual([]);
      await page.locator('.lessonjump').first().click();
      await page.locator('.lessonback').waitFor();
      expect(await blockingViolations(page, `lesson-open/${theme}`), 'open lesson').toEqual([]);
    });

    test(`offline Library list`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.evaluate(() => showView('library'));
      await page.locator('.libopen').first().waitFor();
      expect(await blockingViolations(page, `library/${theme}`), 'library list').toEqual([]);
    });

    test(`Book table of contents`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.evaluate(() => showView('book'));
      await page.locator('.booktoc li, .bookjump').first().waitFor();
      expect(await blockingViolations(page, `book-toc/${theme}`), 'book toc').toEqual([]);
    });

    test(`Quizzes list`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.evaluate(() => showView('quizzes'));
      await page.locator('.quizjump').first().waitFor();
      expect(await blockingViolations(page, `quizzes/${theme}`), 'quizzes list').toEqual([]);
    });

    test(`Glossary (search + term cards)`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.evaluate(() => showView('glossary'));
      await page.locator('.gloss-term').first().waitFor();
      expect(await blockingViolations(page, `glossary/${theme}`), 'glossary').toEqual([]);
    });

    test(`Journey / roadmap`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.evaluate(() => showView('roadmap'));
      await page.locator('.roadphase').first().waitFor();
      expect(await blockingViolations(page, `roadmap/${theme}`), 'roadmap').toEqual([]);
    });

    test(`the 📚 Learn hub`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.evaluate(() => showView('learn'));
      await page.locator('.hubcard').first().waitFor();
      expect(await blockingViolations(page, `learn-hub/${theme}`), 'learn hub').toEqual([]);
    });

    test(`the 🧪 Sandbox (routes into the IDE scratch view)`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.evaluate(() => showView('sandbox'));
      await page.locator('#idehost .cm-editor, #idehost textarea').waitFor();
      expect(await blockingViolations(page, `sandbox/${theme}`), 'sandbox').toEqual([]);
    });

    test(`the 🛠 IDE`, async ({ page }) => {
      await prep(page, theme);
      await page.goto('/');
      await page.evaluate(() => showView('ide'));
      await page.locator('.ide-file').first().waitFor();
      expect(await blockingViolations(page, `ide/${theme}`), 'ide').toEqual([]);
    });
  });
}

// Assist/Dev keep the predict bar OPERABLE (an optional guess), so it must meet AA
// there too: it used to be dimmed to opacity .55 (label 3.0:1 dark / 2.2:1 light,
// buttons 3.8:1 light). This init script runs after prep()'s Learn pin.
for (const theme of ['dark', 'light']) {
  test(`a11y (${theme} theme) — main view in Assist mode`, async ({ page }) => {
    await prep(page, theme);
    await page.addInitScript(() => { try { localStorage.setItem('ts-mode', 'assist'); } catch (e) {} });
    await page.goto('/');
    await page.locator('.exlist .ex').first().waitFor();
    await expect(page.locator('#predictbar')).toBeVisible();
    expect(await blockingViolations(page, `main-assist/${theme}`), 'main view, Assist').toEqual([]);
  });
}
