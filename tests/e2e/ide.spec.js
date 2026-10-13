// Regression guard for the fullscreen IDE (Paul 2026-07-07). The redesign makes
// the file explorer PART of the IDE: a sidebar that sits BESIDE an always-visible
// editor, with a foldable terminal below it — NOT three mutually-exclusive tabs.
// You can browse and open files without ever losing sight of the editor. It stays
// a progress-neutral WORKSHOP over the course's exercise files: it must never leak
// an answer, never advance progress, and honour the same locked/done gates as
// Practice. These are render- + fetch-driven and easy to break silently.
const { test, expect } = require('@playwright/test');

test.describe('Fullscreen IDE', () => {
  test('opens from the ⋯ menu with explorer, editor AND terminal coexisting', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#exTitle');
    // Reachable via the ⋯ menu (NO third top tab — the 2-tab design is preserved).
    await expect(page.locator('.tab[data-view]')).toHaveCount(2);
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-file');
    // The explorer and the editor host are visible AT THE SAME TIME — the whole
    // point of the redesign. The terminal exists too (folded until you Run).
    await expect(page.locator('#idetree')).toBeVisible();
    await expect(page.locator('#idehost')).toBeVisible();
    await expect(page.locator('#ideterm')).toHaveClass(/closed/);
    // The explorer lists exercise sources, grouped by phase.
    expect(await page.locator('.ide-group').count()).toBeGreaterThan(1);
    expect(await page.locator('.ide-file').count()).toBeGreaterThan(10);
  });

  test('the explorer never renders answer-bearing files or metadata', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-file');
    const tree = await page.locator('#idetree').innerHTML();
    // Only .rs sources appear; the answer-bearing .toml files never do.
    expect(tree).not.toContain('.toml');
    expect(tree).not.toContain('solution_outline');
    expect(tree).not.toContain('expected_error_code');
    // EXERCISE rows (the only ones with data-id) are always .rs sources; free-play
    // scratch rows + the "New scratch" button are the learner's own UI, not sources.
    for (const name of await page.locator('.ide-file[data-id] .ide-fname').allInnerTexts()) {
      expect(name.trim()).toMatch(/\.rs$/);
    }
  });

  test('opening a file keeps the editor visible; toggling the explorer never hides it', async ({ page }) => {
    await page.goto('/');
    // Start clean so no previously-open file is restored.
    await page.evaluate(() => localStorage.removeItem('ts-ide-state'));
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-file');
    // Open the first file the server will actually serve (first exercise is
    // unlocked; skip any that answer 409 done / 423 locked).
    const openId = await page.evaluate(async () => {
      const d = await (await fetch('api/workspace')).json();
      const ids = d.groups.flatMap(g => g.files.map(f => f.id));
      for (const id of ids) {
        const s = (await fetch('api/workspace/file?id=' + encodeURIComponent(id))).status;
        if (s === 200) return id;
      }
      return null;
    });
    expect(openId, 'at least one exercise file opens').toBeTruthy();
    await page.evaluate((id) => ideOpenFile(id, null), openId);
    // The editor now holds the file AND the explorer is still beside it.
    await expect(page.locator('#idehost .cm-editor, #idehost textarea')).toBeVisible();
    await expect(page.locator('#idetree')).toBeVisible();
    await expect(page.locator('#ideopenname')).not.toHaveText(/no file open/);
    // Fold the explorer away — the editor must REMAIN visible (the old design
    // hid it; this is the exact regression Paul called out).
    await page.locator('#idefilesbtn').click();
    await expect(page.locator('#idetree')).toBeHidden();
    await expect(page.locator('#idehost .cm-editor, #idehost textarea')).toBeVisible();
    // Bring it back.
    await page.locator('#idefilesbtn').click();
    await expect(page.locator('#idetree')).toBeVisible();
  });

  test('terminal folds open/closed and fullscreen toggles, clearing on exit', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-file');
    // Terminal starts folded; its toggle opens it while the editor stays put.
    await expect(page.locator('#ideterm')).toHaveClass(/closed/);
    await page.locator('#idetermbtn').click();
    await expect(page.locator('#ideterm')).not.toHaveClass(/closed/);
    await expect(page.locator('#idehost')).toBeVisible();
    await page.locator('#idetermbtn').click();
    await expect(page.locator('#ideterm')).toHaveClass(/closed/);
    // Fullscreen adds the body class AND the IDE must actually FILL the viewport
    // (Paul: "the fullscreen ide isnt fullscreen"): the #docview overlay covers the
    // whole screen edge-to-edge, and the header is hidden.
    await page.locator('#idefull').click();
    expect(await page.evaluate(() => document.body.classList.contains('ide-full-on'))).toBe(true);
    const fill = await page.evaluate(() => {
      const r = document.getElementById('docview').getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), fills: Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight,
        headerHidden: getComputedStyle(document.querySelector('header')).display === 'none' };
    });
    expect(fill.fills, 'the IDE fills the whole viewport in fullscreen').toBe(true);
    expect(fill.top).toBe(0); expect(fill.left).toBe(0);
    expect(fill.headerHidden).toBe(true);
    // Leaving the IDE must remove it (so the hidden header can't bleed into another view).
    await page.evaluate(() => showView('practice'));
    expect(await page.evaluate(() => document.body.classList.contains('ide-full-on'))).toBe(false);
  });

  test('opening a locked file is gated behind a jump-ahead confirm', async ({ page }) => {
    await page.goto('/');
    // Find a file the SERVER actually gates (423). A file's tree *status* of
    // "locked" only means "no progress entry yet"; the real gate is is_unlocked
    // (a file opens once its predecessor is Done). So probe from the END — where
    // the unlock frontier can't have reached in these specs — for the first 423.
    const { lockedId, gatedStatus } = await page.evaluate(async () => {
      const d = await (await fetch('api/workspace')).json();
      const ids = d.groups.flatMap(g => g.files.map(f => f.id));
      for (let i = ids.length - 1; i >= 0; i--) {
        const s = (await fetch('api/workspace/file?id=' + encodeURIComponent(ids[i]))).status;
        if (s === 423) return { lockedId: ids[i], gatedStatus: s };
      }
      return { lockedId: null, gatedStatus: null };
    });
    expect(lockedId, 'some exercise is still behind the baby-steps gate').toBeTruthy();
    expect(gatedStatus).toBe(423);
    // In the UI, opening a gated file asks (in-page) to jump ahead; declining
    // it opens nothing (the open filename stays "no file open").
    await page.evaluate(() => localStorage.removeItem('ts-ide-state'));
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-file');
    expect(await page.locator('#ideopenname').textContent()).toContain('no file open');
    // Not awaited in the page: ideOpenFile waits until the question is answered.
    await page.evaluate((id) => { ideOpenFile(id, 'locked'); }, lockedId);
    await expect(page.locator('#askmsg')).toContainText('locked');
    await page.locator('#askno').click();
    await page.waitForTimeout(150);
    expect(await page.locator('#ideopenname').textContent()).toContain('no file open');
  });

  test('edits persist as an offline draft across reloads, and Reset restores the file', async ({ page }) => {
    // The IDE Save is a disk PUT that cannot reach the embedded server on mobile,
    // so unsaved edits used to vanish on close. A localStorage draft is the
    // offline safety net: it must survive a reload, and Reset must discard it.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-file');
    // Open the first file the server serves, then type a marker into the editor.
    const openId = await page.evaluate(async () => {
      const d = await (await fetch('api/workspace')).json();
      const ids = d.groups.flatMap(g => g.files.map(f => f.id));
      for (const id of ids) { if ((await fetch('api/workspace/file?id=' + encodeURIComponent(id))).status === 200) return id; }
      return null;
    });
    expect(openId).toBeTruthy();
    await page.evaluate((id) => ideOpenFile(id, null), openId);
    await page.waitForSelector('#idehost .cm-editor, #idehost textarea');
    await page.evaluate(() => window.ideView.dispatch({ changes: { from: 0, insert: '// DRAFT-MARK\n' } }));
    // The draft is persisted under a per-file key.
    expect(await page.evaluate((id) => localStorage.getItem('ts-ide-buf:' + id), openId)).toContain('// DRAFT-MARK');

    // Reload (proxy for app-close): the draft must come back in the editor.
    await page.goto('/');
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('#idehost .cm-editor, #idehost textarea');
    await page.waitForFunction(() => window.ideView && window.ideView.state.doc.toString().includes('// DRAFT-MARK'));

    // Reset discards the draft and reloads the on-disk content.
    await page.evaluate(() => ideReset());
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.ideView.state.doc.toString().includes('// DRAFT-MARK'))).toBe(false);
    expect(await page.evaluate((id) => localStorage.getItem('ts-ide-buf:' + id), openId)).toBeNull();
  });

  test('the tree folds by phase — a long list opens on the current phase; toggles persist', async ({ page }) => {
    // 76 exercise files across ~16 phases made the explorer a long scroll. Each
    // phase is now a collapsible group (header button + file-count badge); the
    // phase holding the CURRENT exercise stays open, the rest collapse, and an
    // explicit toggle is remembered (localStorage ts-ide-groups).
    await page.goto('/');
    await page.evaluate(() => { localStorage.removeItem('ts-ide-groups'); localStorage.removeItem('ts-ide-state'); });
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-group-h');
    // Every group is a header button carrying a count badge.
    const headers = page.locator('.ide-group-h');
    const nHeaders = await headers.count();
    expect(nHeaders, 'multiple phase groups').toBeGreaterThan(3);
    expect(await page.locator('.ide-grp-count').count(), 'a count badge per group').toBe(nHeaders);
    // Most groups start collapsed → far fewer rows are visible than exist.
    const total = await page.locator('.ide-file[data-id]').count();
    const visible = await page.locator('.ide-file[data-id]:visible').count();
    expect(total, 'all exercise files still render in the DOM').toBeGreaterThan(20);
    expect(visible, 'collapsed phases hide their rows').toBeLessThan(total);
    // The current exercise's row is in the open phase (visible without expanding).
    expect(await page.locator('.ide-file.st-current:visible').count()).toBe(
      await page.locator('.ide-file.st-current').count());
    // Clicking a collapsed group's header reveals its rows…
    const collapsedHeader = page.locator('.ide-group.collapsed .ide-group-h').first();
    await expect(collapsedHeader).toBeVisible();
    const before = await page.locator('.ide-file[data-id]:visible').count();
    await collapsedHeader.click();
    await expect.poll(() => page.locator('.ide-file[data-id]:visible').count()).toBeGreaterThan(before);
    // …and the choice persists across a reload.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('ts-ide-groups'))).toContain(':false');
  });

  test('opening a file reveals it even when its phase group is collapsed', async ({ page }) => {
    // A restored / jumped-ahead file can live inside a collapsed phase — its
    // highlight would be hidden behind the fold. Opening it must expand its group.
    await page.goto('/');
    await page.evaluate(() => { localStorage.removeItem('ts-ide-groups'); localStorage.removeItem('ts-ide-state'); });
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-group-h');
    const id = await page.evaluate(async () => {
      const d = await (await fetch('api/workspace')).json();
      const ids = d.groups.flatMap(g => g.files.map(f => f.id));
      for (const i of ids) { if ((await fetch('api/workspace/file?id=' + encodeURIComponent(i))).status === 200) return i; }
      return null;
    });
    expect(id, 'an openable exercise file exists').toBeTruthy();
    // Collapse the group holding it, and confirm its row is now hidden.
    const collapsed = await page.evaluate((fid) => {
      const row = [...document.querySelectorAll('.ide-file[data-id]')].find(el => el.dataset.id === fid);
      const grp = row.closest('.ide-group');
      grp.querySelector('.ide-group-h').click();
      return grp.classList.contains('collapsed');
    }, id);
    expect(collapsed, 'its group collapses').toBe(true);
    expect(await page.evaluate((fid) =>
      [...document.querySelectorAll('.ide-file[data-id]')].find(el => el.dataset.id === fid).offsetParent === null, id),
      'the row is hidden while folded').toBe(true);
    // Open the file → its group re-expands, the row is visible and marked open.
    await page.evaluate((fid) => ideOpenFile(fid, null), id);
    await page.waitForSelector('#idehost .cm-editor, #idehost textarea');
    const revealed = await page.evaluate((fid) => {
      const row = [...document.querySelectorAll('.ide-file[data-id]')].find(el => el.dataset.id === fid);
      return { open: !row.closest('.ide-group').classList.contains('collapsed'), visible: row.offsetParent !== null, marked: row.classList.contains('open') };
    }, id);
    expect(revealed.open, 'group re-expanded').toBe(true);
    expect(revealed.visible, 'row visible again').toBe(true);
    expect(revealed.marked, 'row highlighted as open').toBe(true);
  });

  test('the filter box jumps to files by name across every phase', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => { localStorage.removeItem('ts-ide-groups'); localStorage.removeItem('ts-ide-state'); });
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-group-h');
    const filter = page.locator('#idefilter');
    await expect(filter).toBeVisible();
    const totalGroups = await page.locator('.ide-group').count();
    // A token that matches exactly one file — it shows even if its phase was folded.
    await filter.fill('immutable');
    await expect.poll(async () => (await page.locator('.ide-file[data-id]:visible .ide-fname').allInnerTexts()).length).toBeGreaterThan(0);
    const names = await page.locator('.ide-file[data-id]:visible .ide-fname').allInnerTexts();
    expect(names.every(n => n.toLowerCase().includes('immutable')), 'only matching files show').toBe(true);
    // Phases with no match are hidden entirely.
    expect(await page.locator('.ide-group:visible').count(), 'non-matching phases hidden').toBeLessThan(totalGroups);
    // A nonsense query hides every file row.
    await filter.fill('zzzznotafile');
    await expect.poll(() => page.locator('.ide-file[data-id]:visible').count()).toBe(0);
    // Clearing restores the folded view — multiple phase headers visible again.
    await filter.fill('');
    await expect.poll(() => page.locator('.ide-group:visible').count()).toBeGreaterThan(1);
  });

  test('the fold-all button collapses / expands every phase and persists', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => { localStorage.removeItem('ts-ide-groups'); localStorage.removeItem('ts-ide-state'); });
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-group-h');
    const foldall = page.locator('#idefoldall');
    await expect(foldall).toBeVisible();
    const total = await page.locator('.ide-group').count();
    expect(await page.locator('.ide-group:not(.collapsed)').count(), 'some phase is open initially').toBeGreaterThan(0);
    // Collapse all → nothing open, no file rows visible (whole curriculum on one screen).
    await foldall.click();
    await expect.poll(() => page.locator('.ide-group:not(.collapsed)').count()).toBe(0);
    expect(await page.locator('.ide-file:visible').count(), 'all rows hidden when fully folded').toBe(0);
    // Expand all → every phase open.
    await foldall.click();
    await expect.poll(() => page.locator('.ide-group:not(.collapsed)').count()).toBe(total);
    // Collapse all again, reload → the folded state persists.
    await foldall.click();
    await page.goto('/');
    await page.evaluate(() => showView('ide'));
    await page.waitForSelector('.ide-group-h');
    expect(await page.locator('.ide-group:not(.collapsed)').count(), 'fold-all persisted across reload').toBe(0);
  });
});
