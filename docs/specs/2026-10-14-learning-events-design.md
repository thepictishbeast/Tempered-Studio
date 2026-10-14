# Learning events: an on-device record and an opt-in export

Status: **design, for Paul's review.** Nothing is built yet.

Why now: the Tools Competition entry, submitted 2026-10-13, promises this for Phase II (invitations 2026-11-24). Its Learning Engineering answer says:

> Each exercise attempt is a precise learning event: the learner's prediction, the exact compiler error codes hit, which hints they opened and in what order, retries, time to a working fix, and later recall in spaced review. We will record these as structured events on the device and add opt-in, consent-gated export: data is de-identified on the device and leaves it only if the learner chooses to share.

## Goals

1. **Record the learning loop on the device.**
   - Use typed events, one per step of the loop in `docs/EDUCATION.md`: Predict, Run, Compare, Guide, Explain, Retry, Recall.
   - Store them in a plain file next to `progress.json`, offline like everything else.
2. **Let the learner see, delete or turn off the record**, in the GUI and the CLI.
3. **Share only on an explicit act.**
   - A consent screen shows the exact file.
   - The file is de-identified on the device before it is written.
   - The learner shares it themselves. The app never uploads anything.

## Not recorded, ever

- Source code, and any text from compiler messages (only the error codes).
- What the learner types at Diagnose, or anything else written in free text.
- File paths, user names, machine or network details.

## The events

One JSON object per line in `~/.rustlings-pro/events.jsonl`. Each line has:
- `v`: the schema version, 1;
- `t`: the event type;
- `at`: UTC, whole seconds;
- `ex`: the exercise id, for example `ownership/01_move`, where it applies.

| `t` | Fields | When |
|---|---|---|
| `start` | `ex` | An exercise is opened. |
| `predict` | `ex`, `compiles` (bool), `code` (optional, the predicted error code) | A prediction is locked before a run. |
| `run` | `ex`, `passed` (bool), `codes` (error-level codes in order, at most 10), `expected` (the exercise's code) | Each real toolchain run. |
| `hint` | `ex`, `rung` (1 to 4) | A hint rung is shown. |
| `explain` | `ex`, `code` | The official explanation is opened. |
| `done` | `ex`, `runs`, `secs` | The first clean run: runs and seconds since `start`. |
| `recall` | `code`, `overcome` (bool), `box` (0 to 5) | A spaced-review outcome. |

The existing state (`Progress`, `ReviewState`, the hint ladder) is unchanged. Events are a parallel, append-only record of the same moments.

## Storage

- **Appending:** one write per line, so an interrupted write can't corrupt earlier lines.
- **Size:** capped at 5 MB. At the cap, recording stops and says so; it never deletes on its own.
- **Off switch:** `config.toml` gets `learning_record = true|false`. When it is false, nothing is written.

## Export

- **Where:** `rpro record export` in the CLI, and a "Share my learning record" screen in the GUI.
- **Consent screen:**
  - says in plain words what the file contains and what it doesn't;
  - previews the first lines;
  - keeps Export disabled until the learner ticks a consent box.
- **Output:** the learner picks a folder, and the app writes `tempered-learning-record-<random>.jsonl` there.

De-identification happens on the device:
- **Allowlist:** each event type's listed fields are copied, nothing else. A field added in the future can't leak by default.
- **Times:** turned into seconds since the record's first event. No calendar dates leave the device.
- **ID:** each export gets a new random id, so separate exports can't be linked. A study that needs to follow one learner over time would need the learner to choose "keep the same id"; that is off by default.
- **Content ids:** exercise ids and error codes are course content, not personal data.

A format document for researchers (`docs/learning-record-format.md`) describes every field.

## Sensitive data: learning differences

The entry also asks whether plain-language explanations help learners with learning differences. Display settings such as reading size, calmer motion and the dyslexia-friendly mode can stand in for a disability. So:
- they are **not** part of the default export;
- the consent screen offers a second, separate opt-in, "include my display settings", with its own explanation;
- no diagnosis or self-description is ever asked for or recorded.

## Tests

- Each loop action emits exactly one event of the right type (`rpro-state` unit tests, `rpro-serve` API tests).
- A run on real compiler output that contains source text produces an event with codes only.
- An unknown field in a log line never reaches an export.
- With recording off, nothing is written.
- No network use: the crate has no network dependencies, and `deny.toml` enforces that.
- GUI, headless (`scripts/e2e.sh`): the consent screen shows the preview; Export stays disabled until consent; the screen works by keyboard and screen reader.

## Questions for Paul

1. Recording on the device by default, which I recommend (nothing leaves the device; the learner can turn it off), or off until the learner turns it on?
2. A new random id per export by default: OK?
3. Do you want a standard format such as xAPI? The plan is our documented JSON lines, with an xAPI mapping later if Phase II asks for one.

## Plan after approval

1. `rpro-state`: the events module (types, writer, allowlisted export), with tests.
2. Emit events at the loop points in `rpro-serve` (GUI) and `rpro-tui`/`rpro-cli`.
3. GUI: a learning-record view and the consent and export screen, with accessibility and an e2e run.
4. The format document for researchers.

Estimate: one to two focused days.
