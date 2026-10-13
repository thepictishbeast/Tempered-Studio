#!/usr/bin/env node
// Tempered Studio — web GUI pure-function tests (no browser needed).
//
// `gui/index.html` carries two pure transforms that are easy to get subtly
// wrong and security-sensitive: `esc`-then-`mdToHtml` (markdown → safe HTML)
// and `highlightRust` (syntax-highlight an ALREADY-ESCAPED Rust code block).
// This extracts those functions straight out of the shipped HTML (so the test
// tracks the real code, not a copy), writes them to a throwaway ES module, and
// imports it — no eval / new Function. Run with `node scripts/test-gui.mjs`.
//
// The load-bearing invariant for the highlighter is XSS-safety by construction:
// it must only ever INSERT fixed-class <span> wrappers, never alter any other
// character — so stripping the spans returns the exact input. That single
// property guarantees a <script> escaped upstream stays inert.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'gui', 'index.html'), 'utf8');

// Step 0 — the WHOLE app <script> must parse. The per-function tests below only
// import mdToHtml/highlightRust; this guards the rest (showView, renderBook,
// event wiring) against a syntax error slipping in. `node --check` parses without
// executing, so browser globals (document/window/fetch) are irrelevant.
{
  const m = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).find(s => s.includes('function mdToHtml'));
  if (!m) { console.log('  FAIL — could not find the app <script> block'); process.exit(1); }
  const d = mkdtempSync(join(tmpdir(), 'ts-gui-chk-')), p = join(d, 'app.js');
  writeFileSync(p, m);
  try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); }
  catch (e) { console.log('  FAIL — app <script> has a syntax error:\n' + (e.stderr || e).toString()); process.exit(1); }
  finally { rmSync(d, { recursive: true, force: true }); }
}

// Pull a `function NAME(...) { ... }` body out of the HTML by brace-matching.
function grabFn(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find function ' + name + ' in gui/index.html');
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { i++; break; }
  }
  return html.slice(start, i);
}

// Re-declare the tiny dependencies the two functions close over (kept in sync
// with gui/index.html; trivial + asserted indirectly by the tests below), then
// the real extracted bodies. Written to a temp module and imported.
const deps = [
  "const esc = s => (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');",
  "const RS_KW = /^(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|union|unsafe|use|where|while)$/;",
  "const RS_PRIM = /^(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str)$/;",
].join('\n');
const moduleSrc = deps + '\n' + grabFn('highlightRust') + '\n' + grabFn('mdToHtml') +
  '\n' + grabFn('hlLines') + '\n' + grabFn('cleanBookMarkdown') +
  '\nexport { esc, highlightRust, mdToHtml, hlLines, cleanBookMarkdown };\n';

const dir = mkdtempSync(join(tmpdir(), 'ts-gui-'));
const modPath = join(dir, 'gui-extract.mjs');
writeFileSync(modPath, moduleSrc);
let mod;
try { mod = await import(pathToFileURL(modPath).href); }
finally { rmSync(dir, { recursive: true, force: true }); }
const { esc, highlightRust, mdToHtml, hlLines, cleanBookMarkdown } = mod;

let fails = 0;
const ok = m => console.log('  ok   — ' + m);
const bad = m => { console.log('  FAIL — ' + m); fails++; };
const check = (cond, m) => cond ? ok(m) : bad(m);
const stripSpans = s => s.replace(/<span class="tok-[a-z]">/g, '').replace(/<\/span>/g, '');

console.log('== Tempered Studio — GUI transform tests ==');

// 1. THE invariant: highlighting only inserts spans; strip them → the input.
for (const sample of [
  'fn main() { let mut n: i32 = 42; println!("{n}"); }',
  'let v: Vec<&str> = vec!["a", "b"]; // a comment with fn let mut',
  'struct Point { x: f64, y: f64 }',
  'match x { Some(v) => v, None => 0 }',
  '/* block fn comment */ let s = "string with \\" quote and < > &";',
  "let c = 'a'; let lifetime: &'static str = \"hi\";",
]) {
  const e = esc(sample);
  check(stripSpans(highlightRust(e)) === e, 'strip(spans) === escaped input  [' + sample.slice(0, 32) + '…]');
}

