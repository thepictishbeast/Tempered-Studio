// E2E for the IDE-first navigation (Paul 2026-07-02: "focus on the task and the
// IDE mostly with a way to quickly access … learning materials"). The top bar is
// exactly TWO tabs — Practice (the IDE) and 📚 Learn (a hub for every learning
// surface + progress). The old Lessons/Quizzes tabs + ⋯ More menu are gone; their
// destinations live in the hub. Also guards the ? shortcut overlay's click-through.
const { test, expect } = require('@playwright/test');

test.describe('IDE-first nav: Practice + the 📚 Learn hub', () => {
  test('exactly two tabs; the old tabs + More menu are gone', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tabs .tab[data-view]')).toHaveCount(2);
    await expect(page.locator('.tab[data-view="practice"]')).toBeVisible();
    await expect(page.locator('.tab[data-view="learn"]')).toBeVisible();
    // consolidated away:
    await expect(page.locator('.tab[data-view="lessons"]')).toHaveCount(0);
    await expect(page.locator('.tab[data-view="quizzes"]')).toHaveCount(0);
    await expect(page.locator('#moreBtn')).toHaveCount(0);
  });

  test('the Learn hub lists every surface + progress; a card navigates and keeps Learn active', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab[data-view="learn"]').click();
    // hub: progress line + the surface cards
    await expect(page.locator('.hubprog')).toContainText(/exercises/);
    const cards = page.locator('.hubcard');
    await expect(cards).toHaveCount(8); // lessons, journey, study guide, quizzes, cheatsheets, book, glossary, library
    await expect(page.locator('.hubcard[data-view="lessons"]')).toBeVisible();
    await expect(page.locator('.hubcard[data-view="book"]')).toBeVisible();
    await expect(page.locator('.hubcard[data-view="library"]')).toBeVisible();
    await expect(page.locator('.tab[data-view="learn"]')).toHaveClass(/active/);

    // a card opens its surface; the Learn tab stays active (it's a Learn sub-view)
    await page.locator('.hubcard[data-view="glossary"]').click();
    await expect(page.locator('.gloss-term').first()).toBeVisible();
    await expect(page.locator('.tab[data-view="learn"]')).toHaveClass(/active/);

    // Practice returns to the IDE
    await page.locator('.tab[data-view="practice"]').click();
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('.tab[data-view="practice"]')).toHaveClass(/active/);
  });
});

test.describe('lesson → phase cheatsheet cross-link', () => {
  test('a lesson carries a working "this phase\'s cheat sheet" companion link', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab[data-view="learn"]').click();
    await page.locator('.hubcard[data-view="lessons"]').click();
    // Target a PHASE lesson explicitly — the first lesson is now the hello-world
    // intro (no phase cheatsheet), so ".first()" would have no cheat link.
    const phaseLesson = page.locator('.lessonjump[data-id="01-bindings-and-immutability"]');
    await expect(phaseLesson).toBeVisible();
    await phaseLesson.click();
    const cheat = page.locator('.cheatlink');
    await expect(cheat).toBeVisible();
    await expect(cheat).toHaveAttribute('data-cheat', /^(phase\d|phase6-generics|tooling)$/);
    await cheat.click();
    await expect(page.locator('.cheatback')).toBeVisible();
    // cheatsheets is a Learn sub-view → the Learn tab stays lit
    await expect(page.locator('.tab[data-view="learn"]')).toHaveClass(/active/);
  });
});

test.describe('theme: OS preference on first visit, explicit choice wins after', () => {
  test('a light-mode OS gets the light theme with no saved choice', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('a saved choice beats the OS preference', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => { try { localStorage.setItem('ts-theme', 'dark'); } catch (e) {} });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('a dark-mode OS keeps the dark default', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('Android (seam present) ignores the OS preference — deterministic dark', async ({ page }) => {
    // The WebView's prefers-color-scheme reporting is undefined without
    // DayNight config, so the phone app must not gamble on it.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => { window.AndroidSeam = { marker: true }; });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('? keyboard-shortcuts overlay', () => {
  test('? opens the overlay and Escape closes it; it never blocks clicks when closed', async ({ page }) => {
    await page.goto('/');
    const help = page.locator('#keyshelp');
    await expect(help).toBeHidden();
    // Regression guard: a closed overlay must not intercept clicks.
    await page.locator('.tab[data-view="learn"]').click();
    await expect(page.locator('#docview')).toBeVisible();
    await page.keyboard.type('?');
    await expect(help).toBeVisible();
    await expect(help).toContainText(/shortcut/i);
    // The code editors keep Tab for indenting, so the help says how to leave them
    // (WCAG 2.1.2), and each editor carries that hint for screen readers too.
    await expect(help).toContainText('Leave the editor');
    await expect(page.locator('.cm-content')).toHaveAttribute('aria-describedby', 'cmKeysHint');
    await expect(page.locator('#cmKeysHint')).toHaveText(/press Escape, then Tab/);
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
  });
});
