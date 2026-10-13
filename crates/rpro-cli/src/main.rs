//! `rpro` — Rustlings Pro CLI.
//!
//! Top-level command dispatch. Subcommands:
//!
//! ```text
//! rpro init                   — one-time setup (seeds exercises, Book, glossary, lessons, quizzes, cheatsheets)
//! rpro                        — open the TUI dashboard (default)
//! rpro exercise list          — every exercise with status
//! rpro exercise next          — jump to next unfinished
//! rpro exercise hint          — book references for current
//! rpro run / check / test     — compile / type-check / test an exercise
//! rpro explain <code>         — explain a diagnostic code in full
//! rpro book [search <term>]   — open the TUI book reader / text search
//! rpro lessons [id]           — read the Patina curriculum lessons offline
//! rpro quizzes [id]           — read the per-phase self-check quizzes offline
//! rpro cheatsheets [id]       — read the per-phase cheatsheets offline
//! rpro glossary [term]        — look up a Rust term offline
//! rpro progress               — completion summary
//! rpro detect                 — probe the local toolchain
//! ```

#![doc(html_no_source)]
#![allow(clippy::doc_markdown)]

use anyhow::{Context, Result, anyhow};
use clap::{Parser, Subcommand};
use console::style;
use rpro_core::Core;
use rpro_lang::{ExerciseId, ExerciseSource, RunOp};
use rpro_lang_rust::RustLanguage;
use rpro_state::ExerciseStatus;
use rpro_storage_fs::Store;
use rpro_toolchain_local::LocalProcess;

#[derive(Parser, Debug)]
#[command(name = "rpro", version, about = "Rustlings Pro — Rust learning + the Rust Book", long_about = None)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// One-time setup: clone exercises, fetch the book, write
    /// state files at ~/.rustlings-pro/.
    Init {
        /// Re-seed the bundled exercises, Book chapters, and glossary even if the
        /// store already has them — use after updating Tempered Studio to pull in
        /// new content. Preserves your progress, config, and any exercises you
        /// added yourself (the exercises dir merges; the read-only reference dirs
        /// — book/glossary/lessons/quizzes/cheatsheets — are synced to the bundle,
        /// so renamed or removed content disappears cleanly).
        #[arg(long)]
        refresh: bool,
    },
    /// Exercise commands.
    Exercise {
        #[command(subcommand)]
        sub: ExerciseCmd,
    },
    /// Book commands.
    Book {
        #[command(subcommand)]
        sub: Option<BookCmd>,
    },
    /// Print a one-screen progress summary.
    Progress,
    /// Probe the local toolchain (version + components) and list the
    /// learning tools available. Safe to run before `init`.
    Detect,
    /// Compile-and-run the current exercise (or the one named): shows the
    /// exact toolchain line, then the raw output verbatim, then diagnostics.
    Run {
        /// Exercise id (defaults to the current one).
        exercise: Option<String>,
    },
    /// Type-check the current exercise — fast feedback, no binary produced.
    Check {
        /// Exercise id (defaults to the current one).
        exercise: Option<String>,
    },
    /// Run the current exercise's tests.
    Test {
        /// Exercise id (defaults to the current one).
        exercise: Option<String>,
    },
    /// Explain a diagnostic code in full (e.g. `rpro explain E0382`).
    Explain {
        /// The diagnostic code to explain.
        code: String,
    },
    /// Look up a Rust term in the built-in offline glossary, or list every term.
    Glossary {
        /// Term to define (name or alias). Omit to list all terms.
        term: Option<String>,
    },
    /// Read the Patina curriculum lessons offline. Omit the id to list them all.
    Lessons {
        /// Lesson id (e.g. `05` or `05-scalar-types`; a prefix is
        /// enough). Omit to list every lesson in order.
        id: Option<String>,
    },
    /// Read the per-phase self-check quizzes offline. Omit the id to list them all.
    Quizzes {
        /// Quiz id (e.g. `phase1`; a prefix is enough). Omit to list every quiz.
        id: Option<String>,
    },
    /// Read the per-phase cheatsheets offline. Omit the id to list them all.
    Cheatsheets {
        /// Cheatsheet id (e.g. `phase1`; a prefix is enough). Omit to list all.
        id: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum ExerciseCmd {
    /// List every exercise with status + difficulty + concept.
    List,
    /// Jump to the next unfinished exercise (sets it to Current).
    Next,
    /// Book references + a laddered hint for the current exercise — what
    /// to read (and think) when stuck.
    Hint {
        /// Climb the hint ladder to this rung: 1 = concept nudge, 2 = the expected
        /// error code, 3 = back to the book + concept (the literal fix is never
        /// shown). Capped at the rungs you've earned — one unlocks per attempt.
        #[arg(long, default_value_t = 1)]
        level: u8,
        /// Jump to the highest hint rung you've EARNED (one unlocks per attempt;
        /// you must try first). The literal solution is never printed.
        #[arg(long)]
        solution: bool,
    },
    /// Skip the current exercise (mark it skipped) and move to the next.
    Skip,
    /// Reset the current exercise to a fresh attempt (clears done/skipped +
    /// attempt count so you can try it again from scratch).
    Reset,
}

#[derive(Subcommand, Debug)]
enum BookCmd {
    /// Full-text search across loaded chapters.
    Search {
        /// Search term.
        term: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        None => cmd_default(),
        Some(Cmd::Init { refresh }) => cmd_init(refresh),
        Some(Cmd::Exercise { sub }) => match sub {
            ExerciseCmd::List => cmd_exercise_list(),
            ExerciseCmd::Next => cmd_exercise_next(),
            ExerciseCmd::Hint { level, solution } => cmd_exercise_hint(level, solution),
            ExerciseCmd::Skip => cmd_exercise_skip(),
            ExerciseCmd::Reset => cmd_exercise_reset(),
        },
        Some(Cmd::Book { sub }) => match sub {
            None => cmd_book_open(),
            Some(BookCmd::Search { term }) => cmd_book_search(&term),
        },
        Some(Cmd::Progress) => cmd_progress(),
        Some(Cmd::Detect) => cmd_detect(),
        Some(Cmd::Run { exercise }) => cmd_exec(exercise.as_deref(), &RunOp::Run),
        Some(Cmd::Check { exercise }) => cmd_exec(exercise.as_deref(), &RunOp::Check),
        Some(Cmd::Test { exercise }) => cmd_exec(exercise.as_deref(), &RunOp::Test),
        Some(Cmd::Explain { code }) => cmd_explain(&code),
        Some(Cmd::Glossary { term }) => cmd_glossary(term.as_deref()),
        Some(Cmd::Lessons { id }) => cmd_lessons(id.as_deref()),
        Some(Cmd::Quizzes { id }) => cmd_quizzes(id.as_deref()),
        Some(Cmd::Cheatsheets { id }) => cmd_cheatsheets(id.as_deref()),
    }
}

/// `rpro glossary [term]` — look up a Rust term in the built-in offline glossary,
/// or list every term when no argument is given. Definitions are plain-language,
/// conceptual (never an exercise's fix), and attributed to the bundled Rust Book.
fn cmd_glossary(term: Option<&str>) -> Result<()> {
    let store = Store::user()?;
    let path = store.root().join("glossary").join("glossary.toml");
    let glossary = rpro_glossary::Glossary::load(&path)
        .with_context(|| format!("loading the glossary from {}", path.display()))?;
    if glossary.is_empty() {
        println!(
            "{}",
            style("No glossary yet — run `rpro init` to seed it.").yellow()
        );
        return Ok(());
    }
    match term {
        None => {
            println!("{}", style("Glossary terms:").bold().cyan());
            for t in glossary.all() {
                println!("  {}", style(&t.name).bold());
            }
            println!();
            println!(
                "  {} `{}`",
                style("Define one:").dim(),
                style("rpro glossary <term>").bold()
            );
        }
        Some(q) => match glossary.get(q) {
            None => {
                // Exact/alias lookup missed — fall back to a substring search over
                // names, aliases and definitions (the web glossary filters the same
                // way), so all 116 terms stay discoverable from the terminal instead
                // of a bare miss + a 116-line dump.
                let needle = q.to_lowercase();
                let hits: Vec<&str> = glossary
                    .all()
                    .iter()
                    .filter(|t| {
                        t.name.to_lowercase().contains(&needle)
                            || t.definition.to_lowercase().contains(&needle)
                            || t.aliases.iter().any(|a| a.to_lowercase().contains(&needle))
                    })
                    .map(|t| t.name.as_str())
                    .collect();
                if hits.is_empty() {
                    println!("{} no glossary entry for {:?}.", style("·").dim(), q);
                    println!(
                        "  {} `{}`",
                        style("Browse all:").dim(),
                        style("rpro glossary").bold()
                    );
                } else {
                    println!(
                        "{} no exact entry for {:?} — {} related term{}:",
                        style("·").dim(),
                        q,
                        hits.len(),
                        if hits.len() == 1 { "" } else { "s" }
                    );
                    let shown = hits.len().min(15);
                    for name in &hits[..shown] {
                        println!("  {}", style(name).bold());
                    }
                    if hits.len() > shown {
                        println!(
                            "  {}",
                            style(format!("… and {} more", hits.len() - shown)).dim()
                        );
                    }
                    println!();
                    println!(
                        "  {} `{}`",
                        style("Define one:").dim(),
                        style("rpro glossary <term>").bold()
                    );
                }
            }
            Some(t) => {
                println!("{}", style(&t.name).bold().cyan());
                println!("  {}", t.definition);
                println!();
                println!("  {}", style(&t.source).dim().italic());
                println!(
                    "  {} `{}`",
                    style("Read more:").dim(),
                    style(format!("rpro book search {}", t.book_chapter)).bold()
                );
            }
        },
    }
    Ok(())
}

/// `.md` file stems in `dir`, sorted (curriculum order = file order). Empty if
/// the dir is missing.
fn md_stems(dir: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir) // nosemgrep -- store-owned dir, stems re-matched below
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            (p.extension().and_then(|x| x.to_str()) == Some("md"))
                .then(|| p.file_stem().and_then(|s| s.to_str()).map(String::from))
                .flatten()
        })
        .collect();
    v.sort();
    v
}

