# Tempered Studio learner walkthrough, 2026-10-13 (headless Chrome, fresh store)

## Findings
1. Icons render as empty boxes without system emoji fonts: the streak badge
   (U+1F525, element font-family Arial, emoji font not in its stack) and the
   copy buttons (U+29C9, a math symbol no bundled font covers). Other emoji
   (U+1F4DD, U+1F4DA, U+1F52E, U+1F512) render from the bundled subset.
2. First exercise shown is basics/08_use_before_init (current) while
   basics/01_immutable_assign is locked below it: file numbering vs course
   order reads as broken to a beginner; the path labels (basics/08_...) are
   developer-facing.
3. Prediction: clicking "fails" locks the guess at once, so the "error code?"
   box disappears before a learner can type the code (the layout puts the box
   after the buttons, inviting button-first).
4. Readability: after a failed compile the output panel is scrolled to the
   bottom, so the learner first sees "help: consider assigning a value"; the
   error line itself (error[E0381]: used binding `count` isn't initialized)
   is out of view, while the tutor says "read the terminal top-to-bottom".
5. Explain (?): opens a native browser prompt() asking the learner to type the
   error code. In Learn mode lastCode is never set (diagnostics deliberately
   not parsed), so the prompt is always empty, though the code (E0381) is on
   screen. A blocking native dialog is also poor on mobile.
6. After Explain, the status badge reads "passed" and the terminal "✓ passed
   in 20ms": the explain op succeeded, the exercise did not. Misleading.
7. The explanation is rustc --explain's raw Markdown in the terminal (``` fences
   visible), scrolled to the bottom so its first lines are out of view.
8. Prediction re-graded after the fix: predicted "fails" on the original code
   (shown "outcome: right"); after the learner fixed it and pressed Check the
   banner turned to "✗ you said it fails, it passed". Grade the first run of
   the unmodified code, once.
9. Check vs Run: after Check (cargo check) passes, the tutor says "✓ Solved —
   it compiles and runs" but nothing was run and progress stays 0/91; only Run
   records completion. Either Check should not claim "runs", or Check should
   record completion when the exercise is a compile-only one.
10. After auto-advancing, the new exercise shows a stale "advanced ✓" status
   badge and the previous exercise's output.
11. The Hint button's icon and the Lesson tab's icon are also empty boxes
   (same cause as 1); the lesson drawer's code "Copy" buttons use U+29C9 too.
12. Course order vs lesson text: the first exercise a new learner gets is
   basics/08 (use before init, E0381); the next lesson says "Lesson 1 showed
   that a name is locked by default (E0384)", which the learner has not seen.
Mobile (390x844): stacked layout works and the error-code box sits on its own
line; the "Lesson" side tab overlaps the left edge of the prediction box.

Works well: real rustc output with colors, the predict-first flow, the
Insights panel (diagnostics, book refs, tutor), the lesson drawer over the
exercise without losing the editor, auto-advance with a completion message,
keyboard shortcut bar.
