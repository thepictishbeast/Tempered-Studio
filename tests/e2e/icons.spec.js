// Icons must never draw as empty boxes (walkthrough 2026-10-13, findings 1 + 11).
// The GUI's icons are emoji drawn from the bundled Noto Color Emoji subset
// (gui/vendor/emoji/noto-emoji.css), so they render offline on a system with no
// emoji font — but ONLY inside an element whose computed font-family names that
// family. <button>/<input> don't inherit font-family (the UA sheet gives them a
// system font of their own), which is how the streak 🔥, Hint 💡, Lesson tab 📖,
// theme 🌓 and the IDE's 📂 🖥 💾 🗑 became boxes while the same emoji in a <div>
// rendered; and the Copy buttons' ⧉ (U+29C9) is in no bundled font at all.
// These checks read the font STACK, not pixels, so they fail the same on a
// machine that happens to have a system emoji font. Read-only: nothing is run
// or selected, so the store is never written.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

// The bundled subset's coverage, read from the shipped stylesheet itself.
const SHEET = fs.readFileSync(path.join(__dirname, '..', '..', 'gui', 'vendor', 'emoji', 'noto-emoji.css'), 'utf8');
const RANGES = [...SHEET.matchAll(/unicode-range:([^;]+);/g)].flatMap((m) => m[1].split(',').map((r) => {
  const [a, b] = r.trim().slice(2).split('-').map((h) => parseInt(h, 16));
  return [a, b ?? a];
}));
// Symbols no bundled font covers and many systems lack too: they draw as boxes.
const NO_FONT = [0x29C9 /* ⧉ */, 0xFF0B /* ＋, CJK fonts only */, 0x26F6 /* ⛶ */, 0x2922 /* ⤢ */];

// Every element (hidden ones too) whose text would draw an icon as a box: a
// NO_FONT symbol, an emoji outside the bundled subset, or an emoji in a font
// stack that doesn't name the bundled family. Covers text nodes, placeholders
// and ::before/::after content.
function audit(page) {
  return page.evaluate(({ ranges, noFont }) => {
    const bundled = (cp) => ranges.some(([a, b]) => cp >= a && cp <= b);
    const bad = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (/^(SCRIPT|STYLE)$/.test(el.tagName)) continue;
      const runs = [[getComputedStyle(el).fontFamily,
        [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join('') + (el.placeholder || '')]];
      for (const p of ['::before', '::after']) {
        const cs = getComputedStyle(el, p);
        if (/^["']/.test(cs.content)) runs.push([cs.fontFamily, cs.content]);
      }
      const where = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
        + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      for (const [font, text] of runs) {
        const chars = [...text];
        chars.forEach((ch, i) => {
          const cp = ch.codePointAt(0);
          // astral pictograph, default-emoji BMP symbol, or forced emoji by VS16
          const emoji = cp >= 0x1F000 || /\p{Emoji_Presentation}/u.test(ch) || chars[i + 1]?.codePointAt(0) === 0xFE0F;
          if (noFont.includes(cp)) bad.push(`${where}: ${ch} (U+${cp.toString(16).toUpperCase()}) is in no bundled font`);
          else if (emoji && !bundled(cp)) bad.push(`${where}: ${ch} is not in the bundled emoji subset`);
          else if (emoji && !font.includes('Noto Color Emoji')) bad.push(`${where}: ${ch} is drawn in ${font}`);
        });
      }
    }
    return [...new Set(bad)];
  }, { ranges: RANGES, noFont: NO_FONT });
}

test('icons draw from a bundled font on every main surface (never an empty box)', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#exlist .ex[data-id]'); // the exercise list + current exercise loaded
  const stacks = {};       // icon control → its computed font stack
  const found = new Map(); // audit problem → the surface it first showed on
  const visit = async (surface, ...controls) => {
    for (const sel of controls) {
      stacks[sel] = await page.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? getComputedStyle(el).fontFamily : null;
      }, sel);
    }
    for (const p of await audit(page)) if (!found.has(p)) found.set(p, surface);
  };

  await visit('Practice', '#xpStreak', '#theme', '#hintbtn', '#lessonHandle', '#termcopy', '#tmxCopy', '#runErrorCopy');
  await page.evaluate(() => gamifyTogglePanel());
  await visit('XP panel');
  await page.evaluate(() => openLessonDrawer('01-bindings-and-immutability', 'Bindings'));
  await visit('lesson drawer', '#lessonDrawerBody .codecopy');
  await page.evaluate(() => showView('learn'));
  await visit('Learn hub', '#docview .continuecta');
  await page.evaluate(() => showView('lessons'));
  await visit('Lessons', '#docview .lessonfilter');
  await page.evaluate(() => showView('ide'));
  await visit('IDE', '#idefilesbtn', '#idefull', '#idesave', '#idedelete', '.ide-group-h .ide-grp-name');
  await page.evaluate(() => showView('logs'));
  await visit('Logs', '#logcopy');

  const offStack = Object.entries(stacks).filter(([, s]) => !(s && s.includes('Noto Color Emoji')))
    .map(([sel, s]) => `${sel}: ${s === null ? 'not on the page' : 'font stack is ' + s}`);
  expect(offStack, offStack.join('\n')).toEqual([]);
  const report = [...found].map(([p, surface]) => `${surface} › ${p}`);
  expect(report, report.join('\n')).toEqual([]);
});