/// The lesson's display title — its first `# ` heading, or the stem as a fallback.
fn md_title(md: &str, fallback: &str) -> String {
    md.lines()
        .find_map(|l| l.strip_prefix("# ").map(|t| t.trim().to_string()))
        .unwrap_or_else(|| fallback.to_string())
}

/// A read-only markdown study surface exposed to the terminal learner
/// (`lessons` / `quizzes` / `cheatsheets`). All three share one traversal-safe
/// list-or-print flow; only the labels differ.
struct MdSurface {
    /// Store subdir + the `rpro <cmd>` name (they match).
    name: &'static str,
    /// Heading shown when listing all items.
    list_title: &'static str,
    /// Singular noun for the "no `<noun>` …" not-found line (backticked so
    /// rustdoc reads it as code, not an HTML tag).
    noun: &'static str,
    /// Label + command printed after printing one item (the "what next" nudge).
    footer_label: &'static str,
    footer_cmd: &'static str,
}

const LESSONS: MdSurface = MdSurface {
    name: "lessons",
    list_title: "Lessons — the Patina curriculum:",
    noun: "lesson",
    footer_label: "Now write it:",
    footer_cmd: "rpro exercise next",
};
const QUIZZES: MdSurface = MdSurface {
    name: "quizzes",
    list_title: "Quizzes — per-phase self-checks (predict every answer, then reveal):",
    noun: "quiz",
    footer_label: "Back to studying:",
    footer_cmd: "rpro lessons",
};
const CHEATSHEETS: MdSurface = MdSurface {
    name: "cheatsheets",
    list_title: "Cheatsheets — per-phase quick reference:",
    noun: "cheatsheet",
    footer_label: "Practice it:",
    footer_cmd: "rpro exercise next",
};

/// List-or-print a bundled markdown study surface, fully offline. With no id it
/// lists every item; with one it prints that item (matched by exact stem or
/// prefix, so a bare number like `05` works — raw input is never path-joined).
/// The curriculum stage a lesson number belongs to — the SAME thresholds the
/// web's lessonToQuiz()/PHASE_NAMES use, so `rpro lessons` groups its list the
/// way the web and TUI show the path (11 stages, not a flat 37-item dump).
const fn lesson_stage(n: u32) -> &'static str {
    match n {
        0..=8 => "Foundations",
        9..=11 => "Control Flow",
        12..=14 => "Text & Collections",
        15..=17 => "Ownership & Borrowing",
        18..=20 => "Custom Types & Matching",
        21..=23 => "Organizing Code",
        24..=26 => "Generics, Traits & Lifetimes",
        27..=29 => "Functional & Smart Pointers",
        30..=31 => "Concurrency",
        32..=35 => "Advanced",
        _ => "Tooling",
    }
}

