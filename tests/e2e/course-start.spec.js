// Walkthrough 2026-10-13 (#2, #12): a brand-new learner must open on the exercise
// Lesson 1 teaches (E0384, "cannot assign twice"), not the use-before-init one
// (E0381) that no lesson mentions, and Practice must name exercises by TITLE and
// course position, never by the `phase/NN_name` id: that id is a stable progress
// key whose number is not the learning order (it read a current "08" above a
// locked "01"). Read-only (selects nothing), so it is safe beside the other specs.
const { test, expect } = require('@playwright/test');

// A raw exercise id used as a label, e.g. basics/08_use_before_init.
const ID_LABEL = /\b[a-z][a-z-]*\/\d+[a-z]?_\w+/;
const text = async (loc) => (await loc.textContent()) || '';

test.describe('Course start: Lesson 1 first, titles not ids', () => {
  test('the course opens on the exercise Lesson 1 teaches', async ({ request }) => {
    const { exercises } = await (await request.get('/api/exercises')).json();
    expect(exercises[0].id, 'first in course order: the E0384 exercise').toBe('basics/01_immutable_assign');
    expect(exercises[1].id, 'then the E0381 one').toBe('basics/08_use_before_init');
  });

  test('Practice and lesson links show titles + position, never path ids', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#exlist .ex[data-id]');
    await expect(page.locator('#lessonSub')).toContainText(/^Exercise \d+ of \d+/);
    for (const sel of ['#exlist', '#lessonSub', '#editorBar']) {
      expect(await text(page.locator(sel)), `${sel} shows no raw id`).not.toMatch(ID_LABEL);
    }
    await page.evaluate(() => showView('lessons', '01-bindings-and-immutability'));
    await page.waitForSelector('#docview .lessonpractice .practicelink');
    await expect(page.locator('#docview .practicelink').first())
      .toHaveAttribute('data-id', 'basics/01_immutable_assign');
    expect(await text(page.locator('#docview .lessonpractice'))).not.toMatch(ID_LABEL);
  });

  // Lesson 2 had no exercise of its own: its Practice card offered nothing for
  // the lesson's one pitfall (a `mut` binding keeps its type, E0308).
  test('Lesson 2 practises its own pitfall, right after Lesson 1', async ({ page, request }) => {
    const { exercises } = await (await request.get('/api/exercises')).json();
    expect(exercises[2].id, "third in course order: Lesson 2's").toBe('basics/02b_mut_keeps_its_type');
    await page.goto('/');
    await page.waitForSelector('#exlist .ex[data-id]');
    await page.evaluate(() => showView('lessons', '02-mutability'));
    await page.waitForSelector('#docview .lessonpractice .practicelink');
    await expect(page.locator('#docview .practicelink').first())
      .toHaveAttribute('data-id', 'basics/02b_mut_keeps_its_type');
  });

  // Lesson 22c (pub structs keep their fields private) had no exercise either.
  test("Lesson 22c's Practice card opens its constructor exercise", async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#exlist .ex[data-id]');
    await page.evaluate(() => showView('lessons', '22c-pub-structs-enums'));
    await page.waitForSelector('#docview .lessonpractice .practicelink');
    await expect(page.locator('#docview .practicelink').first())
      .toHaveAttribute('data-id', 'modules/03b_pub_struct_constructor');
  });

  // Lesson 34b (operator overloading) had no exercise while the impl-Add one
  // pointed back at Lesson 25, which only mentions `Add` in passing.
  test("Lesson 34b's Practice card opens the impl-Add exercise", async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#exlist .ex[data-id]');
    await page.evaluate(() => showView('lessons', '34b-operator-overloading'));
    await page.waitForSelector('#docview .lessonpractice .practicelink');
    await expect(page.locator('#docview .practicelink').first())
      .toHaveAttribute('data-id', 'advanced/04_operator_overload_add');
  });

  // Lessons 33, 33b, 29b, 26b and 21b had no exercises.
  for (const [lesson, id] of [
    ['33-refutability', 'advanced/04b_refutable_parameter'],
    ['33b-guards-bindings-nested', 'advanced/04c_guards_not_counted'],
    ['29b-deref-drop', 'smart-pointers/06b_box_needs_star'],
    ['26b-lifetime-elision', 'lifetimes/08b_elision_one_in_one_out'],
    ['21b-modules', 'modules/00_nested_module_path'],
  ]) {
    test(`${lesson}'s Practice card opens ${id}`, async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('#exlist .ex[data-id]');
      await page.evaluate((l) => showView('lessons', l), lesson);
      await page.waitForSelector('#docview .lessonpractice .practicelink');
      await expect(page.locator('#docview .practicelink').first()).toHaveAttribute('data-id', id);
    });
  }
});
