// The lesson DRAWER (#lessonDrawerBody) is the "read a lesson while you code"
// panel that slides over the Practice tab. It reuses the same rendered markup as
// the Learn tab (inline `code`, code blocks, ▷ Run + ⧉ Copy toolkit, glossary
// tap-to-define), but it is NOT inside `.docview` — so the rich-text CSS has to
// list `.ldrawer-body` explicitly. That's fragile: a stray refactor of the
// `.docview …` selectors would silently strip the drawer back to unstyled prose
// (inline code with a transparent background + the browser's default monospace,
// naked code blocks, default-chrome buttons). This spec pins the styling down.
const { test, expect } = require('@playwright/test');

async function openDrawer(page) {
  await page.goto('/');
  await page.waitForSelector('#exTitle');
  await page.evaluate(() => openLessonDrawer('01-bindings-and-immutability', 'Bindings'));
  await page.waitForSelector('#lessonDrawerBody .lessonbody');
  await page.waitForTimeout(300); // async terms + linkify + wire toolkit
}

test.describe('Lesson drawer: rich-text parity with the Learn tab', () => {
  test('inline code is a styled chip (real bg + monospace), never plain prose', async ({ page }) => {
    await openDrawer(page);
    const styled = await page.evaluate(() => {
      const body = document.getElementById('lessonDrawerBody');
      const code = body.querySelector('p code, :not(pre) > code');
      if (!code) return { found: false };
      const cs = getComputedStyle(code);
      const bg = cs.backgroundColor;
      // "transparent" / rgba(...,0) means the .docview rule never reached us.
      const opaque = bg !== 'transparent' && !/,\s*0\s*\)$/.test(bg) && bg !== 'rgba(0, 0, 0, 0)';
      return {
        found: true,
        opaque,
        mono: /mono|Fira|Cascadia|Menlo|Consol|monospace/i.test(cs.fontFamily),
      };
    });
    expect(styled.found, 'the lesson has inline code to style').toBe(true);
    expect(styled.opaque, 'inline code has a non-transparent chip background').toBe(true);
    expect(styled.mono, 'inline code uses a monospace font').toBe(true);
  });

  test('code blocks and the ▷ Run / ⧉ Copy toolkit render (styled), matching the Learn tab', async ({ page }) => {
    await openDrawer(page);
    const info = await page.evaluate(() => {
      const body = document.getElementById('lessonDrawerBody');
      const pre = body.querySelector('pre');
      const preBg = pre ? getComputedStyle(pre).backgroundColor : null;
      const preBorder = pre ? getComputedStyle(pre).borderTopWidth : null;
      const runBtn = body.querySelector('.coderun-btn');
      const runRadius = runBtn ? getComputedStyle(runBtn).borderRadius : null;
      const copy = body.querySelector('.codecopy');
      const copyPos = copy ? getComputedStyle(copy).position : null;
      return {
        hasPre: !!pre, preBg, preBorder,
        hasRun: !!runBtn, runRadius,
        hasCopy: !!copy, copyPos,
      };
    });
    expect(info.hasPre, 'the lesson has a code block').toBe(true);
    expect(info.preBg, 'code block has a filled background (not transparent)').not.toBe('rgba(0, 0, 0, 0)');
    expect(info.preBorder, 'code block has a border').not.toBe('0px');
    expect(info.hasRun, 'a ▷ Run button is wired into the drawer').toBe(true);
    expect(info.runRadius, 'the Run button carries the styled pill radius').toBe('8px');
    expect(info.hasCopy, 'a ⧉ Copy button is wired into the drawer').toBe(true);
    expect(info.copyPos, 'the Copy button is absolutely positioned in the corner').toBe('absolute');
  });

  // Regression: the drawer HEADER must show the lesson's real title (matching the
  // content), not the exercise's hyphenated concept slug. It used to read e.g.
  // "Explicit-numeric-conversion" over a lesson actually titled "The scalar types".
  test('header shows the real lesson title (matches content), not the concept slug', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#lessonDrawerBody', { state: 'attached' });
    // Pass a deliberately-wrong slug as the title hint; the drawer must ignore it
    // and head itself with the LESSON's own title, stripped of inline markdown.
    await page.evaluate(() => openLessonDrawer('02-mutability', 'wrong-concept-slug'));
    await page.waitForSelector('#lessonDrawerBody .lessonbody');
    await page.waitForTimeout(300);
    const { header, bodyH } = await page.evaluate(() => ({
      header: document.getElementById('lessonDrawerTitle').textContent.trim(),
      bodyH: (document.querySelector('#lessonDrawerBody .lessonbody h1, #lessonDrawerBody .lessonbody h2') || {}).textContent?.trim() || '',
    }));
    expect(header, 'the slug hint must NOT be used as the header').not.toBe('wrong-concept-slug');
    expect(header, 'header is the real lesson title').toContain('Mutability');
    expect(header, 'header matches the rendered body heading exactly').toBe(bodyH);
  });

  // Regression: basics/02_annotation_needed (E0282 "type annotations needed") must
  // open the scalar-types lesson that teaches `let x: i32`, NOT the advanced
  // generics lesson it used to be mis-mapped to.
  test('an exercise opens the lesson that actually teaches it', async ({ page, request }) => {
    await request.post('/api/select', { data: { id: 'basics/02_annotation_needed', force: true } });
    await page.goto('/');
    await page.waitForSelector('#exTitle');
    await page.evaluate(() => openLessonDrawer(curLessonId, curLessonTitle));
    await page.waitForSelector('#lessonDrawerBody .lessonbody');
    await page.waitForTimeout(300);
    const header = await page.evaluate(() => document.getElementById('lessonDrawerTitle').textContent.trim());
    expect(header, 'points at the scalar-types lesson').toContain('scalar types');
    expect(header, 'NOT the generics lesson').not.toContain('Generic');
  });

  test('glossary tap-to-define works inside the drawer, and never inside code', async ({ page }) => {
    await openDrawer(page);
    const defs = page.locator('#lessonDrawerBody .glossdef');
    await expect(defs.first(), 'at least one term got linked in the drawer').toBeVisible();
    const inCode = await page.evaluate(() =>
      [...document.querySelectorAll('#lessonDrawerBody .glossdef')]
        .filter((el) => el.closest('code,pre,a,h1,h2,h3,h4,h5,h6')).length);
    expect(inCode, 'no term linked inside code/link/heading').toBe(0);
    await defs.first().click();
    const pop = page.locator('#lessonDrawerBody .glosspop');
    await expect(pop).toBeVisible();
    await expect(pop).not.toBeEmpty();
  });

  test('keyboard: opening moves focus into the lesson; Escape hands it back', async ({ page }) => {
    // The drawer sits BEFORE <main> in the DOM, so focus left on its opener never
    // reached the lesson by Tab (WCAG 2.4.3). It moves in, and comes back on close.
    await page.goto('/');
    const handle = page.locator('#lessonHandle');
    await expect(handle).toBeVisible(); // every exercise has a lesson
    await handle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#lessonDrawerBody'), 'focus is in the lesson').toBeFocused();
    await page.keyboard.press('Escape');
    await expect(handle, 'and back on the tab that opened it').toBeFocused();
  });
});