fn cmd_md_surface(s: &MdSurface, id: Option<&str>) -> Result<()> {
    let store = Store::user()?;
    let dir = store.root().join(s.name);
    let stems = md_stems(&dir);
    if stems.is_empty() {
        println!(
            "{}",
            style(format!("No {} yet — run `rpro init` to seed them.", s.name)).yellow()
        );
        return Ok(());
    }
    match id {
        None => {
            println!("{}", style(s.list_title).bold().cyan());
            // Lessons group under their curriculum stage (parity with web/TUI);
            // quizzes/cheatsheets are already one-per-phase, so they stay flat.
            let mut last_stage: Option<&'static str> = None;
            for stem in &stems {
                if s.name == "lessons" {
                    let n: u32 = stem
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                        .parse()
                        .unwrap_or(0);
                    let stage = lesson_stage(n);
                    if last_stage != Some(stage) {
                        last_stage = Some(stage);
                        println!("\n  {}", style(stage).bold());
                    }
                }
                // nosemgrep -- stem ∈ store-owned md_stems(dir); never raw input
                let title = std::fs::read_to_string(dir.join(format!("{stem}.md")))
                    .map_or_else(|_| stem.clone(), |md| md_title(&md, stem));
                println!("  {}  {}", style(stem).dim(), title);
            }
            println!();
            println!(
                "  {} `{}`",
                style("Read one:").dim(),
                style(format!("rpro {} <id>", s.name)).bold()
            );
        }
        Some(q) => {
            // Traversal-safe: only open an item whose stem really exists (exact,
            // else unique-ish prefix). Raw input is never joined to the path.
            let Some(stem) = stems
                .iter()
                .find(|st| st.as_str() == q)
                .or_else(|| stems.iter().find(|st| st.starts_with(q)))
            else {
                println!("{} no {} {:?}.", style("·").dim(), s.noun, q);
                println!(
                    "  {} `{}`",
                    style("Browse all:").dim(),
                    style(format!("rpro {}", s.name)).bold()
                );
                return Ok(());
            };
            // nosemgrep -- stem was just matched against store-owned stems above
            let md = std::fs::read_to_string(dir.join(format!("{stem}.md")))
                .with_context(|| format!("reading {} {stem}", s.noun))?;
            // HTML comments are authoring notes; drop them so the terminal read is clean.
            println!("{}", strip_html_comments(&md));
            println!();
            println!(
                "  {} `{}`",
                style(s.footer_label).dim(),
                style(s.footer_cmd).bold()
            );
        }
    }
    Ok(())
}

fn cmd_lessons(id: Option<&str>) -> Result<()> {
    cmd_md_surface(&LESSONS, id)
}
fn cmd_quizzes(id: Option<&str>) -> Result<()> {
    cmd_md_surface(&QUIZZES, id)
}
fn cmd_cheatsheets(id: Option<&str>) -> Result<()> {
    cmd_md_surface(&CHEATSHEETS, id)
}