// 2. Keywords / types / numbers / macros actually get classed.
const h = highlightRust(esc('fn main() { let n: i32 = 42; println!("hi"); }'));
check(h.includes('<span class="tok-k">fn</span>'), 'keyword `fn` → tok-k');
check(h.includes('<span class="tok-k">let</span>'), 'keyword `let` → tok-k');
check(h.includes('<span class="tok-t">i32</span>'), 'primitive `i32` → tok-t');
check(h.includes('<span class="tok-n">42</span>'), 'number `42` → tok-n');
check(h.includes('<span class="tok-m">println!</span>'), 'macro `println!` → tok-m');
check(highlightRust(esc('struct Foo;')).includes('<span class="tok-t">Foo</span>'), 'CamelCase `Foo` → tok-t');

// 3. A keyword inside a string / comment is NOT separately wrapped.
const inStr = highlightRust(esc('let s = "fn let mut";'));
check((inStr.match(/tok-s/g) || []).length === 1 && !inStr.includes('"<span'),
      'keyword inside a string literal is not re-tokenized');
const inCmt = highlightRust(esc('// fn let mut struct'));
check((inCmt.match(/tok-c/g) || []).length === 1 && !/tok-k/.test(inCmt),
      'keyword inside a comment is not re-tokenized');

// 4. XSS: an HTML tag inside a fenced code block is neutralised by escape-first.
//    Using a neutral `<b>` tag — if `<` is escaped, EVERY tag (incl. <script>)
//    is inert, so this proves the guarantee for the whole fenced path.
const md = '```rust\nlet x = "<b>not bold</b>";\n```';
const out = mdToHtml(md);
check(!out.includes('<b>') && out.includes('&lt;b&gt;'), 'fenced HTML tag stays inert (escape-first)');
check(out.includes('<pre><code>') && out.includes('<span class="tok-k">let</span>'),
      'fenced block is highlighted inside <pre><code>');

// 5. Entities pass through intact (a Rust reference `&str` survives).
const ref = highlightRust(esc('let r: &str = "x";'));
check(ref.includes('&amp;') && ref.includes('<span class="tok-t">str</span>'), 'reference `&str` → &amp; intact + str typed');

// 6. Inline emphasis (_x_ / *x*) → <em>, GFM-intraword-safe, escape-first.
check(mdToHtml('A _variable_ binds a value.').includes('<em>variable</em>'), '`_x_` → <em>');
check(mdToHtml('This is *very* important.').includes('<em>very</em>'), '`*x*` → <em>');
check(mdToHtml('Two _key_ _terms_ here.').includes('<em>key</em>') && mdToHtml('Two _key_ _terms_ here.').includes('<em>terms</em>'),
      'two emphases on one line both wrap');
// 6a. A hard-wrapped bullet: the continuation source line joins the SAME <li>
//     instead of dropping to a stray left-margin <p> (Paul 2026-07-04 — lesson
//     bullets hard-wrap at ~80 cols and the 2nd line looked disconnected).
const wrapB = mdToHtml('- It points at the first assignment,\n  then at the reassignment.');
check((wrapB.match(/<li>/g) || []).length === 1 && !/<\/ul>\s*<p>/.test(wrapB)
      && wrapB.includes('first assignment,') && wrapB.includes('then at the reassignment'),
      'wrapped bullet continuation joins its <li>, not a stray paragraph');
// 6b. …but a BLANK line still ends the list (continuation merges only when there
//     is no blank between) — the paragraph after must stay a real <p>.
const wrapEnd = mdToHtml('- lone item\n\nA following paragraph.');
check(/<\/ul>/.test(wrapEnd) && /<p>A following paragraph\.<\/p>/.test(wrapEnd),
      'a blank line still terminates the list');
const snake = mdToHtml('Call to_string and read foo_bar_baz now.');
check(!snake.includes('<em>') && snake.includes('to_string') && snake.includes('foo_bar_baz'),
      'intraword snake_case is NOT italicised');
const codeEm = mdToHtml('Use `a_b_c` carefully.');
check(codeEm.includes('<code>a_b_c</code>') && !codeEm.includes('<em>'), 'underscores inside `code` are not italicised');
const bothBI = mdToHtml('A **bold** and an _em_ word.');
check(bothBI.includes('<strong>bold</strong>') && bothBI.includes('<em>em</em>'), 'bold and italic coexist (bold not eaten by em)');
const emXss = mdToHtml('danger _<b>x</b>_ here');
check(!emXss.includes('<b>') && emXss.includes('<em>') && emXss.includes('&lt;b&gt;'), 'emphasis content stays escaped (no raw tag)');

