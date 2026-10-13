// The IDE explorer told done / current / not-yet files apart only by a 7px dot's
// colour; the status words sit in title and aria-label, which sighted touch and
// keyboard users never see (WCAG 1.4.1). Locked rows already add a lock; current
// rows now add ▸ and done rows ✓, as the exercise list does, beside the name, so a
// long name is cut short before the glyph, never the glyph itself. The done dot was
// the dark theme's #36c46b in both themes: 2.3:1 on the light sidebar (1.4.11 wants
// 3:1).
const { test, expect } = require('@playwright/test');
const { ratio } = require('./contrast');

test('IDE explorer: current and done rows carry a glyph a long name cannot cut; the done dot holds 3:1 (light)', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('ts-theme', 'light'); } catch (e) {} });
  await page.goto('/');
  await page.evaluate(() => showView('ide'));
  await page.locator('.ide-file.st-current').first().waitFor({ state: 'attached' });
  const r = await page.evaluate(() => {
    const after = (el) => getComputedStyle(el, '::after').content;
    // A done row as ideRenderTree builds it (a fresh store has none yet), named like
    // the course's longest files: about a third are long enough to be cut short.
    const done = document.createElement('button');
    done.className = 'ide-file st-done';
    done.innerHTML = '<span class="ide-dot"></span><span class="ide-fname">05_question_mark_option_in_result.rs</span>';
    document.getElementById('idetreelist').appendChild(done);
    const name = done.querySelector('.ide-fname'), cs = getComputedStyle(done);
    return {
      current: after(document.querySelector('.ide-file.st-current')),
      done: after(done),
      cut: name.scrollWidth > name.clientWidth,
      // The room between the cut name and the row's padding: where the ✓ sits.
      room: done.getBoundingClientRect().right - parseFloat(cs.paddingRight)
        - parseFloat(cs.borderRightWidth) - name.getBoundingClientRect().right,
      dot: getComputedStyle(done.querySelector('.ide-dot')).backgroundColor,
      side: getComputedStyle(document.getElementById('idetree')).backgroundColor,
    };
  });
  expect(r.current, 'the current file is marked ▸').toContain('▸');
  expect(r.done, 'a done file is marked ✓').toContain('✓');
  expect(r.cut, 'the long name is cut short (else the next check proves nothing)').toBe(true);
  expect(r.room, 'the ✓ keeps its own room beside the cut name').toBeGreaterThan(5);
  expect(ratio(r.dot, r.side), `the done dot ${r.dot} on the sidebar ${r.side}`).toBeGreaterThanOrEqual(3);
});