/// Remove `<!-- … -->` blocks (authoring notes) from markdown for terminal display.
fn strip_html_comments(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find("-->") {
            Some(end) => &rest[start + end + 3..],
            None => "", // unterminated: drop the tail
        };
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Whether a store's recorded content version (`.content-version`, absent reads
/// as 0) is older than the bundled [`rpro_runner::CONTENT_VERSION`] — i.e. it was
/// seeded by an earlier build and should re-copy the read-only content dirs.
fn store_content_behind(store_root: &std::path::Path) -> bool {
    let stored = std::fs::read_to_string(store_root.join(".content-version"))
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    stored < rpro_runner::CONTENT_VERSION
}

fn cmd_init(refresh: bool) -> Result<()> {
    let store = Store::user().context("locating ~/.rustlings-pro/")?;

    // Auto-refresh an out-of-date store even without `--refresh`: if the store
    // already has content but was seeded by an older build (its `.content-version`
    // marker is behind the bundled `rpro_runner::CONTENT_VERSION`, or absent =
    // reads as 0), re-copy the read-only content dirs so later improvements (the
    // exercise "never hand the answer" sweep, new glossary terms, lesson rewrites)
    // reach existing installs — matching the web server and the Android app. A
    // truly fresh store seeds normally (below) and this stays false so the title
    // reads "first-time setup". Progress is never touched by the refresh.
    let marker = store.root().join(".content-version");
    let had_content =
        rpro_runner::discover(&store.root().join("exercises")).is_ok_and(|v| !v.is_empty());
    let refresh = refresh || (had_content && store_content_behind(store.root()));

    let title = if !had_content {
        "Rustlings Pro — first-time setup"
    } else if refresh {
        "Rustlings Pro — refreshing bundled content"
    } else {
        "Rustlings Pro — already up to date"
    };
    println!("{}", style(title).bold().cyan());
    println!("  state directory: {}", style(store.root().display()).dim());

    // Create the standard subdirs.
    for sub in ["exercises", "book"] {
        let p = store.root().join(sub);
        std::fs::create_dir_all(&p).with_context(|| format!("mkdir {}", p.display()))?;
        println!("  + {}", style(p.display()).dim());
    }

    // Write a default config + empty progress/bookmarks/annotations
    // so subsequent commands can always load something.
    if !store.root().join("config.toml").exists() {
        store.save_config(&rpro_state::Config::default())?;
        println!("  + {}", style("config.toml").dim());
    }
    if !store.root().join("progress.json").exists() {
        store.save_progress(&rpro_state::Progress::default())?;
        println!("  + {}", style("progress.json").dim());
    }
    if !store.root().join("bookmarks.json").exists() {
        store.save_bookmarks(&rpro_state::Bookmarks::default())?;
        println!("  + {}", style("bookmarks.json").dim());
    }
    if !store.root().join("annotations.json").exists() {
        store.save_annotations(&rpro_state::Annotations::default())?;
        println!("  + {}", style("annotations.json").dim());
    }

    // Seed the bundled exercises (the workspace `exercises/` tree) if the store
    // has none yet, then mark the first one current — so a fresh `rpro` lands on
    // a real, runnable exercise instead of an empty screen. This is parity with
    // the web server's auto-seed.
    let exercises_dir = store.root().join("exercises");
    let bundled = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../exercises");
    let have_any = rpro_runner::discover(&exercises_dir).is_ok_and(|v| !v.is_empty());
    if (refresh || !have_any) && bundled.is_dir() {
        copy_tree(&bundled, &exercises_dir)
            .with_context(|| format!("seeding exercises from {}", bundled.display()))?;
        // The copy overlays (a learner's own exercises survive), so drop the same-id
        // copy a renamed bundled exercise leaves under its old name — otherwise the
        // course order lists it twice. Parity with the web server's seed.
        rpro_runner::prune_renamed(&bundled, &exercises_dir).context("pruning renamed copies")?;
        let n = rpro_runner::discover(&exercises_dir).map_or(0, |v| v.len());
        println!("  + seeded {n} bundled exercise(s)");
    }
    // Read-only reference dirs are SYNCED on refresh (cleared, then copied): a
    // content update can REMOVE/RENAME a file (e.g. a lesson split), and an
    // overlay copy would leave the old file behind as a ghost list entry. The
    // exercises dir above is deliberately overlay-only — its README invites the
    // user to drop their own exercises alongside the bundled set.
    let sync_dir = |dir: &std::path::Path| -> Result<()> {
        if refresh && dir.is_dir() {
            std::fs::remove_dir_all(dir)
                .with_context(|| format!("clearing {} for refresh", dir.display()))?;
        }
        Ok(())
    };

    // Seed the bundled Rust Book chapters the same way, so the Book reader has
    // real content offline (parity with the exercises seed).
    let book_dir = store.root().join("book");
    let bundled_book = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../book");
    let have_book = rpro_book::Book::load(&book_dir).is_ok_and(|b| !b.chapters.is_empty());
    if (refresh || !have_book) && bundled_book.is_dir() {
        sync_dir(&book_dir)?;
        copy_tree(&bundled_book, &book_dir)
            .with_context(|| format!("seeding book from {}", bundled_book.display()))?;
        if let Ok(b) = rpro_book::Book::load(&book_dir) {
            println!("  + seeded {} Rust Book chapter(s)", b.chapters.len());
        }
    }
    // Seed the built-in glossary the same way, so `rpro glossary` works offline
    // (parity with the web seed).
    let gloss_dir = store.root().join("glossary");
    let bundled_gloss = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../glossary");
    if (refresh || !gloss_dir.join("glossary.toml").exists()) && bundled_gloss.is_dir() {
        sync_dir(&gloss_dir)?;
        copy_tree(&bundled_gloss, &gloss_dir)
            .with_context(|| format!("seeding glossary from {}", bundled_gloss.display()))?;
        if let Ok(g) = rpro_glossary::Glossary::load(&gloss_dir.join("glossary.toml")) {
            println!("  + seeded {} glossary term(s)", g.all().len());
        }
    }
    // Seed the Patina curriculum lessons the same way, so `rpro lessons` works
    // offline (parity with the web seed + the Book/glossary seeds above).
    let lessons_dir = store.root().join("lessons");
    let bundled_lessons = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../lessons");
    if (refresh || md_stems(&lessons_dir).is_empty()) && bundled_lessons.is_dir() {
        sync_dir(&lessons_dir)?;
        copy_tree(&bundled_lessons, &lessons_dir)
            .with_context(|| format!("seeding lessons from {}", bundled_lessons.display()))?;
        println!("  + seeded {} lesson(s)", md_stems(&lessons_dir).len());
    }
    // Seed the per-phase quizzes + cheatsheets the same way, so `rpro quizzes` /
    // `rpro cheatsheets` work offline (parity with the web seed + lessons above).
    for (sub, label) in [("quizzes", "quiz"), ("cheatsheets", "cheatsheet")] {
        let dir = store.root().join(sub);
        let bundled = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(sub);
        if (refresh || md_stems(&dir).is_empty()) && bundled.is_dir() {
            sync_dir(&dir)?;
            copy_tree(&bundled, &dir)
                .with_context(|| format!("seeding {sub} from {}", bundled.display()))?;
            println!("  + seeded {} {label}(s)", md_stems(&dir).len());
        }
    }
    // Ensure a Current exercise so the first run isn't an empty screen.
    let mut progress = store.load_progress().unwrap_or_default();
    let has_current = progress
        .entries
        .values()
        .any(|e| e.status == ExerciseStatus::Current);
    if !has_current {
        if let Ok(mut exs) = rpro_runner::discover(&exercises_dir) {
            exs.sort_by(|a, b| a.source.cmp(&b.source)); // path order = learning order
            if let Some(first) = exs.first() {
                progress.set_current(&first.meta.id);
                store.save_progress(&progress)?;
                println!("  + current exercise: {}", style(&first.meta.id).cyan());
            }
        }
    }

    // Drop a README in the exercises dir so the layout is discoverable. (The book
    // dir intentionally gets no README: it's seeded with the real chapters, and a
    // `.md` there would be picked up by the book loader as a bogus chapter.)
    write_if_missing(
        &store.root().join("exercises/README.md"),
        "Exercises live here (seeded from the bundled set on `rpro init`). Each \
         exercise is a `name.rs` (the failing starter) plus a sibling `name.toml` \
         with metadata (id, title, difficulty, concept, expected_error_code, \
         book_refs). Drop your own alongside them.\n",
    )?;

    println!();
    println!("{}", style("✓ setup complete").green().bold());
    println!();
    println!("Next:");
    println!(
        "  - {} — re-seed bundled content after updating Tempered Studio",
        style("rpro init --refresh").yellow()
    );
    println!(
        "  - {} — list what's been imported so far",
        style("rpro exercise list").yellow()
    );
    println!(
        "  - {} — open the book reader (in-app)",
        style("rpro book").yellow()
    );
    println!();

    // Record the content version so a later `rpro init` on this store is a no-op
    // until the bundled content actually moves ahead (`CONTENT_VERSION` bumps).
    std::fs::write(&marker, rpro_runner::CONTENT_VERSION.to_string())
        .with_context(|| format!("recording content version at {}", marker.display()))?;
    Ok(())
}

fn cmd_default() -> Result<()> {
    let store = Store::user()?;
    let book = rpro_book::Book::load(&store.root().join("book"))?;
    rpro_tui::run_dashboard(&store, &book)?;
    Ok(())
}

fn cmd_exercise_list() -> Result<()> {
    let store = Store::user()?;
    let progress = store.load_progress()?;
    let exercises = rpro_runner::discover(&store.root().join("exercises"))?;
    if exercises.is_empty() {
        println!(
            "{}",
            style("No exercises yet. Run `rpro init` to set up the bundled exercises.").yellow()
        );
        return Ok(());
    }
    println!(
        "{:<30} {:<14} {:<14} {:<6} title",
        "id", "status", "difficulty", "min"
    );
    println!("{}", "-".repeat(80));
    for ex in &exercises {
        let status = progress
            .entries
            .get(&ex.meta.id)
            .map_or(ExerciseStatus::Locked, |e| e.status);
        let status_str = match status {
            ExerciseStatus::Locked => style("locked").dim(),
            ExerciseStatus::Current => style("current").yellow(),
            ExerciseStatus::Done => style("done").green(),
            ExerciseStatus::Skipped => style("skipped").red(),
        };
        println!(
            "{:<30} {:<14} {:?} {:<6} {}",
            ex.meta.id, status_str, ex.meta.difficulty, ex.meta.estimated_minutes, ex.meta.title
        );
    }
    Ok(())
}

fn cmd_exercise_next() -> Result<()> {
    let store = Store::user()?;
    let mut progress = store.load_progress()?;
    let exercises = rpro_runner::discover(&store.root().join("exercises"))?;
    let current = exercises.iter().find(|ex| {
        let s = progress
            .entries
            .get(&ex.meta.id)
            .map_or(ExerciseStatus::Locked, |e| e.status);
        !matches!(s, ExerciseStatus::Done | ExerciseStatus::Skipped)
    });
    let Some(ex) = current else {
        println!(
            "{}",
            style("All exercises done. Time to ship something.")
                .green()
                .bold()
        );
        return Ok(());
    };
    progress.set_current(&ex.meta.id);
    store.save_progress(&progress)?;
    println!("{} {}", style("→").bold().cyan(), style(&ex.meta.id).bold());
    println!("  {}", ex.meta.title);
    println!("  file: {}", style(ex.source.display()).dim());
    println!();
    println!(
        "  {} `{}` to see the book sections that explain this exercise.",
        style("Tip:").yellow(),
        style("rpro exercise hint").bold()
    );
    Ok(())
}

/// Resolve the current exercise id from on-disk progress, if any.
fn current_exercise_id(progress: &rpro_state::Progress) -> Option<String> {
    progress
        .entries
        .iter()
        .find(|(_, e)| e.status == ExerciseStatus::Current)
        .map(|(id, _)| id.clone())
}

fn cmd_exercise_skip() -> Result<()> {
    let store = Store::user()?;
    let mut progress = store.load_progress()?;
    let exercises = rpro_runner::discover(&store.root().join("exercises"))?;
    let Some(current_id) = current_exercise_id(&progress) else {
        println!(
            "{}",
            style("No current exercise to skip — run `rpro exercise next` first.").dim()
        );
        return Ok(());
    };
    progress.set_skipped(&current_id);
    // Advance to the next unfinished exercise (discovery is in learning order).
    let next = exercises.iter().find(|ex| {
        let s = progress
            .entries
            .get(&ex.meta.id)
            .map_or(ExerciseStatus::Locked, |e| e.status);
        !matches!(s, ExerciseStatus::Done | ExerciseStatus::Skipped)
    });
    if let Some(ex) = next {
        progress.set_current(&ex.meta.id);
    }
    store.save_progress(&progress)?;
    println!(
        "{} skipped {}",
        style("»").red().bold(),
        style(&current_id).bold()
    );
    if let Some(ex) = next {
        println!("{} {}", style("→").cyan().bold(), style(&ex.meta.id).bold());
        println!("  {}", ex.meta.title);
    } else {
        println!(
            "  {}",
            style("nothing left unfinished — you've reached the end.").green()
        );
    }
    Ok(())
}

fn cmd_exercise_reset() -> Result<()> {
    let store = Store::user()?;
    let mut progress = store.load_progress()?;
    let Some(current_id) = current_exercise_id(&progress) else {
        println!(
            "{}",
            style("No current exercise to reset — run `rpro exercise next` first.").dim()
        );
        return Ok(());
    };
    progress.reset(&current_id);
    store.save_progress(&progress)?;
    println!(
        "{} reset {} — fresh attempt (done/attempt count cleared).",
        style("↺").yellow().bold(),
        style(&current_id).bold()
    );
    Ok(())
}

fn cmd_exercise_hint(level: u8, show_solution: bool) -> Result<()> {
    let store = Store::user()?;
    let progress = store.load_progress()?;
    let exercises = rpro_runner::discover(&store.root().join("exercises"))?;
    let current_id = progress
        .entries
        .iter()
        .find(|(_, e)| e.status == ExerciseStatus::Current)
        .map(|(id, _)| id.clone())
        .ok_or_else(|| anyhow!("no current exercise — run `rpro exercise next` first"))?;
    let ex = exercises
        .iter()
        .find(|e| e.meta.id == current_id)
        .ok_or_else(|| anyhow!("current exercise '{current_id}' not found on disk"))?;

    println!(
        "{}",
        style(format!("📖 Book references for {}", ex.meta.id))
            .bold()
            .cyan()
    );
    println!("   {}", style(&ex.meta.title).dim());
    println!();
    for (i, r) in ex.meta.book_refs.iter().enumerate() {
        println!(
            "  {}. {} {}",
            i + 1,
            style(&r.chapter).bold(),
            r.anchor
                .as_deref()
                .map_or(String::new(), |a| format!("# {a}"))
        );
        println!("     {}", r.why);
        println!(
            "     {}",
            style(rpro_lang::Language::book_ref_url(
                &rpro_lang_rust::RustLanguage,
                r
            ))
            .dim()
            .underlined()
        );
        println!();
    }
    // Force-attempt gate (parity with rpro-serve `hint_handler`): the book
    // references above stay ALWAYS visible — like the web's always-open Book tab —
    // but the laddered hint is locked until a genuine attempt is recorded, even
    // for `--solution`. `rpro run`/`check`/`test` record the attempt (see
    // `finalize_run_progress`), so this unlocks once the learner has truly tried.
    let attempts = progress.entries.get(&current_id).map_or(0, |e| e.attempts);
    if attempts == 0 {
        println!(
            "{}",
            style("Run it first — hints unlock once you've genuinely tried.")
                .yellow()
                .bold()
        );
        println!(
            "  Predict the outcome, then `{}` and read the real compiler error by hand.",
            style("rpro run").bold()
        );
        return Ok(());
    }

    // Laddered hint text — the SAME shared ladder the web + TUI show
    // (`ExerciseMetadata::hint`). Escalation also matches rpro-serve `hint_handler`:
    // ONE rung is earned per attempt (capped at 3), so the learner proves they're
    // stuck (more genuine tries) to unlock deeper help. `--level` is clamped to
    // what's earned; `--solution` jumps to the highest EARNED rung, never past it.
    let earned = u8::try_from(attempts).unwrap_or(u8::MAX).min(3);
    let requested = if show_solution {
        earned
    } else {
        level.max(1).min(earned)
    };
    let (lvl, max, text) = ex.meta.hint(requested);
    let last = lvl >= max;
    println!(
        "{}",
        style(format!(
            "Hint {lvl}/{max}{}:",
            if last { " · last resort" } else { "" }
        ))
        .yellow()
        .bold()
    );
    println!("  {text}");
    if !last {
        println!();
        // Deeper rungs are earned by trying again, not by bumping a flag: only
        // point at `--level N+1` when it's ALREADY been earned; otherwise send the
        // learner back to another genuine attempt.
        let tip = if lvl < earned {
            format!("rpro exercise hint --level {}", lvl + 1)
        } else {
            "run it again (`rpro run`) to earn the next hint rung".to_string()
        };
        println!("  {} {}", style("Tip:").yellow(), style(tip).bold());
    }
    Ok(())
}

fn cmd_book_open() -> Result<()> {
    let store = Store::user()?;
    let book = rpro_book::Book::load(&store.root().join("book"))?;
    rpro_tui::run_book_reader(&store, &book, None)?;
    Ok(())
}

fn cmd_book_search(term: &str) -> Result<()> {
    let store = Store::user()?;
    let book = rpro_book::Book::load(&store.root().join("book"))?;
    if book.is_empty() {
        println!(
            "{}",
            style("No book content yet. Run `rpro init` to seed the bundled chapters.").yellow()
        );
        return Ok(());
    }
    // Shared with the web surface (rpro-serve `/api/book?q=`) via rpro-book.
    let hits = book.search(term);
    if hits.is_empty() {
        println!("{}", style(format!("no chapters match `{term}`")).dim());
        return Ok(());
    }
    for h in &hits {
        let n = if h.count == 1 { "match" } else { "matches" };
        // Human title first, then the chapter id (the canonical ref) + count;
        // the snippet gives one line of context — all from the shared SearchHit.
        println!(
            "{}  {}  {}",
            style(&h.title).cyan().bold(),
            style(&h.chapter).dim(),
            style(format!("({} {n})", h.count)).dim(),
        );
        if !h.snippet.is_empty() {
            println!("    {}", style(&h.snippet).dim());
        }
    }
    Ok(())
}

fn cmd_progress() -> Result<()> {
    let store = Store::user()?;
    let progress = store.load_progress()?;
    let exercises = rpro_runner::discover(&store.root().join("exercises"))?;
    let total = exercises.len();
    let done = progress.done_count();
    let pct = (done * 100).checked_div(total).unwrap_or(0);
    println!("{}", style("Rustlings Pro — progress").bold().cyan());
    println!("  {done} / {total} done ({pct}%)");
    // Per-phase breakdown (parity with the web/mobile lists, which show a done/total
    // count per topic): group exercises by their `<phase>/` id prefix, in curriculum
    // order, so you see where you stand within each topic — not just the grand total.
    let mut phases: Vec<(String, u32, u32)> = Vec::new();
    for ex in &exercises {
        let phase = ex.meta.id.split('/').next().unwrap_or("").to_string();
        let is_done = progress
            .entries
            .get(&ex.meta.id)
            .is_some_and(|e| e.status == ExerciseStatus::Done);
        if let Some(entry) = phases.iter_mut().find(|(p, _, _)| *p == phase) {
            entry.2 += 1;
            entry.1 += u32::from(is_done);
        } else {
            phases.push((phase, u32::from(is_done), 1));
        }
    }
    if !phases.is_empty() {
        println!();
        for (phase, phase_done, phase_total) in &phases {
            let count = format!("{phase_done}/{phase_total}");
            let count = if phase_done == phase_total {
                style(format!("{count} ✓")).green()
            } else {
                style(count).dim()
            };
            println!("  {:<20} {count}", phase.replace('-', " "));
        }
        println!();
    }
    let remaining: u32 = exercises
        .iter()
        .filter(|ex| {
            progress
                .entries
                .get(&ex.meta.id)
                .is_none_or(|e| e.status != ExerciseStatus::Done)
        })
        .map(|ex| ex.meta.estimated_minutes)
        .sum();
    if remaining > 0 {
        println!("  estimated remaining: {remaining} min");
    }
    Ok(())
}

fn cmd_detect() -> Result<()> {
    use rpro_lang::Language as _;

    let store = Store::user().context("locating ~/.rustlings-pro/")?;
    let lang = RustLanguage;
    let probe = lang.detect_plan();
    let tools = lang.tools();
    // The Dev tier's IDE launches the language server this `LspSpec` describes;
    // capture it before `lang` is moved so `detect` can report its availability.
    let lsp = lang.lsp();

    // Route the probe through the Core so this command exercises the exact
    // plan → execute → interpret path every surface will use.
    let core = Core::new(Box::new(lang), Box::new(LocalProcess), Box::new(store));

    println!("{}", style("Toolchain check").bold().cyan());
    println!("  {} {}", style("$").dim(), style(&probe.display).dim());
    println!();

    match pollster::block_on(core.detect()) {
        Ok(status) => {
            if status.present {
                println!("  {} toolchain detected", style("✓").green().bold());
            } else {
                println!(
                    "  {} no toolchain detected on PATH",
                    style("✗").yellow().bold()
                );
            }
            if let Some(v) = &status.version {
                println!("  {:<12} {}", "version:", style(v).bold());
            }
            let comps = if status.components.is_empty() {
                style("(none reported)").dim().to_string()
            } else {
                status.components.join(", ")
            };
            println!("  {:<12} {comps}", "components:");
        }
        Err(e) => {
            println!("  {} could not run the probe", style("✗").red().bold());
            println!("  {e}");
            println!();
            println!(
                "  Install the toolchain from {} and re-run.",
                style("https://rustup.rs").underlined()
            );
        }
    }

    // Language server (the Dev tier's IDE will launch the server this LspSpec
    // names). Data-driven — the binary comes from `lsp.server`, never hardcoded —
    // so the language-seam stays clean. We run a REAL protocol handshake (via the
    // rpro-lsp client), not a version shell-out: that proves the server actually
    // speaks the protocol, and reports the name/version IT announces in its reply.
    println!();
    println!("{}", style("Language server (Dev IDE)").bold().cyan());
    match rpro_lsp::server_info(&lsp, rpro_lsp::DEFAULT_TIMEOUT) {
        Ok(info) => {
            let version = info.version.as_deref().unwrap_or("version not reported");
            println!(
                "  {} {} {} — completed an LSP handshake (owns {})",
                style("✓").green().bold(),
                style(&info.name).bold(),
                version,
                style(&lsp.file_glob).dim()
            );
        }
        Err(rpro_lsp::LspError::Spawn { .. }) => {
            println!(
                "  {} {} not found on PATH",
                style("·").dim(),
                style(&lsp.server).bold()
            );
            println!(
                "    the Dev tier's editor assists rely on it once wired; install it to enable"
            );
        }
        Err(e) => {
            println!(
                "  {} {} is on PATH but did not complete an LSP handshake: {}",
                style("⚠").yellow().bold(),
                style(&lsp.server).bold(),
                e
            );
        }
    }

    println!();
    println!("{}", style("Learning tools").bold().cyan());
    for t in &tools {
        println!(
            "  {:<14} {:<10} {}",
            style(&t.name).bold(),
            format!("{:?}", t.kind).to_lowercase(),
            style(&t.plan.display).dim()
        );
    }
    Ok(())
}

fn cmd_exec(id: Option<&str>, op: &RunOp) -> Result<()> {
    let store = Store::user()?;
    let exercises =
        rpro_runner::discover(&store.root().join("exercises")).context("discovering exercises")?;
    if exercises.is_empty() {
        println!(
            "{}",
            style(
                "No exercises yet. Run `rpro init` to set up the bundled exercises, or pass an id."
            )
            .yellow()
        );
        return Ok(());
    }
    let ex = resolve_exercise(&store, &exercises, id)?;
    // `ex.source` is a path discovered by walking the *local* exercises dir and
    // validated during discovery — not external/untrusted input. The
    // web-oriented (Actix) path-traversal rule is a false positive for this
    // local-CLI read of a file the tool itself found on disk.
    let code = std::fs::read_to_string(&ex.source) // nosemgrep
        .with_context(|| format!("reading {}", ex.source.display()))?;

    // Prepare a scratch project under ~/.rustlings-pro/run/<id>/ (HOME is
    // exec-capable, unlike /tmp) and drop the learner's code in as the entry.
    // `slug` strips every path separator and `.`, so the result is a single
    // safe component that cannot escape `run_base` (no traversal). We still
    // reject an empty slug and assert containment as defense-in-depth.
    let run_base = store.root().join("run");
    let name = rpro_runner::slug(&ex.meta.id);
    if name.is_empty() {
        return Err(anyhow!(
            "exercise id '{}' has no usable characters",
            ex.meta.id
        ));
    }
    let run_dir = run_base.join(&name);
    debug_assert_eq!(run_dir.parent(), Some(run_base.as_path()));
    prepare_scratch_project(&run_dir, &code)?;

    let core = Core::new(
        Box::new(RustLanguage),
        Box::new(LocalProcess),
        Box::new(Store::user()?),
    );
    let src = ExerciseSource {
        id: ExerciseId(ex.meta.id.clone()),
        dir: run_dir.display().to_string(),
        entry: "src/main.rs".into(),
    };

    // CLI-first contract: show the exact line, then the raw output verbatim.
    println!(
        "{} {}",
        style(&ex.meta.id).bold().cyan(),
        style(&ex.meta.title).dim()
    );
    println!(
        "{} {}",
        style("$").dim(),
        style(&core.plan(&src, op).display).dim()
    );
    println!();
    let outcome = pollster::block_on(core.run(&src, op)).context("running the toolchain")?;
    if !outcome.raw_stdout.is_empty() {
        print!("{}", outcome.raw_stdout);
    }
    if !outcome.raw_stderr.is_empty() {
        eprint!("{}", outcome.raw_stderr);
    }

    // Additive verdict + a by-hand diagnostic summary (raw is always above).
    println!();
    if outcome.status == Some(0) {
        println!(
            "{} in {}ms",
            style("✓ passed").green().bold(),
            outcome.duration_ms
        );
    } else {
        println!(
            "{} · {} diagnostic(s) · {}ms",
            style("✗ failed").red().bold(),
            outcome.diagnostics.len(),
            outcome.duration_ms
        );
        for d in &outcome.diagnostics {
            let code = d.code.clone().unwrap_or_default();
            println!(
                "  {} {}  {}",
                style("•").red(),
                style(code).bold(),
                d.message
            );
        }
    }

    // Update shared on-disk progress (attempt; Done + advance on a passing
    // Run/Test of the current exercise) and tell the learner if they moved on.
    finalize_run_progress(
        &store,
        ex,
        op,
        outcome.status == Some(0),
        &outcome.diagnostics,
    );
    Ok(())
}

/// After an exec run, record it into shared progress and announce an advance.
///
/// Uses the SAME helper every surface shares ([`rpro_runner::record_run`]): it
/// always logs an attempt (so the force-attempt hint gate has something to read)
/// and, when `advance` holds, marks the exercise Done and moves to the next.
///
/// Only the **current** exercise drives progress. An ad-hoc `rpro run <id>`
/// side-run of a *different* exercise is left completely untouched: recording an
/// attempt there would create a phantom second `Current` (`record_attempt`
/// defaults a new entry to `Current`), breaking the single-`Current` invariant —
/// and the gate only ever reads the current exercise's attempts. Check never
/// advances; a failing run only logs the attempt; `set_done` never regresses.
fn finalize_run_progress(
    store: &Store,
    ex: &rpro_runner::Exercise,
    op: &RunOp,
    passed: bool,
    diagnostics: &[rpro_lang::Diagnostic],
) {
    let current = current_exercise_id(&store.load_progress().unwrap_or_default());
    if current.as_deref() != Some(ex.meta.id.as_str()) {
        return; // side-run of a non-current exercise: don't touch progress
    }
    let advance = passed && matches!(op, RunOp::Run | RunOp::Test);
    if let Some(next) = rpro_runner::record_run(store, &ex.meta.id, diagnostics, passed, advance) {
        println!();
        println!(
            "  {} {} complete → now on {}",
            style("✓").green().bold(),
            style(&ex.meta.id).dim(),
            style(&next).bold().cyan()
        );
        println!(
            "  {} `{}` for the next exercise's book sections.",
            style("Tip:").yellow(),
            style("rpro exercise hint").bold()
        );
    }
}

/// Explain a diagnostic code in full, via the language's explain plan
/// (e.g. `rustc --explain E0382`), routed through the Core.
fn cmd_explain(code: &str) -> Result<()> {
    let core = Core::new(
        Box::new(RustLanguage),
        Box::new(LocalProcess),
        Box::new(Store::user()?),
    );
    // `Explain` ignores the exercise source; a placeholder satisfies the API.
    let ex = ExerciseSource {
        id: ExerciseId(String::new()),
        dir: ".".into(),
        entry: String::new(),
    };
    let op = RunOp::Explain(code.to_string());
    println!(
        "{} {}",
        style("$").dim(),
        style(&core.plan(&ex, &op).display).dim()
    );
    println!();
    let outcome = pollster::block_on(core.run(&ex, &op)).context("running the explainer")?;
    if !outcome.raw_stdout.is_empty() {
        print!("{}", outcome.raw_stdout);
    }
    if !outcome.raw_stderr.is_empty() {
        eprint!("{}", outcome.raw_stderr);
    }
    Ok(())
}

/// Resolve which exercise to act on: an explicit id, else the `Current` one,
/// else the first discovered.
fn resolve_exercise<'a>(
    store: &Store,
    exercises: &'a [rpro_runner::Exercise],
    id: Option<&str>,
) -> Result<&'a rpro_runner::Exercise> {
    if let Some(id) = id {
        return exercises
            .iter()
            .find(|e| e.meta.id == id)
            .ok_or_else(|| anyhow!("no exercise with id '{id}'"));
    }
    let progress = store.load_progress().unwrap_or_default();
    let current = progress
        .entries
        .iter()
        .find(|(_, e)| e.status == ExerciseStatus::Current)
        .map(|(id, _)| id.clone());
    if let Some(cur) = current {
        if let Some(e) = exercises.iter().find(|e| e.meta.id == cur) {
            return Ok(e);
        }
    }
    exercises
        .first()
        .ok_or_else(|| anyhow!("no exercises found"))
}

