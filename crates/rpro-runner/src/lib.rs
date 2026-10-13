//! Exercise discovery + runner.
//!
//! v0 scope: walk the exercise directory, pair `.rs` files with
//! their `.toml` metadata, validate. The actual `cargo run`
//! integration (and parsing of compiler output back into a typed
//! `Outcome`) lands in v0.1; the structure here is the seam.

#![doc(html_no_source)]

use rpro_lang::{DiagLevel, Diagnostic};
use rpro_state::ExerciseMetadata;
use rpro_storage_fs::Store;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Bundled-content revision — the single source of truth every surface seeds
/// against (the web/desktop server, the CLI, and the TUI via the CLI store).
///
/// Bump this whenever the shipped `exercises/`, `book/`, `glossary/`, `lessons/`,
/// `quizzes/`, or `cheatsheets/` change in a way existing installs should pick
/// up (e.g. the "never hand the answer" exercise sweep, new glossary terms,
/// lesson rewrites). A store records the version it was seeded at in a
/// `.content-version` marker; a store whose marker is older re-copies the
/// read-only content dirs on next seed, so an already-seeded store isn't frozen
/// on its first-run copies. Progress is never touched by that refresh.
pub const CONTENT_VERSION: u32 = 61;

/// Errors during exercise discovery.
#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    /// I/O.
    #[error("{path}: {source}")]
    Io {
        /// Path that failed.
        path: String,
        /// Underlying error.
        #[source]
        source: std::io::Error,
    },
    /// TOML parse.
    #[error("{path}: {source}")]
    Toml {
        /// Path that failed.
        path: String,
        /// Underlying error.
        #[source]
        source: toml::de::Error,
    },
    /// Metadata validation rejected the exercise.
    #[error("{path}: {reason}")]
    Invalid {
        /// Path that failed.
        path: String,
        /// Reason.
        reason: String,
    },
    /// `.rs` file present without a sibling `.toml`.
    #[error("{path}: missing metadata sibling (every exercise needs a .toml)")]
    MissingMeta {
        /// `.rs` path with no metadata.
        path: String,
    },
}

/// One discovered exercise — file path + parsed metadata.
#[derive(Debug, Clone)]
pub struct Exercise {
    /// Path to the `.rs` file.
    pub source: PathBuf,
    /// Parsed metadata from the sibling `.toml`.
    pub meta: ExerciseMetadata,
}

/// Filesystem-safe slug for an exercise id (e.g. `ownership/01_move` →
/// `ownership_01_move`). Shared by every native surface so they all resolve the
/// same scratch run-directory for a given exercise.
#[must_use]
pub fn slug(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Discover every exercise under `root`. Sorted by id.
///
/// # Errors
/// First per-file failure: missing metadata, invalid TOML,
/// failed validation.
pub fn discover(root: &Path) -> Result<Vec<Exercise>, DiscoveryError> {
    let mut exercises = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }
        let toml_path = p.with_extension("toml");
        if !toml_path.exists() {
            return Err(DiscoveryError::MissingMeta {
                path: p.display().to_string(),
            });
        }
        let raw = std::fs::read_to_string(&toml_path).map_err(|e| DiscoveryError::Io {
            path: toml_path.display().to_string(),
            source: e,
        })?;
        let meta: ExerciseMetadata = toml::from_str(&raw).map_err(|e| DiscoveryError::Toml {
            path: toml_path.display().to_string(),
            source: e,
        })?;
        meta.validate().map_err(|reason| DiscoveryError::Invalid {
            path: toml_path.display().to_string(),
            reason,
        })?;
        exercises.push(Exercise {
            source: p.to_path_buf(),
            meta,
        });
    }
    // Sort by file path, not id: the `NN-phase/` directory prefix encodes the
    // intended learning order (01-basics → 02-control-flow → …), which the id
    // (e.g. "collections/…") does not.
    exercises.sort_by(|a, b| a.source.cmp(&b.source));
    Ok(exercises)
}

/// Remove stale copies of RENAMED bundled exercises from a seeded store.
///
/// Exercises are overlay-copied into a store (never cleared: a learner's own
/// exercises must survive a content refresh), so re-sequencing the course by
/// renaming a bundled file left the OLD file behind too — a ghost with the same
/// `id`. `discover` then listed that exercise twice, the course order interleaved,
/// and [`record_run`] advanced by position into the ghost. A store exercise is
/// stale when the bundle ships its `id` at a different relative path; ids the
/// bundle does not ship (the learner's own) are never touched. Best-effort: if
/// either tree fails to discover, nothing is removed.
///
/// # Errors
/// I/O failure removing a stale `.rs` / `.toml` pair.
pub fn prune_renamed(bundled: &Path, store: &Path) -> std::io::Result<()> {
    let (Ok(shipped), Ok(seeded)) = (discover(bundled), discover(store)) else {
        return Ok(());
    };
    for ex in seeded {
        // Where the bundle ships this id (ids are unique — the golden corpus pins it).
        let shipped_at = shipped
            .iter()
            .find(|b| b.meta.id == ex.meta.id)
            .and_then(|b| b.source.strip_prefix(bundled).ok());
        if shipped_at.is_some_and(|at| Some(at) != ex.source.strip_prefix(store).ok()) {
            std::fs::remove_file(&ex.source)?;
            std::fs::remove_file(ex.source.with_extension("toml"))?;
        }
    }
    Ok(())
}