// 7. Headings h1–h6 (corpus uses through h4); each carries a slug id.
check(mdToHtml('# Title').includes('<h1 id="title">Title</h1>'), '`# x` → <h1> (with id)');
check(mdToHtml('### Sub').includes('<h3 id="sub">Sub</h3>'), '`### x` → <h3> (with id)');
check(mdToHtml('#### Deeper').includes('<h4 id="deeper">Deeper</h4>'), '`#### x` → <h4> (was literal before)');
check(mdToHtml('###### Deepest').includes('<h6 id="deepest">Deepest</h6>'), '`###### x` → <h6>');
check(!mdToHtml('#nospace heading').includes('<h1'), '`#nospace` (no space) is NOT a heading');

// 7b. cleanBookMarkdown strips mdBook HTML-comment artifacts. Because mdToHtml
// esc()apes `<` before parsing, an un-stripped `<!-- … -->` renders as LITERAL
// visible text (e.g. "…Sized Trait <!-- ignore --> in Chapter 20"), not an
// invisible comment. The Book's 182 editorial comments used to leak this way.
{
  const inlineSrc = 'Prose [label]<!-- ignore --> after.';
  const inlineHtml = mdToHtml(cleanBookMarkdown(inlineSrc));
  check(!/&lt;!--/.test(inlineHtml) && !inlineHtml.includes('ignore'),
    'cleanBookMarkdown drops an inline `<!-- ignore -->` (no literal comment leaks)');
  const blockSrc = '# T\n\n<!-- Old headings. Do not remove. -->\n\nBody.';
  const blockHtml = mdToHtml(cleanBookMarkdown(blockSrc));
  check(!blockHtml.includes('Old headings') && blockHtml.includes('Body.'),
    'cleanBookMarkdown drops a bare `<!-- … -->` line but keeps the prose');
  const multiSrc = 'A<!--\nmulti\nline\n-->B';
  check(!/&lt;!--/.test(mdToHtml(cleanBookMarkdown(multiSrc))),
    'cleanBookMarkdown drops a multi-line comment too');
}

// 8. GFM tables (the ch03 integer-types table renders as a real <table>).
const tbl = mdToHtml('| Length | Signed |\n|--------|--------|\n| 8-bit | `i8` |\n| 16-bit | `i16` |');
check(tbl.includes('<table>') && tbl.includes('</table>'), 'pipe table → <table>');
check((tbl.match(/<th>/g) || []).length === 2, 'header row → 2 <th>');
check((tbl.match(/<tr>/g) || []).length === 3, 'header + 2 body rows → 3 <tr>');
check(tbl.includes('<td><code>i8</code></td>'), 'table cells are inline-rendered (`i8` → <code>)');
check(!tbl.includes('<p>|'), 'table is not left as literal pipe paragraphs');
const tblXss = mdToHtml('| H |\n|---|\n| <b>x</b> |');
check(!tblXss.includes('<b>') && tblXss.includes('&lt;b&gt;'), 'table cell content stays escaped');
const notTbl = mdToHtml('costs are a | b in prose');
check(!notTbl.includes('<table>') && notTbl.includes('<p>'), 'a stray pipe with no separator row is NOT a table');

// 9. Heading slug ids (so book_ref anchors can scroll to the cited section).
check(mdToHtml('### The Rules of References').includes('<h3 id="the-rules-of-references">'),
      'heading → GitHub-style slug id (matches an authored anchor)');
const useId = mdToHtml('## Bringing Paths into Scope with the `use` Keyword');
check(useId.includes('id="bringing-paths-into-scope-with-the-use-keyword"'),
      'slug drops backticks/punctuation (matches the `use`-keyword anchor)');
const idMatch = mdToHtml('#### Mutable References').match(/id="([^"]*)"/);
check(idMatch && /^[a-z0-9_-]*$/.test(idMatch[1]), 'slug id is attribute-safe ([a-z0-9_-] only)');
// `<T>` headings: esc → &lt;/&gt;, which the slug must STRIP (else `arclttgt`),
// so the GitHub-style anchor `the-api-of-mutext` resolves.
check(mdToHtml('### The API of Mutex<T>').includes('id="the-api-of-mutext"'),
      'angle-bracket heading slug strips entities (Mutex<T> → the-api-of-mutext)');