/// Create a minimal scratch project at `dir` from the language's scaffold, so
/// the toolchain can build and run the learner's code. The project layout comes
/// from `RustLanguage::scaffold` (keeps the Rust-specifics behind the seam).
fn prepare_scratch_project(dir: &std::path::Path, main_rs: &str) -> Result<()> {
    for (rel, contents) in RustLanguage::scaffold(main_rs) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("mkdir {}", parent.display()))?;
        }
        std::fs::write(&path, contents).with_context(|| format!("write {}", path.display()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn write_if_missing(path: &std::path::Path, contents: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    std::fs::write(path, contents).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Recursively copy `from` into `to` (files + subdirs). Used only to seed the
/// bundled, read-only exercise tree into the user's writable store — both paths
/// are program-controlled (a compile-time workspace dir and the `~/.rustlings-pro`
/// store), never derived from external input.
// nosemgrep
fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    // `from`/`to` are program-controlled only (a compile-time workspace dir and
    // the fixed ~/.rustlings-pro store); no external/user input reaches this path.
    // nosemgrep
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rpro_state::{Difficulty, ExerciseMetadata, Progress};
    use std::path::PathBuf;

    fn ex(id: &str) -> rpro_runner::Exercise {
        rpro_runner::Exercise {
            source: PathBuf::from(format!("/x/{id}.rs")),
            meta: ExerciseMetadata {
                id: id.to_string(),
                title: id.to_string(),
                difficulty: Difficulty::Beginner,
                estimated_minutes: 5,
                concept: "concept".into(),
                book_refs: vec![],
                expected_error_code: None,
                expected_runtime_panic: None,
                solution_outline: None,
            },
        }
    }

    #[test]
    fn current_exercise_id_finds_only_the_current() {
        let mut p = Progress::default();
        assert_eq!(
            current_exercise_id(&p),
            None,
            "empty progress has no current"
        );
        p.set_done("a/1");
        assert_eq!(current_exercise_id(&p), None, "a Done entry is not current");
        p.set_current("a/2");
        assert_eq!(current_exercise_id(&p).as_deref(), Some("a/2"));
    }

    #[test]
    fn resolve_exercise_prefers_id_then_current_then_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::at(dir.path().to_path_buf());
        let exs = vec![ex("a/1"), ex("a/2"), ex("a/3")];
        // An explicit id wins.
        assert_eq!(
            resolve_exercise(&store, &exs, Some("a/2")).unwrap().meta.id,
            "a/2"
        );
        // An unknown explicit id is an error (never silently falls back).
        assert!(resolve_exercise(&store, &exs, Some("missing")).is_err());
        // No id + no progress → the first exercise (learning order).
        assert_eq!(resolve_exercise(&store, &exs, None).unwrap().meta.id, "a/1");
        // No id + a saved Current → that one.
        let mut p = Progress::default();
        p.set_current("a/3");
        store.save_progress(&p).unwrap();
        assert_eq!(resolve_exercise(&store, &exs, None).unwrap().meta.id, "a/3");
    }

    #[test]
    fn store_content_behind_tracks_the_version_marker() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let marker = root.join(".content-version");
        // No marker → reads as version 0 → behind whenever the bundle is >= 1.
        assert_eq!(
            store_content_behind(root),
            rpro_runner::CONTENT_VERSION > 0,
            "an absent marker reads as version 0"
        );
        // A marker at the current version is NOT behind (steady state).
        std::fs::write(&marker, rpro_runner::CONTENT_VERSION.to_string()).unwrap();
        assert!(
            !store_content_behind(root),
            "a current marker is up to date"
        );
        // A newer marker (shouldn't happen, but be robust) is not behind either.
        std::fs::write(&marker, (rpro_runner::CONTENT_VERSION + 1).to_string()).unwrap();
        assert!(!store_content_behind(root), "a newer marker is not behind");
        // Rolling the marker back to 0 makes it behind again (the upgrade path).
        std::fs::write(&marker, "0").unwrap();
        assert_eq!(store_content_behind(root), rpro_runner::CONTENT_VERSION > 0);
    }

    #[test]
    fn write_if_missing_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f.txt");
        write_if_missing(&f, "first").unwrap();
        write_if_missing(&f, "second").unwrap();
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "first",
            "existing file is kept"
        );
    }

    #[test]
    fn copy_tree_copies_files_and_nested_subdirs() {
        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("top.txt"), "t").unwrap();
        std::fs::create_dir(src.path().join("sub")).unwrap();
        std::fs::write(src.path().join("sub").join("inner.txt"), "i").unwrap();
        let dst = tempfile::tempdir().unwrap();
        let to = dst.path().join("out");
        copy_tree(src.path(), &to).unwrap();
        assert_eq!(std::fs::read_to_string(to.join("top.txt")).unwrap(), "t");
        assert_eq!(
            std::fs::read_to_string(to.join("sub").join("inner.txt")).unwrap(),
            "i"
        );
    }

    /// Data invariant behind the in-app Book jump links: every exercise's
    /// `book_refs` must resolve to a *bundled* chapter. A broken ref would
    /// otherwise only surface when a learner clicked it (chapter-not-found).
    /// Reads the real workspace `exercises/` + `book/` (pure data — no toolchain).
    #[test]
    fn every_book_ref_resolves_to_a_bundled_chapter() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let exercises = rpro_runner::discover(&manifest.join("../../exercises"))
            .expect("discover workspace exercises");
        let book = rpro_book::Book::load(&manifest.join("../../book")).expect("load bundled book");
        assert!(
            !exercises.is_empty() && !book.is_empty(),
            "fixtures present"
        );
        let mut broken = Vec::new();
        for ex in &exercises {
            for r in &ex.meta.book_refs {
                if book.get(&r.chapter).is_none() {
                    broken.push(format!("{} -> {}", ex.meta.id, r.chapter));
                }
            }
        }
        assert!(
            broken.is_empty(),
            "book_refs with no bundled chapter:\n{}",
            broken.join("\n")
        );
    }

    #[test]
    fn lesson_stage_thresholds_match_the_curriculum() {
        // Mirrors the web's lessonToQuiz()/PHASE_NAMES thresholds — if the
        // curriculum regroups, BOTH must move together.
        assert_eq!(super::lesson_stage(1), "Foundations");
        assert_eq!(super::lesson_stage(8), "Foundations");
        assert_eq!(super::lesson_stage(9), "Control Flow");
        assert_eq!(super::lesson_stage(24), "Generics, Traits & Lifetimes");
        assert_eq!(super::lesson_stage(35), "Advanced");
        assert_eq!(super::lesson_stage(36), "Tooling");
        assert_eq!(super::lesson_stage(37), "Tooling");
        // Every bundled lesson (01…37) lands in SOME stage without panicking,
        // and the stage sequence is monotone (never returns to an earlier one).
        let mut seen: Vec<&str> = Vec::new();
        for n in 1..=37 {
            let s = super::lesson_stage(n);
            if seen.last() != Some(&s) {
                assert!(!seen.contains(&s), "stage {s} repeats non-contiguously");
                seen.push(s);
            }
        }
        assert_eq!(seen.len(), 11, "the path has 11 stages");
    }
}