/// The first *error*-level diagnostic code in a run's output — the wall the
/// learner is hitting right now. Warnings/notes and code-less diagnostics are
/// skipped. Pure (no I/O).
#[must_use]
pub fn primary_error_code(diags: &[Diagnostic]) -> Option<&str> {
    diags
        .iter()
        .find(|d| d.level == DiagLevel::Error && d.code.is_some())
        .and_then(|d| d.code.as_deref())
}

/// Record one finished run into on-disk progress — the single source of truth
/// every surface (web, TUI, CLI) shares, so they all advance and accrue spaced
/// repetition identically.
///
/// Bumps the attempt counter, folds the result into the review queue (via
/// `ReviewState::fold_run`), and — when `advance` is set (a passing Run/Test) —
/// marks `id` Done and promotes the next exercise in learning order that is not
/// already Done to Current (finished work is never re-opened).
/// Returns the id advanced to, if any. Best-effort: a failed load/save returns
/// `None` rather than erroring, so it never breaks a run. `discover` already
/// returns exercises in learning order, so no re-sort is needed here.
pub fn record_run(
    store: &Store,
    id: &str,
    diagnostics: &[Diagnostic],
    passed: bool,
    advance: bool,
) -> Option<String> {
    let mut progress = store.load_progress().unwrap_or_default();
    progress.record_attempt(id);
    let exs = discover(&store.root().join("exercises")).unwrap_or_default();
    let expected = exs
        .iter()
        .find(|e| e.meta.id == id)
        .and_then(|e| e.meta.expected_error_code.as_deref());
    progress
        .reviews
        .fold_run(expected, primary_error_code(diagnostics), passed);
    let mut advanced_to = None;
    if advance {
        progress.set_done(id);
        if let Some(pos) = exs.iter().position(|e| e.meta.id == id) {
            // Skip anything already Done: after a jump-ahead, or a re-sequence that
            // moved this exercise in front of finished ones, the positional next can
            // be Done — and `set_current` would re-open it (the done count drops).
            let next = exs[pos + 1..].iter().find(|e| {
                progress.entries.get(&e.meta.id).map(|p| p.status)
                    != Some(rpro_state::ExerciseStatus::Done)
            });
            if let Some(next) = next {
                progress.set_current(&next.meta.id);
                advanced_to = Some(next.meta.id.clone());
            }
        }
    }
    let _ = store.save_progress(&progress);
    advanced_to
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
    }

    #[test]
    fn discovers_a_well_formed_exercise() {
        let dir = tempfile::tempdir().unwrap();
        let rs = dir.path().join("ownership/01_move.rs");
        let toml = dir.path().join("ownership/01_move.toml");
        write(&rs, "// rustlings exercise body\nfn main() {}\n");
        write(
            &toml,
            r#"
id = "ownership/01_move"
title = "Move semantics"
difficulty = "beginner"
estimated_minutes = 8
concept = "move-semantics"

[[book_refs]]
chapter = "ch04-01-what-is-ownership"
why = "Ownership rules."
"#,
        );
        let exs = discover(dir.path()).unwrap();
        assert_eq!(exs.len(), 1);
        assert_eq!(exs[0].meta.id, "ownership/01_move");
    }

    #[test]
    fn missing_toml_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let rs = dir.path().join("orphan.rs");
        write(&rs, "fn main() {}");
        let err = discover(dir.path()).unwrap_err();
        assert!(matches!(err, DiscoveryError::MissingMeta { .. }));
    }

    #[test]
    fn invalid_toml_rejected() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("bad.rs"), "fn main() {}");
        write(&dir.path().join("bad.toml"), "not [valid toml :::");
        let err = discover(dir.path()).unwrap_err();
        assert!(matches!(err, DiscoveryError::Toml { .. }));
    }

    #[test]
    fn missing_book_refs_rejected() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("noref.rs"), "fn main() {}");
        write(
            &dir.path().join("noref.toml"),
            r#"
id = "x/no_refs"
title = "No refs"
difficulty = "beginner"
estimated_minutes = 1
concept = "x"
book_refs = []
"#,
        );
        let err = discover(dir.path()).unwrap_err();
        match err {
            DiscoveryError::Invalid { reason, .. } => assert!(reason.contains("book_refs")),
            other => panic!("wrong: {other:?}"),
        }
    }

    // Diagnostic codes below are fake non-E0 tokens on purpose: the seam gate
    // forbids the literal `E0xxx` outside crates/languages, and this is a runner.
    fn diag(code: &str) -> Diagnostic {
        Diagnostic {
            code: Some(code.into()),
            level: DiagLevel::Error,
            message: "m".into(),
            span: None,
        }
    }

    #[test]
    fn primary_error_code_picks_first_error_with_a_code() {
        let note = Diagnostic {
            code: Some("E4001".into()),
            level: DiagLevel::Note,
            ..diag("x")
        };
        let warn = Diagnostic {
            code: None,
            level: DiagLevel::Warning,
            ..diag("x")
        };
        let diags = vec![warn, note, diag("E4321"), diag("E4399")];
        assert_eq!(primary_error_code(&diags), Some("E4321"));
        assert_eq!(primary_error_code(&[]), None);
        let codeless = Diagnostic {
            code: None,
            ..diag("x")
        };
        assert_eq!(primary_error_code(&[codeless]), None);
    }

    // Two exercises in learning order; `01` teaches E4321.
    fn seed_two(root: &Path) -> Store {
        let ex = root.join("exercises/01-basics");
        write(&ex.join("01_first.rs"), "fn main() {}\n");
        write(
            &ex.join("01_first.toml"),
            "id = \"basics/01_first\"\ntitle = \"First\"\ndifficulty = \"beginner\"\n\
             estimated_minutes = 3\nconcept = \"first\"\nexpected_error_code = \"E4321\"\n\
             [[book_refs]]\nchapter = \"ch01\"\nwhy = \"x\"\n",
        );
        write(&ex.join("02_second.rs"), "fn main() {}\n");
        write(
            &ex.join("02_second.toml"),
            "id = \"basics/02_second\"\ntitle = \"Second\"\ndifficulty = \"beginner\"\n\
             estimated_minutes = 3\nconcept = \"second\"\n\
             [[book_refs]]\nchapter = \"ch01\"\nwhy = \"x\"\n",
        );
        let store = Store::at(root.to_path_buf());
        let mut p = rpro_state::Progress::default();
        p.set_current("basics/01_first");
        store.save_progress(&p).unwrap();
        store
    }

    #[test]
    fn record_run_pass_advances_and_records_overcome() {
        let dir = tempfile::tempdir().unwrap();
        let store = seed_two(dir.path());
        // A PASS on 01 (advance) → 01 Done, 02 Current, E4321 bumped to box 1.
        let advanced = record_run(&store, "basics/01_first", &[], true, true);
        assert_eq!(advanced.as_deref(), Some("basics/02_second"));
        let p = store.load_progress().unwrap();
        assert_eq!(
            p.entries["basics/01_first"].status,
            rpro_state::ExerciseStatus::Done
        );
        assert_eq!(
            p.entries["basics/02_second"].status,
            rpro_state::ExerciseStatus::Current
        );
        assert_eq!(p.entries["basics/01_first"].attempts, 1);
        assert_eq!(p.reviews.due(), vec!["E4321".to_string()]); // box 1, still due
    }

    #[test]
    fn record_run_never_reopens_a_finished_exercise() {
        let dir = tempfile::tempdir().unwrap();
        let store = seed_two(dir.path());
        // 02 was finished first (a jump-ahead, or a re-sequence that moved 01 in
        // front of it). Passing 01 must not hand the learner 02 again.
        let mut p = store.load_progress().unwrap();
        p.set_done("basics/02_second");
        store.save_progress(&p).unwrap();
        let advanced = record_run(&store, "basics/01_first", &[], true, true);
        assert_eq!(advanced, None, "nothing unfinished follows 01");
        let p = store.load_progress().unwrap();
        assert_eq!(
            p.entries["basics/02_second"].status,
            rpro_state::ExerciseStatus::Done,
            "a finished exercise stays finished"
        );
        assert_eq!(p.done_count(), 2);
    }

    #[test]
    fn record_run_guards_expected_but_records_unexpected() {
        let dir = tempfile::tempdir().unwrap();
        let store = seed_two(dir.path());
        // FAIL with the EXPECTED error → the lesson, not a stumble: not recorded.
        record_run(&store, "basics/01_first", &[diag("E4321")], false, false);
        assert_eq!(store.load_progress().unwrap().reviews.tracked_count(), 0);
        // FAIL with an UNEXPECTED error → a fresh miss enters the review queue.
        record_run(&store, "basics/01_first", &[diag("E4399")], false, false);
        assert_eq!(
            store.load_progress().unwrap().reviews.due(),
            vec!["E4399".to_string()]
        );
    }
}