// 10. hlLines — the line-number splitter behind the editor gutter. The
// tokenizer emits spans that CROSS newlines (block comments, multi-line
// strings); hlLines must repair the split so every per-line block is
// tag-balanced, or the overlay renders garbage and misaligns the caret.
{
  const cl = (h) => h.match(/<span class="cl">/g)?.length ?? 0;
  // Per split segment, the `.cl` wrapper's own opener was consumed by the split
  // but its CLOSER remains → a balanced line has closes = inner opens + 1.
  const balanced = (h) => h.split('<span class="cl">').slice(1).every(seg =>
    (seg.match(/<\/span>/g) || []).length === (seg.match(/<span /g) || []).length + 1);
  const three = hlLines('let a = 1;\nlet b = 2;\nlet c = 3;');
  check(cl(three) === 3, 'hlLines: one .cl block per logical line');
  const blockComment = hlLines('/* one\n   two */\nlet x = 1;');
  check(cl(blockComment) === 3, 'hlLines: block comment still one .cl per line');
  check(balanced(blockComment), 'hlLines: spans repaired across a multi-line block comment');
  check(blockComment.split('<span class="cl">')[2].includes('tok-c'),
        'hlLines: the reopened continuation line keeps the comment class');
  const mlString = hlLines('let s = "one\ntwo";');
  check(balanced(mlString), 'hlLines: spans repaired across a multi-line string');
  const withEmpty = hlLines('let a = 1;\n\nlet b = 2;');
  check(cl(withEmpty) === 3 && withEmpty.includes('​'),
        'hlLines: an empty line keeps a row (ZWSP), not a collapsed block');
  // XSS-safety is inherited: stripping ALL spans + the ZWSP returns the input,
  // so hlLines (like highlightRust) never alters a character of the code.
  const rt = 'fn main() {\n    let x = "a<b>&c";\n}';
  const stripped = hlLines(rt)
    .replace(/<span class="[^"]*">/g, '').replace(/<\/span>/g, '')
    .split('​').join('')
    .split('\n').join(''); // .cl blocks carry no \n — lines are block-separated
  check(stripped === esc(rt).split('\n').join(''), 'hlLines: strip-everything round-trips (XSS-safe by construction)');
  // Gutter error marks: an optional Set of 1-based lines flags `.cl err` —
  // exactly those lines, nothing else.
  const marked = hlLines('a\nb\nc', new Set([2]));
  check((marked.match(/<span class="cl err">/g) || []).length === 1
        && marked.split('<span class="cl')[2].startsWith(' err'),
        'hlLines: marks flag exactly the given 1-based line');
  check(!hlLines('a\nb\nc').includes('cl err'), 'hlLines: no marks → no err classes');
}

// 11. The read→practice loop's integrity: EVERY exercise concept must resolve
// through CONCEPT_LESSON to a lesson file that exists, or that exercise loses
// its "📖 read the lesson" link SILENTLY (the same rot the concept→glossary
// guard in golden_corpus.rs exists for — this is its lesson-side twin; the map
// is hand-maintained JS that nothing else checks).
{
  const { readdirSync } = await import('node:fs');
  const root = join(here, '..');
  const block = (html.match(/const CONCEPT_LESSON = \{([\s\S]*?)\};/) || [])[1];
  check(!!block, 'CONCEPT_LESSON map present in the gui');
  const mapping = Object.fromEntries(
    [...(block || '').matchAll(/'([^']+)':\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
  const lessons = new Set(readdirSync(join(root, 'lessons'))
    .filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)));
  const concepts = new Set();
  for (const phase of readdirSync(join(root, 'exercises'))) {
    let files = [];
    try { files = readdirSync(join(root, 'exercises', phase)).filter(f => f.endsWith('.toml')); }
    catch { continue; } // non-dir entry
    for (const f of files) {
      const m = readFileSync(join(root, 'exercises', phase, f), 'utf8').match(/^concept\s*=\s*"([^"]+)"/m);
      if (m) concepts.add(m[1]);
    }
  }
  check(concepts.size >= 60, `found the exercise concept corpus (${concepts.size})`);
  const unmapped = [...concepts].filter(c => !(c in mapping)).sort();
  check(unmapped.length === 0,
    'every exercise concept has a lesson link' + (unmapped.length ? ` — UNMAPPED: ${unmapped.join(', ')}` : ''));
  const dangling = Object.entries(mapping).filter(([, t]) => !lessons.has(t)).sort();
  check(dangling.length === 0,
    'every CONCEPT_LESSON target exists in lessons/' + (dangling.length ? ` — DANGLING: ${dangling.map(([c, t]) => `${c}→${t}`).join(', ')}` : ''));
  // Concept → GLOSSARY resolution: every concept renders as a tappable definition
  // chip in Practice, so an unresolved one is a SILENT dead chip. golden_corpus.rs
  // guards this too, but it's NOT in the fast per-tick gate — which is how two dead
  // chips (duplicate-definition, dereference-non-reference) shipped unseen. Mirror
  // rpro-glossary::normalize (lowercase; collapse -/_/whitespace to one space;
  // trim — mirrors its split_whitespace().join(" ")) over term names AND aliases,
  // so this catches a dead chip per-tick without a cargo build. Keep this faithful
  // to the Rust: a looser norm here would false-green while golden_corpus.rs fails.
  const norm = s => s.toLowerCase().replace(/[-_\s]+/g, ' ').trim();
  const gloss = readFileSync(join(root, 'glossary', 'glossary.toml'), 'utf8');
  const glossKeys = new Set();
  for (const m of gloss.matchAll(/^\s*name\s*=\s*"([^"]+)"/gm)) glossKeys.add(norm(m[1]));
  for (const m of gloss.matchAll(/^\s*aliases\s*=\s*\[([^\]]*)\]/gm))
    for (const a of m[1].matchAll(/"([^"]+)"/g)) glossKeys.add(norm(a[1]));
  const deadChips = [...concepts].filter(c => !glossKeys.has(norm(c))).sort();
  check(deadChips.length === 0,
    'every exercise concept resolves in the glossary — no dead chip' + (deadChips.length ? ` — DEAD: ${deadChips.join(', ')}` : ''));
}

// 12. Icons need a BUNDLED font (walkthrough 2026-10-13 #1/#11: icons drew as
// empty boxes on a system with no emoji font). The GUI's emoji come from the
// vendored Noto subset, so (a) every emoji it uses must sit inside one of that
// sheet's unicode-ranges; (b) symbols NO bundled font covers stay out (⧉ U+29C9
// was the Copy icon, fullwidth ＋ U+FF0B needs a CJK font, ⛶ U+26F6 / ⤢ U+2922
// are the fullscreen symbols the IDE avoids); (c) form controls inherit the
// page's emoji-first stack (the UA sheet gives <button>/<input> a system font of
// their own), and no `font:` shorthand carries `inherit` among its values: that
// is invalid CSS, the whole declaration is dropped, and the lesson filter's 🔍
// fell back to the UA font that way. Which ELEMENTS really get the stack takes
// a browser: tests/e2e/icons.spec.js.
{
  const sheet = readFileSync(join(here, '..', 'gui', 'vendor', 'emoji', 'noto-emoji.css'), 'utf8');
  const ranges = [...sheet.matchAll(/unicode-range:([^;]+);/g)].flatMap(m => m[1].split(',').map(r => {
    const [a, b] = r.trim().slice(2).split('-').map(h => parseInt(h, 16));
    return [a, b ?? a];
  }));
  // An emoji = an astral pictograph, a default-emoji BMP symbol, or a symbol
  // forced to emoji style by a following VS16 (U+FE0F), like the level-up arrow.
  const chars = [...html], emoji = new Set();
  chars.forEach((ch, i) => {
    if (ch.codePointAt(0) >= 0x1F000 || /\p{Emoji_Presentation}/u.test(ch) || chars[i + 1]?.codePointAt(0) === 0xFE0F) emoji.add(ch);
  });
  const unbundled = [...emoji].filter(ch => !ranges.some(([a, b]) => ch.codePointAt(0) >= a && ch.codePointAt(0) <= b));
  check(emoji.size > 20 && unbundled.length === 0,
    `every emoji the GUI uses is in the bundled subset (${emoji.size})` + (unbundled.length ? ` — NOT BUNDLED: ${unbundled.join(' ')}` : ''));
  const noFont = [...new Set(chars.filter(ch => [0x29C9, 0xFF0B, 0x26F6, 0x2922].includes(ch.codePointAt(0))))];
  check(noFont.length === 0,
    'no symbol that no bundled font covers (⧉ ＋ ⛶ ⤢)' + (noFont.length ? ` — FOUND: ${noFont.join(' ')}` : ''));
  check(/button,\s*input,\s*select,\s*textarea\s*\{\s*font-family:\s*inherit;?\s*\}/.test(html),
    'form controls inherit the page font stack (button, input, select, textarea)');
  const badFont = [...html.matchAll(/(?<![-\w])font:\s*[^;{}\s][^;{}]*\sinherit\s*[;}]/g)].map(m => m[0]);
  check(badFont.length === 0,
    'no `font:` shorthand with `inherit` among its values' + (badFont.length ? ` — ${badFont.join(' | ')}` : ''));
}

console.log('');
if (fails === 0) console.log('GUI TRANSFORM TESTS PASS ✓');
else { console.log('GUI TRANSFORM TESTS FAILED: ' + fails); process.exit(1); }
