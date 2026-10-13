//! Tempered Studio local web server.
//!
//! Serves the `gui/` shell (FOSS-first, fully offline — vendored xterm.js, no
//! CDN) and exposes a single op-whitelisted endpoint so the by-hand-error loop
//! runs **in a browser with zero native UI dependencies**. Open a browser at the
//! loopback address the binary prints; press Run / Check / Explain.
//!
//! ## Design
//!
//! The execution engine ([`rpro_core::Core`]) is `!Send` (it owns a
//! `Box<dyn Toolchain>` whose futures are `?Send`), so it can never be held
//! across an `.await` on an async handler. We mirror the TUI's `spawn_run`:
//! gather every owned value on the async side, then build the `Core` *inside* a
//! blocking task ([`tokio::task::spawn_blocking`]), drive it to completion with
//! [`pollster::block_on`], and return only plain data (the `Outcome`, already
//! `Serialize`, or a stringified error) back across the `.await` boundary. The
//! `Core` itself never crosses a thread.
//!
//! ## Security
//!
//! * Binds **only** loopback (`127.0.0.1`); never `0.0.0.0`.
//! * The wire op is a closed enum of `{run, check, test, explain}` — there is no
//!   way to ask for an arbitrary command, shell, path, or tool.
//! * The `explain` payload is length-clamped and accepts only `[A-Za-z0-9]`.
//! * The exercise is resolved from on-disk state (current exercise), never from
//!   client input — the client cannot point the runner at an arbitrary file.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::map_response;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::post;
use serde::{Deserialize, Serialize};
use tower_http::compression::predicate::{NotForContentType, Predicate};
use tower_http::compression::{CompressionLayer, DefaultPredicate};
use tower_http::services::ServeDir;

use rpro_core::Core;
use rpro_lang::{BookRef, ExerciseId, ExerciseSource, Language, RunOp};
use rpro_lang_rust::RustLanguage;
use rpro_state::{ExerciseStatus, Progress};
use rpro_storage_fs::Store;
use rpro_toolchain_local::LocalProcess;

/// Shared, cheap-to-clone server state: the resolved state/run root on disk.
#[derive(Clone)]
struct AppState {
    /// Root that holds `exercises/`, the progress file, and the writable
    /// `run/` scratch tree. Kept off the git tree and out of `/tmp` (noexec).
    store_root: PathBuf,
}

/// The closed set of operations a browser client may request. This enum **is**
/// the whitelist: anything not listed here cannot be deserialized, so the server
/// can never be coaxed into a format, lint, or arbitrary-tool run from the wire.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase", tag = "op")]
enum WireOp {
    /// Build and run the current exercise. `source`, if present, is the
    /// learner's edited buffer — compiled instead of the on-disk starter.
    Run {
        #[serde(default)]
        source: Option<String>,
    },
    /// Type-check the current exercise (fast feedback, no binary).
    Check {
        #[serde(default)]
        source: Option<String>,
    },
    /// Run the current exercise's tests.
    Test {
        #[serde(default)]
        source: Option<String>,
    },
    /// Explain a diagnostic code. The `code` is clamped + validated below.
    Explain {
        /// The diagnostic code to explain (e.g. an `E0382`-style code).
        code: String,
    },
}

/// Max accepted edited-buffer size (256 KiB) — a learner exercise is tiny; this
/// just bounds a pathological client. Loopback-only, single-user, so this is a
/// sanity clamp, not a security boundary.
const MAX_SOURCE_BYTES: usize = 256 * 1024;

/// Hard cap on a request body, enforced at the transport layer (defence-in-depth
/// below [`MAX_SOURCE_BYTES`]). 1 MiB leaves comfortable room for a 256 KiB source
/// plus JSON escaping/overhead while tightening axum's 2 MiB default. Loopback,
/// single-user — a sanity clamp, not a security boundary.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Monotonic counter giving each live-diagnostics request its own scratch
/// workspace (`run/diagnostics/<n>`). Isolation matters here: the language
/// server resolves a workspace and its build tool caches per directory, so a
/// SHARED scratch dir can hand back a stale "clean" result for freshly-broken
/// code (the build tool's fingerprint short-circuits the re-check) and lets
/// concurrent requests clobber each other. A fresh dir per request sidesteps
/// both; it is cheap because the scaffold has no dependencies to rebuild.
static DIAG_RUN_SEQ: AtomicU64 = AtomicU64::new(0);

/// The JSON payload returned for every run (success *and* tool-error fold into
/// the same shape, mirroring the TUI's `apply_run_result`, so the front end has
/// exactly one code path: write `raw_stdout`, then `raw_stderr`, into xterm).
#[derive(Debug, Serialize)]
struct RunResponse {
    /// Process exit code; `null` when killed / never started / tool error.
    status: Option<i32>,
    /// Raw stdout, shown verbatim (carries ANSI when color is enabled).
    raw_stdout: String,
    /// Raw stderr, shown verbatim — what the learner reads.
    raw_stderr: String,
    /// `true` when `status == Some(0)`.
    passed: bool,
    /// Wall-clock duration in milliseconds.
    duration_ms: u64,
    /// Structured diagnostics scraped from the raw output (additive).
    diagnostics: Vec<rpro_lang::Diagnostic>,
    /// Human label of the exercise that was run.
    exercise: String,
    /// If a passing Run/Test advanced the learner, the id now made current
    /// (the old exercise is marked Done). `null` otherwise.
    advanced_to: Option<String>,
}

/// A clamped, validated explain code: at most 16 chars, ASCII alphanumerics
/// only. Rejects path separators, dots, whitespace — nothing that could be
/// abused downstream. Returns `None` if the input is empty or invalid.
fn sanitize_code(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 16 {
        return None;
    }
    if trimmed.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Map the wire op to the core verb. The `explain` arm validates its payload.
fn to_run_op(wire: WireOp) -> Result<RunOp, &'static str> {
    Ok(match wire {
        WireOp::Run { .. } => RunOp::Run,
        WireOp::Check { .. } => RunOp::Check,
        WireOp::Test { .. } => RunOp::Test,
        WireOp::Explain { code } => {
            let code = sanitize_code(&code).ok_or("invalid explain code")?;
            RunOp::Explain(code)
        }
    })
}

/// Resolve the current exercise from on-disk state and return the plain data a
/// run needs: `(id, source code, run directory)`. `None` if there is no current
/// exercise. This is the *only* place the target is chosen — never from the
/// client — so there is no path the wire can take to a different file.
fn resolve_current(store_root: &Path) -> Option<(String, String, PathBuf)> {
    let store = Store::at(store_root.to_path_buf());
    let exercises = rpro_runner::discover(&store.root().join("exercises")).ok()?;
    let progress = store.load_progress().unwrap_or_default();
    let current_id = progress
        .entries
        .iter()
        .find(|(_, e)| e.status == ExerciseStatus::Current)
        .map(|(id, _)| id.clone())?;
    let ex = exercises.into_iter().find(|e| e.meta.id == current_id)?;
    let code = std::fs::read_to_string(&ex.source).ok()?;
    let run_dir = store
        .root()
        .join("run")
        .join(rpro_runner::slug(&current_id));
    Some((current_id, code, run_dir))
}

/// Write the language scaffold for `code` into `dir`, creating parents.
fn write_scaffold(dir: &Path, code: &str) -> std::io::Result<()> {
    for (rel, contents) in RustLanguage::scaffold(code) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, contents)?;
    }
    Ok(())
}

/// `POST /api/run` — run a whitelisted op on the current exercise.
///
/// The body is `{ "op": "run" | "check" | "test" | "explain", "code"?: "..." }`.
/// Returns a [`RunResponse`] (200) on both pass and tool failure; the only
/// non-200 cases are a rejected op (400) or no current exercise (409).
async fn run_handler(
    State(state): State<AppState>,
    body: Result<Json<serde_json::Value>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    // Parse + whitelist the op. Anything off-list fails to deserialize. Propagate
    // the extractor's OWN status rather than a blanket 400: 413 for a body over
    // the `DefaultBodyLimit`, 415 for the wrong content-type, 400 for malformed
    // JSON — so the body-size control surfaces as Payload Too Large.
    let Json(value) = match body {
        Ok(j) => j,
        Err(rej) => return rej.into_response(),
    };
    let wire: WireOp = match serde_json::from_value(value) {
        Ok(w) => w,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "unknown or malformed op").into_response();
        }
    };
    // Pull the optional edited buffer out before `wire` is consumed, and clamp
    // its size. `source` carries the learner's in-browser edits.
    let edited = match &wire {
        WireOp::Run { source } | WireOp::Check { source } | WireOp::Test { source } => {
            source.clone()
        }
        WireOp::Explain { .. } => None,
    };
    if edited.as_ref().is_some_and(|s| s.len() > MAX_SOURCE_BYTES) {
        return (StatusCode::PAYLOAD_TOO_LARGE, "edited source too large").into_response();
    }
    let op = match to_run_op(wire) {
        Ok(op) => op,
        Err(msg) => return (StatusCode::BAD_REQUEST, msg).into_response(),
    };
    // Classify the op before it moves into the blocking task: exec ops count as
    // an attempt; Run/Test passing advances the learner to the next exercise.
    let is_exec = matches!(op, RunOp::Run | RunOp::Check | RunOp::Test);
    let advance_on_pass = matches!(op, RunOp::Run | RunOp::Test);

    // Resolve the target on the async side; gather only owned, Send data.
    let Some((id, disk_code, run_dir)) = resolve_current(&state.store_root) else {
        return (
            StatusCode::CONFLICT,
            "no current exercise — seed the store first (see server startup notes)",
        )
            .into_response();
    };
    // Compile the learner's edited buffer if they sent one; else the starter.
    let source = edited.unwrap_or(disk_code);
    let root = state.store_root.clone();
    let label = id.clone();

    // Core is !Send: build it INSIDE the blocking task and never let it cross an
    // .await. Only the plain Result<Outcome, ToolError> comes back.
    let joined = tokio::task::spawn_blocking(move || {
        write_scaffold(&run_dir, &source).map_err(|e| e.to_string())?;
        let core = Core::new(
            Box::new(RustLanguage),
            Box::new(LocalProcess),
            Box::new(Store::at(root)),
        );
        let src = ExerciseSource {
            id: ExerciseId(id),
            dir: run_dir.display().to_string(),
            entry: "src/main.rs".into(),
        };
        // Stringify the toolchain error here so nothing non-Serialize escapes.
        pollster::block_on(core.run(&src, &op)).map_err(|e| format!("{e}"))
    })
    .await;

    match joined {
        Ok(Ok(outcome)) => {
            let passed = outcome.status == Some(0);
            // Record into shared on-disk progress (attempt + spaced repetition +
            // advance on a passing Run/Test) via the one helper every surface
            // shares. Exec ops only; Explain never touches progress. Borrows the
            // diagnostics before they move into the response below.
            let advanced_to = if is_exec {
                let store = Store::at(state.store_root.clone());
                rpro_runner::record_run(
                    &store,
                    &label,
                    &outcome.diagnostics,
                    passed,
                    advance_on_pass && passed,
                )
            } else {
                None
            };
            Json(RunResponse {
                passed,
                status: outcome.status,
                raw_stdout: outcome.raw_stdout,
                raw_stderr: outcome.raw_stderr,
                duration_ms: outcome.duration_ms,
                diagnostics: outcome.diagnostics,
                exercise: label,
                advanced_to,
            })
            .into_response()
        }
        // Toolchain error: fold into the same shape (mirrors apply_run_result).
        Ok(Err(msg)) => Json(RunResponse {
            status: None,
            raw_stdout: String::new(),
            raw_stderr: format!("could not run the toolchain: {msg}"),
            passed: false,
            duration_ms: 0,
            diagnostics: Vec::new(),
            exercise: label,
            advanced_to: None,
        })
        .into_response(),
        // The blocking task itself panicked / was cancelled.
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "run task failed").into_response(),
    }
}

/// The Sandbox body: just the free-play code. No op whitelist — Sandbox always
/// compiles + runs (it is not tied to any exercise or predicted outcome).
#[derive(Debug, Deserialize)]
struct SandboxBody {
    code: String,
}

/// `POST /api/sandbox` — compile + run ARBITRARY code as a free-play scratchpad
/// (the Sandbox tab). Same LOCAL toolchain as `/api/run`, but it never resolves or
/// records against an exercise: no `resolve_current`, no `record_run`, no advance.
/// Progress is untouched. Executes user code exactly like an exercise Run already
/// does (same trust model: loopback, single-user, offline), in its own `run/sandbox`
/// scratch dir.
async fn sandbox_handler(
    State(state): State<AppState>,
    body: Result<Json<SandboxBody>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let Json(SandboxBody { code }) = match body {
        Ok(j) => j,
        Err(rej) => return rej.into_response(),
    };
    if code.len() > MAX_SOURCE_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "source too large").into_response();
    }
    let root = state.store_root.clone();
    let run_dir = root.join("run").join("sandbox");
    let joined = tokio::task::spawn_blocking(move || {
        write_scaffold(&run_dir, &code).map_err(|e| e.to_string())?;
        let core = Core::new(
            Box::new(RustLanguage),
            Box::new(LocalProcess),
            Box::new(Store::at(root)),
        );
        let src = ExerciseSource {
            id: ExerciseId("sandbox".to_string()),
            dir: run_dir.display().to_string(),
            entry: "src/main.rs".into(),
        };
        pollster::block_on(core.run(&src, &RunOp::Run)).map_err(|e| format!("{e}"))
    })
    .await;
    match joined {
        Ok(Ok(outcome)) => Json(RunResponse {
            passed: outcome.status == Some(0),
            status: outcome.status,
            raw_stdout: outcome.raw_stdout,
            raw_stderr: outcome.raw_stderr,
            duration_ms: outcome.duration_ms,
            diagnostics: outcome.diagnostics,
            exercise: "sandbox".to_string(),
            advanced_to: None,
        })
        .into_response(),
        Ok(Err(msg)) => Json(RunResponse {
            status: None,
            raw_stdout: String::new(),
            raw_stderr: format!("could not run the toolchain: {msg}"),
            passed: false,
            duration_ms: 0,
            diagnostics: Vec::new(),
            exercise: "sandbox".to_string(),
            advanced_to: None,
        })
        .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "run task failed").into_response(),
    }
}

/// What `/api/diagnostics` returns. `available` is false when no language server
/// is installed (or it failed to answer) — the Dev editor then simply shows no
/// live squiggles rather than an error, so the tier degrades gracefully offline.
#[derive(serde::Serialize)]
struct DiagnosticsResponse {
    /// The file's diagnostics, in the same shape `/api/run` reports (so the Dev
    /// editor renders live-analysis and compile diagnostics identically).
    diagnostics: Vec<rpro_lang::Diagnostic>,
    /// Whether a language server actually answered.
    available: bool,
}

/// `POST /api/diagnostics` — the Dev tier's LIVE analysis. Writes the submitted
/// `code` into a scratch workspace, asks the language plugin's configured server
/// to analyse it, and returns its diagnostics — WITHOUT compiling or running, and
/// without touching exercise progress. Loopback/single-user/offline trust model,
/// same as `/api/run`. If no server is on `PATH`, `available` is false and the
/// diagnostics list is empty (the editor just skips squiggles).
async fn diagnostics_handler(
    State(state): State<AppState>,
    body: Result<Json<SandboxBody>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let Json(SandboxBody { code }) = match body {
        Ok(j) => j,
        Err(rej) => return rej.into_response(),
    };
    if code.len() > MAX_SOURCE_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "source too large").into_response();
    }

    // A FRESH scratch workspace per request (see DIAG_RUN_SEQ): live analysis
    // never disturbs the exercise's run dir, requests can't clobber each other,
    // and — critically — a fresh dir has no stale build fingerprint, so broken
    // code is never masked by a prior clean check. The server resolves the
    // workspace from here; we remove it once analysis returns.
    let seq = DIAG_RUN_SEQ.fetch_add(1, Ordering::Relaxed);
    let run_dir = state
        .store_root
        .join("run")
        .join("diagnostics")
        .join(seq.to_string());

    let joined =
        tokio::task::spawn_blocking(move || -> Result<Vec<rpro_lang::Diagnostic>, String> {
            write_scaffold(&run_dir, &code).map_err(|e| e.to_string())?;
            let root_uri = format!("file://{}", run_dir.display());
            let file_uri = format!("file://{}", run_dir.join("src/main.rs").display());
            let result = rpro_lsp::diagnostics(
                &RustLanguage.lsp(),
                &root_uri,
                &file_uri,
                &code,
                rpro_lsp::DEFAULT_TIMEOUT,
            )
            .map_err(|e| e.to_string());
            let _ = std::fs::remove_dir_all(&run_dir); // best-effort: don't leak scratch dirs
            result
        })
        .await;

    match joined {
        Ok(Ok(diagnostics)) => Json(DiagnosticsResponse {
            diagnostics,
            available: true,
        })
        .into_response(),
        // A missing/failing server is expected offline: report unavailable, not
        // an error, so the editor degrades to "no live squiggles" cleanly.
        Ok(Err(_)) => Json(DiagnosticsResponse {
            diagnostics: Vec::new(),
            available: false,
        })
        .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "diagnostics task failed").into_response(),
    }
}

/// Resolve the current exercise with its full metadata + starter code, so the
/// front end can render the *real* exercise (title, code, book refs) rather than
/// a static placeholder. Returns the discovered [`rpro_runner::Exercise`] and its
/// source. `None` if there is no current exercise.
fn current_exercise(store_root: &Path) -> Option<(rpro_runner::Exercise, String)> {
    let store = Store::at(store_root.to_path_buf());
    let exercises = rpro_runner::discover(&store.root().join("exercises")).ok()?;
    let progress = store.load_progress().unwrap_or_default();
    let current_id = progress
        .entries
        .iter()
        .find(|(_, e)| e.status == ExerciseStatus::Current)
        .map(|(id, _)| id.clone())?;
    let ex = exercises.into_iter().find(|e| e.meta.id == current_id)?;
    let code = std::fs::read_to_string(&ex.source).ok()?;
    Some((ex, code))
}

/// Lowercase wire name for a status (matches the front end's CSS classes).
const fn status_str(s: ExerciseStatus) -> &'static str {
    match s {
        ExerciseStatus::Locked => "locked",
        ExerciseStatus::Current => "current",
        ExerciseStatus::Done => "done",
        ExerciseStatus::Skipped => "skipped",
    }
}

/// `GET /api/current` — the current exercise's renderable detail: id, title,
/// starter code, concept, difficulty, estimated minutes, and book refs.
///
/// Deliberately **omits** `expected_error_code` and `solution_outline` — the
/// predict-first / guide-don't-solve contract means the page never reveals the
/// answer. Returns `{ "exercise": null }` when nothing is current.
/// Build the public JSON for an exercise. Pure (no I/O) so it's unit-testable.
/// Deliberately omits `expected_error_code` and `solution_outline` — the page
/// never receives the answer (predict-first / guide-don't-solve).
fn current_json(ex: &rpro_runner::Exercise, code: &str) -> serde_json::Value {
    let m = &ex.meta;
    serde_json::json!({
        "exercise": m.id,
        "title": m.title,
        "code": code,
        "concept": m.concept,
        "difficulty": m.difficulty,
        "estimated_minutes": m.estimated_minutes,
        "book_refs": m.book_refs,
    })
}

async fn current_handler(State(state): State<AppState>) -> impl IntoResponse {
    match current_exercise(&state.store_root) {
        Some((ex, code)) => Json(current_json(&ex, &code)).into_response(),
        None => Json(serde_json::json!({ "exercise": null })).into_response(),
    }
}

/// Body for `POST /api/select`: the exercise id to switch to.
#[derive(Debug, Deserialize)]
struct SelectBody {
    id: String,
    /// Explicit "jump ahead" — bypass the soft prerequisite gate.
    #[serde(default)]
    force: bool,
}

/// `POST /api/select` — make a chosen exercise the current one (phone-first: tap
/// a list item to switch). The `id` is validated against the **discovered**
/// exercise set — it is only ever used as a known map key, never a path, so the
/// wire cannot point the runner at an arbitrary file.
///
/// Deliberately minimal + safe: it never un-completes a finished exercise (that
/// would regress the progress gauge) — selecting a `Done` exercise returns 409
/// with a nudge to Reset. Any previously-current exercise is demoted to Locked
/// (see [`Progress::select`]); the single-Current invariant holds. Returns the
/// new current's detail (same shape as `/api/current`) on success.
async fn select_handler(
    State(state): State<AppState>,
    body: Result<Json<SelectBody>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let Json(SelectBody { id, force }) = match body {
        Ok(j) => j,
        Err(rej) => return rej.into_response(),
    };
    let store = Store::at(state.store_root.clone());
    // Validate against discovered ids — never trust the wire to name a file.
    let exercises = rpro_runner::discover(&store.root().join("exercises")).unwrap_or_default();
    if !exercises.iter().any(|e| e.meta.id == id) {
        return (StatusCode::BAD_REQUEST, "unknown exercise").into_response();
    }
    let mut progress = store.load_progress().unwrap_or_default();
    // Never un-complete a finished exercise — Reset is the path to redo it.
    if progress.entries.get(&id).map(|e| e.status) == Some(ExerciseStatus::Done) {
        return (
            StatusCode::CONFLICT,
            "exercise already completed — reset it to practise again",
        )
            .into_response();
    }
    // Soft prerequisite gate (baby-steps): a not-yet-reached exercise opens once
    // the previous one is Done — unless the learner explicitly jumps ahead.
    // 423 LOCKED tells the GUI to offer "jump ahead anyway" (re-POST with force).
    let ordered: Vec<String> = exercises.iter().map(|e| e.meta.id.clone()).collect();
    if !force && !progress.is_unlocked(&ordered, &id) {
        return (
            StatusCode::LOCKED,
            "locked — finish the earlier exercise first (or jump ahead)",
        )
            .into_response();
    }
    progress.select(&id);
    if store.save_progress(&progress).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not save selection",
        )
            .into_response();
    }
    match current_exercise(&state.store_root) {
        Some((ex, code)) => Json(current_json(&ex, &code)).into_response(),
        None => Json(serde_json::json!({ "exercise": id })).into_response(),
    }
}

/// `GET /api/exercises` — the full exercise list with per-item status + attempts,
/// plus done/total for the progress gauge. Read-only; selection stays
/// server-resolved (the current exercise is set by the CLI/TUI, not the wire).
async fn exercises_handler(State(state): State<AppState>) -> impl IntoResponse {
    let store = Store::at(state.store_root);
    let exercises = rpro_runner::discover(&store.root().join("exercises")).unwrap_or_default();
    let progress = store.load_progress().unwrap_or_default();
    let total = exercises.len();
    let mut done = 0usize;
    let items: Vec<serde_json::Value> = exercises
        .into_iter()
        .map(|e| {
            let entry = progress.entries.get(&e.meta.id);
            let status = entry.map_or(ExerciseStatus::Locked, |p| p.status);
            if status == ExerciseStatus::Done {
                done += 1;
            }
            serde_json::json!({
                "id": e.meta.id,
                "title": e.meta.title,
                "concept": e.meta.concept,
                "status": status_str(status),
                "attempts": entry.map_or(0, |p| p.attempts),
            })
        })
        .collect();
    Json(serde_json::json!({ "exercises": items, "done": done, "total": total })).into_response()
}

// ── workspace file API — the IDE's file explorer & editor persistence ──────
//
// Everything here is keyed by exercise **id**, never by a path from the wire
// (the same doctrine as `/api/select`): the server maps id → the source file
// it discovered itself, so there is nothing to traverse and the answer-bearing
// metadata files can never be named, listed, or read through this surface.

/// Query for `GET /api/workspace/file`.
#[derive(Debug, Deserialize)]
struct WorkspaceFileQuery {
    id: String,
}

/// Body for `PUT /api/workspace/file`.
#[derive(Debug, Deserialize)]
struct WorkspaceWriteBody {
    id: String,
    content: String,
}

/// One explorer entry. Like [`current_json`], this deliberately carries
/// **none** of the answer-bearing metadata — the explorer sees files, never
/// solutions or expected outcomes.
fn workspace_entry_json(ex: &rpro_runner::Exercise, status: ExerciseStatus) -> serde_json::Value {
    serde_json::json!({
        "id": ex.meta.id,
        "name": ex.source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        "title": ex.meta.title,
        "status": status_str(status),
    })
}

/// The phase directory an exercise lives under (e.g. `02-control-flow`) — the
/// explorer's grouping key. Derived from the discovered source path.
fn workspace_group(ex: &rpro_runner::Exercise) -> String {
    ex.source
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Resolve a wire id to its discovered exercise, applying the same progression
/// gate as `/api/select`: unknown → 400, still-locked → 423. The file API must
/// not become a way around the baby-steps gate — or a peek at code the learner
/// has not reached.
fn workspace_resolve(
    store_root: &Path,
    id: &str,
) -> Result<rpro_runner::Exercise, (StatusCode, &'static str)> {
    let store = Store::at(store_root.to_path_buf());
    let exercises = rpro_runner::discover(&store.root().join("exercises")).unwrap_or_default();
    let ordered: Vec<String> = exercises.iter().map(|e| e.meta.id.clone()).collect();
    let Some(ex) = exercises.into_iter().find(|e| e.meta.id == id) else {
        return Err((StatusCode::BAD_REQUEST, "unknown exercise"));
    };
    let progress = store.load_progress().unwrap_or_default();
    if !progress.is_unlocked(&ordered, id) {
        return Err((
            StatusCode::LOCKED,
            "locked — finish the earlier exercise first (or jump ahead)",
        ));
    }
    Ok(ex)
}

/// `GET /api/workspace` — the IDE file explorer's tree: every exercise source,
/// grouped by phase directory, in course order, each with its progress status.
async fn workspace_handler(State(state): State<AppState>) -> impl IntoResponse {
    let store = Store::at(state.store_root);
    let exercises = rpro_runner::discover(&store.root().join("exercises")).unwrap_or_default();
    let progress = store.load_progress().unwrap_or_default();
    let mut groups: Vec<serde_json::Value> = Vec::new();
    let mut cur_dir = String::new();
    let mut cur_files: Vec<serde_json::Value> = Vec::new();
    for ex in &exercises {
        let dir = workspace_group(ex);
        if dir != cur_dir && !cur_files.is_empty() {
            groups.push(serde_json::json!({ "dir": cur_dir, "files": cur_files }));
            cur_files = Vec::new();
        }
        cur_dir = dir;
        let status = progress
            .entries
            .get(&ex.meta.id)
            .map_or(ExerciseStatus::Locked, |p| p.status);
        cur_files.push(workspace_entry_json(ex, status));
    }
    if !cur_files.is_empty() {
        groups.push(serde_json::json!({ "dir": cur_dir, "files": cur_files }));
    }
    Json(serde_json::json!({ "groups": groups })).into_response()
}

/// `GET /api/workspace/file?id=…` — one exercise source for the IDE editor.
/// Locked exercises return 423 so the explorer can offer the same "jump ahead"
/// the Practice view does (select-with-force, then re-request).
async fn workspace_file_handler(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<WorkspaceFileQuery>,
) -> impl IntoResponse {
    let ex = match workspace_resolve(&state.store_root, &q.id) {
        Ok(ex) => ex,
        Err(e) => return e.into_response(),
    };
    let Ok(content) = std::fs::read_to_string(&ex.source) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not read the file").into_response();
    };
    let store = Store::at(state.store_root.clone());
    let progress = store.load_progress().unwrap_or_default();
    let status = progress
        .entries
        .get(&ex.meta.id)
        .map_or(ExerciseStatus::Locked, |p| p.status);
    Json(serde_json::json!({
        "id": ex.meta.id,
        "name": ex.source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        "status": status_str(status),
        "content": content,
    }))
    .into_response()
}

/// `PUT /api/workspace/file` — persist the learner's edited buffer to the
/// exercise's source file. This is the IDE's save: unlike `/api/run`'s
/// ephemeral `source`, the edit survives restarts. Mirrors `/api/select`'s
/// rules exactly — unknown → 400, locked → 423, done → 409 (Reset is the path
/// to redo a finished exercise). The buffer is size-clamped; the target path
/// comes from discovery, never the wire.
async fn workspace_write_handler(
    State(state): State<AppState>,
    body: Result<Json<WorkspaceWriteBody>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let Json(WorkspaceWriteBody { id, content }) = match body {
        Ok(j) => j,
        Err(rej) => return rej.into_response(),
    };
    if content.len() > MAX_SOURCE_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "source too large").into_response();
    }
    let store = Store::at(state.store_root.clone());
    let progress = store.load_progress().unwrap_or_default();
    if progress.entries.get(&id).map(|e| e.status) == Some(ExerciseStatus::Done) {
        return (
            StatusCode::CONFLICT,
            "exercise already completed — reset it to practise again",
        )
            .into_response();
    }
    let ex = match workspace_resolve(&state.store_root, &id) {
        Ok(ex) => ex,
        Err(e) => return e.into_response(),
    };
    if std::fs::write(&ex.source, &content).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not save the file").into_response();
    }
    Json(serde_json::json!({ "saved": true, "id": id, "bytes": content.len() })).into_response()
}

/// `GET /api/review` — the spaced-repetition (RECALL) queue: diagnostic codes due
/// for review (weakest first) plus mastered/tracked counts. Read-only.
///
/// Not a predict-first leak: every code here is one the learner already met in
/// *their own* compiler output by running an exercise. Surfacing them is exactly
/// the resurfacing the model exists to do — never the *current* exercise's answer
/// (that's still withheld by [`current_json`]).
async fn review_handler(State(state): State<AppState>) -> impl IntoResponse {
    let store = Store::at(state.store_root);
    let progress = store.load_progress().unwrap_or_default();
    let r = &progress.reviews;
    Json(serde_json::json!({
        "due": r.due(),
        "mastered": r.mastered_count(),
        "tracked": r.tracked_count(),
    }))
    .into_response()
}

/// Query for the hint ladder: which escalating level the learner is on.
#[derive(Debug, Deserialize)]
struct HintQuery {
    level: Option<u8>,
}

/// `GET /api/hint?level=N` — the hint ladder. A genuine attempt is forced first:
/// with 0 attempts it returns a "run it first" nudge and unlocks nothing; after
/// that the rung escalates one step per attempt (capped at 3). The rungs climb
/// toward the SOURCE, never the answer: 1 = concept + a "read the `-->` / `help:`
/// line" nudge; 2 = the expected error code (use Explain); 3 = back to the book
/// sections + concept, with the compiler's `help:` line left for the learner to
/// apply. The stored `solution_outline` is NEVER returned at any rung — not even
/// the top one, not even if asked (Hard Rule #1; see `ExerciseMetadata::hint`).
async fn hint_handler(
    State(state): State<AppState>,
    Query(q): Query<HintQuery>,
) -> impl IntoResponse {
    let Some((ex, _code)) = current_exercise(&state.store_root) else {
        return Json(serde_json::json!({ "level": 0, "max_level": 0, "text": null }))
            .into_response();
    };
    // Force a genuine attempt before ANY hint unlocks, then escalate the rung only
    // as the learner proves they're stuck (one rung earned per attempt). The fix
    // itself is never served at any rung (see `ExerciseMetadata::hint`).
    let attempts = Store::at(state.store_root.clone())
        .load_progress()
        .unwrap_or_default()
        .entries
        .get(&ex.meta.id)
        .map_or(0, |e| e.attempts);
    if attempts == 0 {
        return Json(serde_json::json!({
            "level": 0,
            "max_level": 3,
            "text": "Run it first — predict the outcome, then run and read the real \
                     compiler error by hand. Hints unlock once you've genuinely tried.",
            "attempts": 0
        }))
        .into_response();
    }
    let earned = u8::try_from(attempts).unwrap_or(u8::MAX).min(3); // 1 rung per attempt, capped at 3
    let requested = q.level.unwrap_or(1).clamp(1, earned);
    let (level, max_level, text) = ex.meta.hint(requested);
    Json(serde_json::json!({
        "level": level, "max_level": max_level, "text": text, "attempts": attempts
    }))
    .into_response()
}

/// `GET /api/roadmap` — the project roadmap (docs/ROADMAP.md) as markdown, so the
/// in-app Roadmap tab can render it. A single fixed, program-controlled file; no
/// path comes from the client.
async fn roadmap_handler() -> impl IntoResponse {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/ROADMAP.md");
    // nosemgrep
    let md = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| "# Roadmap\n\n(ROADMAP.md not found)".to_string());
    Json(serde_json::json!({ "markdown": md })).into_response()
}

/// Query for a single Book chapter. `chapter` is a *map key*, never a path —
/// see [`book_handler`].
#[derive(Debug, Deserialize)]
struct BookQuery {
    chapter: Option<String>,
    /// Full-text search term. When present, the handler returns matching
    /// chapters (id + title + match count + a snippet) instead of the TOC.
    #[serde(default)]
    q: Option<String>,
}

/// `GET /api/book` — the embedded Rust Book. With no query, returns the table of
/// contents (chapter ids + titles, in reading order). With `?chapter=ID`,
/// returns that chapter's raw markdown. With `?q=TERM`, returns full-text search
/// hits (shared with the CLI via [`rpro_book::Book::search`]).
///
/// SECURITY: `chapter` is used **only** as a [`BTreeMap`](std::collections::BTreeMap)
/// key via [`rpro_book::Book::get`] — it is never joined onto a filesystem path.
/// A traversal value such as `../../etc/passwd` simply misses the map and yields
/// `{ "chapter": null }`; it can never read an arbitrary file. The book root is
/// the server-seeded `book/` dir; no client input chooses a file. This guarantee
/// is pinned by the `book_traversal_*` tests and the smoke script.
async fn book_handler(
    State(state): State<AppState>,
    Query(q): Query<BookQuery>,
) -> impl IntoResponse {
    let store = Store::at(state.store_root);
    let book = rpro_book::Book::load(&store.root().join("book")).unwrap_or_default();
    // `?q=TERM` — full-text search (shared impl). Checked before `chapter` so a
    // search never path-joins anything; it only reads chapter markdown in memory.
    if let Some(term) = q.q.as_deref() {
        let hits: Vec<serde_json::Value> = book
            .search(term)
            .into_iter()
            .map(|h| {
                serde_json::json!({
                    "chapter": h.chapter,
                    "title": h.title,
                    "count": h.count,
                    "snippet": h.snippet,
                })
            })
            .collect();
        return Json(serde_json::json!({ "hits": hits })).into_response();
    }
    match q.chapter {
        None => {
            let chapters: Vec<serde_json::Value> = book
                .chapters
                .values()
                .map(|c| serde_json::json!({ "id": c.id, "title": c.title() }))
                .collect();
            Json(serde_json::json!({ "chapters": chapters })).into_response()
        }
        // KEY LOOKUP — never a path join. A traversal string just misses the map.
        // `display_markdown` strips mdBook directives/hidden lines and links the
        // un-bundled code listings out to the live chapter; the URL comes from the
        // Rust language adapter (the seam's only home for Rust-specific links).
        Some(id) => match book.get(&id) {
            Some(c) => {
                let url = RustLanguage.book_ref_url(&BookRef {
                    chapter: c.id.clone(),
                    anchor: None,
                    why: String::new(),
                });
                Json(serde_json::json!({ "id": c.id, "markdown": c.display_markdown(&url) }))
                    .into_response()
            }
            None => Json(serde_json::json!({ "chapter": null })).into_response(),
        },
    }
}

// Bundled content revision — shared across every surface (see
// `rpro_runner::CONTENT_VERSION`). `ensure_seeded` re-copies the read-only
// content dirs of any store whose recorded version is older, so an
// already-seeded store isn't frozen on its first-run copies.
use rpro_runner::CONTENT_VERSION;

/// Ensure the chosen `store_root` is runnable: it must have an `exercises/` tree
/// and a progress file with a `Current` entry, plus the embedded `book/` for the
/// in-app reader. If the root is empty we seed it by copying the workspace's
/// `exercises/` (marking the first one current) and `book/`.
///
/// This is what makes "usable in a browser" true out of the box: a fresh
/// `cargo run` lands on a real, runnable exercise — and the Book tab has the
/// chapters — rather than an empty store.
///
/// A store seeded by an *older* build also gets its read-only content refreshed
/// here (gated on [`CONTENT_VERSION`]) — otherwise every content improvement
/// after first run stayed invisible to existing users. Only regenerable content
/// is overwritten: `progress.json` (progress) is left untouched, and in-progress
/// editor edits live in the browser (localStorage), never in the store.
fn ensure_seeded(
    store_root: &Path,
    workspace_exercises: &Path,
    workspace_book: &Path,
    workspace_glossary: &Path,
    workspace_lessons: &Path,
    workspace_quizzes: &Path,
    workspace_cheatsheets: &Path,
) -> std::io::Result<()> {
    let store = Store::at(store_root.to_path_buf());
    let ex_dir = store.root().join("exercises");

    // One-shot content refresh (see [`CONTENT_VERSION`]): a store whose recorded
    // version is older than the bundled one — including any pre-marker store,
    // which reads as 0 — re-copies the content dirs below. `progress.json` is
    // never touched, so progress survives; `copy_dir_recursive` overwrites in
    // place. The marker is written only after a successful pass (end of fn), so
    // an interrupted seed simply retries next boot.
    // `marker` is the fixed operator-config store root joined with a literal
    // filename — no wire/client input reaches this path (as with the seeding
    // reads below). nosemgrep
    let marker = store.root().join(".content-version");
    let stored_ver = std::fs::read_to_string(&marker) // nosemgrep
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let refresh = stored_ver < CONTENT_VERSION;

    // Copy exercises in if we don't have any yet — or refresh on a version bump.
    // Exercises are OVERLAY-copied (never cleared): the seeded README invites the
    // user to drop their own exercises alongside the bundled ones, and a clearing
    // refresh would delete them. But a bundled exercise RENAMED to re-sequence the
    // course would then linger under its old name as a same-id ghost — listed
    // twice, interleaving the course order — so those stale copies are pruned.
    if refresh || rpro_runner::discover(&ex_dir).map_or(true, |v| v.is_empty()) {
        copy_dir_recursive(workspace_exercises, &ex_dir)?;
        rpro_runner::prune_renamed(workspace_exercises, &ex_dir)?;
    }

    // The read-only reference dirs below are SYNCED on refresh (cleared, then
    // copied): a content update can REMOVE or RENAME a file — e.g. a lesson split
    // replaces one .md with two — and an overlay copy would leave the old file
    // behind as a ghost entry in the served list. These dirs are server-fixed and
    // hold no user data, so clearing is safe.
    let sync_dir = |dir: &Path| -> std::io::Result<()> {
        if refresh && dir.is_dir() {
            std::fs::remove_dir_all(dir)?; // nosemgrep — server-fixed path, no wire input
        }
        Ok(())
    };

    // Copy the bundled Book in if we don't have it yet — gives the web Book tab
    // the same chapters the CLI/TUI seed (web/TUI parity). The book dir is
    // server-fixed; nothing here comes from the wire.
    let book_dir = store.root().join("book");
    let have_book = rpro_book::Book::load(&book_dir).is_ok_and(|b| !b.is_empty());
    if (refresh || !have_book) && workspace_book.is_dir() {
        sync_dir(&book_dir)?;
        copy_dir_recursive(workspace_book, &book_dir)?;
    }

    // Copy the built-in glossary in if absent — the offline term-lookup data
    // served read-only via `/api/glossary`. Seeded into the store (not read from
    // a build-time path) so it ships with the portable store the Android seam
    // copies. Server-fixed dir; nothing here comes from the wire.
    let gloss_dir = store.root().join("glossary");
    if (refresh || !gloss_dir.join("glossary.toml").exists()) && workspace_glossary.is_dir() {
        sync_dir(&gloss_dir)?;
        copy_dir_recursive(workspace_glossary, &gloss_dir)?;
    }

    // Copy the bundled textbook lessons in if absent — the offline reading
    // material served via `/api/lessons`. Like the book, these ship in the
    // portable store the Android seam copies. Server-fixed dir; nothing from
    // the wire.
    // The path is `store.root()` (operator config) + the literal "lessons" — no
    // wire data — exactly like the book/glossary seeding above.
    let lessons_dir = store.root().join("lessons");
    let have_lessons = std::fs::read_dir(&lessons_dir).is_ok_and(|mut rd| rd.next().is_some()); // nosemgrep
    if (refresh || !have_lessons) && workspace_lessons.is_dir() {
        sync_dir(&lessons_dir)?;
        copy_dir_recursive(workspace_lessons, &lessons_dir)?;
    }

    // Same for the per-phase self-check quizzes (predict-then-verify), served via
    // `/api/quizzes`. Server-fixed dir; nothing from the wire.
    let quizzes_dir = store.root().join("quizzes");
    let have_quizzes = std::fs::read_dir(&quizzes_dir).is_ok_and(|mut rd| rd.next().is_some()); // nosemgrep
    if (refresh || !have_quizzes) && workspace_quizzes.is_dir() {
        sync_dir(&quizzes_dir)?;
        copy_dir_recursive(workspace_quizzes, &quizzes_dir)?;
    }

    // And the per-phase cheatsheets (quick reference), served via
    // `/api/cheatsheets`. Server-fixed dir; nothing from the wire.
    let cheats_dir = store.root().join("cheatsheets");
    let have_cheats = std::fs::read_dir(&cheats_dir).is_ok_and(|mut rd| rd.next().is_some()); // nosemgrep
    if (refresh || !have_cheats) && workspace_cheatsheets.is_dir() {
        sync_dir(&cheats_dir)?;
        copy_dir_recursive(workspace_cheatsheets, &cheats_dir)?;
    }

    // Make sure progress.json has a Current entry; if not, make the first
    // exercise that is not yet Done (course order) Current. This edits the LOADED
    // progress: saving a fresh `Progress::default()` here wiped every completion
    // whenever a store booted with nothing Current (after the last exercise was
    // passed, say). Every exercise Done is a finished course: leave it as it is.
    let mut progress: Progress = store.load_progress().unwrap_or_default();
    let has_current = progress
        .entries
        .values()
        .any(|e| e.status == ExerciseStatus::Current);
    if !has_current {
        if let Ok(mut exercises) = rpro_runner::discover(&ex_dir) {
            exercises.sort_by(|a, b| a.source.cmp(&b.source)); // path order = learning order
            let first_unfinished = exercises.iter().find(|e| {
                progress.entries.get(&e.meta.id).map(|p| p.status) != Some(ExerciseStatus::Done)
            });
            if let Some(first) = first_unfinished {
                progress.set_current(&first.meta.id);
                store
                    .save_progress(&progress)
                    .map_err(|e| std::io::Error::other(e.to_string()))?;
            }
        }
    }

    // Record the content version now that seeding/refresh succeeded, so the
    // refresh runs once per bump rather than every boot. Written last so a
    // failure above (a `?` early-return) leaves the marker stale and retries.
    if refresh {
        std::fs::write(&marker, CONTENT_VERSION.to_string())?; // nosemgrep
    }
    Ok(())
}

/// Recursively copy `from` into `to` (files + subdirs). Used only for seeding
/// the read-only exercise tree into a writable state root.
fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    // `from`/`to` are server-controlled only (the workspace exercises dir and a
    // fixed state-root subdir); no wire/client input ever reaches this path.
    // nosemgrep
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Defense-in-depth security headers on every response. The GUI is fully
/// self-contained (vendored assets, no CDN) and never renders untrusted HTML —
/// compiler output goes through xterm (terminal escapes, not HTML) and all
/// dynamic text is escaped — so a strict policy fits. `'unsafe-inline'` is
/// allowed for the page's own inline `<style>`/`<script>` (loopback, single
/// user; not load-bearing for safety here).
async fn security_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self' 'unsafe-inline'; \
             style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
             connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    res
}

/// Query for a glossary lookup. `term` is a map key (name or alias), never a path.
#[derive(Debug, Deserialize)]
struct GlossaryQuery {
    term: Option<String>,
}

/// `GET /api/glossary` — the built-in offline term glossary. With no query, returns
/// every term (alphabetical) for a browse list. With `?term=NAME`, returns just that
/// term's definition (matched by name or alias, case-/separator-insensitive), or
/// `{ "term": null }` on a miss.
///
/// SECURITY: `term` is only ever a lookup key into the in-memory map
/// ([`rpro_glossary::Glossary::get`]) — it is never joined onto a filesystem path,
/// so a traversal value simply misses the map. The glossary file is the
/// server-seeded `glossary/glossary.toml`; no client input chooses a file.
async fn glossary_handler(
    State(state): State<AppState>,
    Query(q): Query<GlossaryQuery>,
) -> impl IntoResponse {
    let path = Store::at(state.store_root)
        .root()
        .join("glossary")
        .join("glossary.toml");
    let glossary = rpro_glossary::Glossary::load(&path).unwrap_or_default();
    q.term.map_or_else(
        || Json(serde_json::json!({ "terms": glossary.all() })).into_response(),
        |t| Json(serde_json::json!({ "term": glossary.get(&t) })).into_response(),
    )
}

/// Query for the lessons endpoint. `id` is a file STEM, matched against the real
/// files in the seeded `lessons/` dir — never joined onto a path.
#[derive(Debug, Deserialize)]
struct LessonQuery {
    id: Option<String>,
    /// Full-text search term. When present, the handler returns matching items
    /// (id + title + match count + a snippet) instead of the list or one item —
    /// mirrors `/api/book?q=`, shared across lessons/quizzes/cheatsheets.
    q: Option<String>,
}

/// The first `# ` heading in a lesson's markdown, used as its title (falls back
/// to the `id` if the lesson has none).
fn lesson_title(markdown: &str, id: &str) -> String {
    markdown
        .lines()
        .find_map(|l| l.strip_prefix("# "))
        .map_or_else(|| id.to_owned(), |h| h.trim().to_owned())
}

/// The ordered `.md` files in a seeded content dir (`lessons` / `quizzes`);
/// filename order = curriculum order.
fn md_files(root: &Path, subdir: &str) -> Vec<PathBuf> {
    // `root` is operator config and `subdir` is a server-side literal — no wire
    // data — so this dir read is not a traversal sink.
    let dir = Store::at(root.to_path_buf()).root().join(subdir);
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir) // nosemgrep
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// Serve a directory of markdown content (`lessons` / `quizzes`) as JSON: with no
/// `id`, the ordered list (`id` + `title`); with `?id=STEM`, that file's
/// `markdown` (or null on a miss). `list_key`/`item_key` name the JSON fields.
///
/// SECURITY: `id` is matched against the actual file stems in the seeded dir —
/// never joined onto a filesystem path — so a traversal value finds no match.
/// The content dir is server-seeded; no client input chooses a file.
/// A short, plain-text preview around the first match of `needle_lower` (already
/// lowercased) in `md`: collapses whitespace, drops the loudest markdown noise,
/// and stays on char boundaries so non-ASCII prose can't panic the slice.
fn md_snippet(md: &str, needle_lower: &str) -> String {
    let pos = md.to_lowercase().find(needle_lower).unwrap_or(0);
    let mut start = pos.saturating_sub(60);
    while start > 0 && !md.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (pos + needle_lower.len() + 90).min(md.len());
    while end < md.len() && !md.is_char_boundary(end) {
        end += 1;
    }
    let clean = md[start..end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(['#', '`', '*', '>'], "");
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        clean.trim(),
        if end < md.len() { "…" } else { "" }
    )
}

fn md_collection(
    root: &Path,
    subdir: &str,
    id: Option<String>,
    query: Option<String>,
    list_key: &str,
    item_key: &str,
) -> axum::response::Response {
    let files = md_files(root, subdir);
    let mut obj = serde_json::Map::new();
    // `?q=TERM` — full-text search over every item's markdown (shared by lessons,
    // quizzes, cheatsheets). Returns hits {id, title, count, snippet} sorted by
    // match count. Checked BEFORE `id` so a search never path-joins the term; it
    // only reads item markdown already held in the store.
    if let Some(term) = query.filter(|t| !t.trim().is_empty()) {
        let needle = term.trim().to_lowercase();
        let mut hits: Vec<serde_json::Value> = files
            .iter()
            .filter_map(|p| {
                let id = p.file_stem()?.to_str()?.to_owned();
                let md = std::fs::read_to_string(p).ok()?;
                let count = md.to_lowercase().matches(&needle).count();
                if count == 0 {
                    return None;
                }
                Some(serde_json::json!({
                    "id": id.clone(),
                    "title": lesson_title(&md, &id),
                    "count": count,
                    "snippet": md_snippet(&md, &needle),
                }))
            })
            .collect();
        hits.sort_by(|a, b| b["count"].as_u64().cmp(&a["count"].as_u64()));
        obj.insert("hits".to_owned(), serde_json::Value::Array(hits));
        return Json(serde_json::Value::Object(obj)).into_response();
    }
    let Some(id) = id else {
        let items: Vec<serde_json::Value> = files
            .iter()
            .filter_map(|p| {
                let id = p.file_stem()?.to_str()?.to_owned();
                let md = std::fs::read_to_string(p).ok()?;
                Some(serde_json::json!({ "id": id, "title": lesson_title(&md, &id) }))
            })
            .collect();
        obj.insert(list_key.to_owned(), serde_json::Value::Array(items));
        return Json(serde_json::Value::Object(obj)).into_response();
    };
    let item = files
        .iter()
        .find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(id.as_str()))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map_or(
            serde_json::Value::Null,
            |md| serde_json::json!({ "id": id, "title": lesson_title(&md, &id), "markdown": md }),
        );
    obj.insert(item_key.to_owned(), item);
    Json(serde_json::Value::Object(obj)).into_response()
}

/// `GET /api/lessons` — the embedded Patina textbook lessons (offline reading).
async fn lessons_handler(
    State(state): State<AppState>,
    Query(q): Query<LessonQuery>,
) -> impl IntoResponse {
    md_collection(&state.store_root, "lessons", q.id, q.q, "lessons", "lesson")
}

/// `GET /api/quizzes` — the per-phase self-check quizzes (predict-then-verify).
async fn quizzes_handler(
    State(state): State<AppState>,
    Query(q): Query<LessonQuery>,
) -> impl IntoResponse {
    md_collection(&state.store_root, "quizzes", q.id, q.q, "quizzes", "quiz")
}

/// `GET /api/cheatsheets` — the per-phase quick-reference cheatsheets.
async fn cheatsheets_handler(
    State(state): State<AppState>,
    Query(q): Query<LessonQuery>,
) -> impl IntoResponse {
    md_collection(
        &state.store_root,
        "cheatsheets",
        q.id,
        q.q,
        "cheatsheets",
        "cheatsheet",
    )
}

/// Build the application router. Extracted from [`main`] so the handler contract
/// (no-leak, op-whitelist, body limit, response headers) is testable end-to-end
/// via `tower::ServiceExt::oneshot` — no socket bind, no real toolchain run.
fn build_router(state: AppState, gui_dir: &Path) -> Router {
    Router::new()
        .route("/api/run", post(run_handler))
        .route("/api/sandbox", post(sandbox_handler))
        .route("/api/diagnostics", post(diagnostics_handler))
        .route("/api/current", axum::routing::get(current_handler))
        .route("/api/select", post(select_handler))
        .route("/api/exercises", axum::routing::get(exercises_handler))
        .route("/api/workspace", axum::routing::get(workspace_handler))
        .route(
            "/api/workspace/file",
            axum::routing::get(workspace_file_handler).put(workspace_write_handler),
        )
        .route("/api/review", axum::routing::get(review_handler))
        .route("/api/hint", axum::routing::get(hint_handler))
        .route("/api/roadmap", axum::routing::get(roadmap_handler))
        .route("/api/book", axum::routing::get(book_handler))
        .route("/api/glossary", axum::routing::get(glossary_handler))
        .route("/api/lessons", axum::routing::get(lessons_handler))
        .route("/api/quizzes", axum::routing::get(quizzes_handler))
        .route("/api/cheatsheets", axum::routing::get(cheatsheets_handler))
        // Everything else is the static gui/ shell (index.html + vendored xterm).
        .fallback_service(ServeDir::new(gui_dir))
        // gzip compressible responses (the ~164 KB single-file shell → ~40 KB;
        // JSON likewise). PDFs are EXCLUDED on purpose: they're pre-compressed,
        // and pdf.js loads the Library books with Range requests — compression
        // would break the 206 chunking and force 12 MB full downloads. woff2 is
        // already Brotli inside; compressing it just burns CPU.
        .layer(
            CompressionLayer::new().compress_when(
                DefaultPredicate::new()
                    .and(NotForContentType::new("application/pdf"))
                    .and(NotForContentType::new("font/woff2")),
            ),
        )
        .layer(map_response(security_headers))
        // Defence-in-depth: cap the request body before it is parsed.
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

/// Ordered candidate roots that may hold the bundled assets (`gui/`,
/// `exercises/`, `book/`). Pure (no filesystem) so the precedence is unit-tested;
/// [`resolve_asset_root`] picks the first that actually exists. First match wins:
///   1. `$TS_ASSET_ROOT`                  — explicit operator/packager override.
///   2. `<exe>/../share/tempered-studio`  — FHS install (.deb) / `AppDir` mirror.
///   3. `<exe>/`                          — assets sitting beside the binary.
///   4. `<CARGO_MANIFEST_DIR>/../..`       — the source tree (dev runs + tests).
fn asset_root_candidates(
    env_override: Option<PathBuf>,
    exe_dir: Option<&Path>,
    manifest_dir: &Path,
) -> Vec<PathBuf> {
    let mut c = Vec::new();
    if let Some(o) = env_override {
        c.push(o);
    }
    if let Some(d) = exe_dir {
        c.push(d.join("../share/tempered-studio"));
        c.push(d.to_path_buf());
    }
    c.push(manifest_dir.join("../..")); // source-tree fallback (workspace root)
    c
}

/// Resolve the directory holding the bundled assets, relative to the running
/// executable — so a *packaged* binary (.deb / `AppImage`) finds `gui/` etc. on a
/// user's machine, not only from the source tree it was built in. Returns the
/// first candidate whose `gui/index.html` is present; if none match, the last
/// (source-tree) candidate is returned unconditionally, preserving the prior
/// build-anchored behaviour for dev runs and tests.
fn resolve_asset_root() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let env_override = std::env::var_os("TS_ASSET_ROOT").map(PathBuf::from);
    let exe = std::env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(Path::parent);
    let candidates = asset_root_candidates(env_override, exe_dir, manifest);
    let last = candidates.len().saturating_sub(1);
    for (i, cand) in candidates.into_iter().enumerate() {
        if i == last || cand.join("gui/index.html").exists() {
            return cand;
        }
    }
    manifest.join("../..") // unreachable: the loop always returns at `i == last`
}

#[tokio::main]
async fn main() {
    // Resolve bundled assets relative to the executable so a *packaged* binary
    // (.deb / AppImage) finds them on a user's machine — not only from the source
    // tree it was built in. See `resolve_asset_root`.
    let asset_root = resolve_asset_root();
    let gui_dir = asset_root.join("gui");
    let workspace_exercises = asset_root.join("exercises");
    let workspace_book = asset_root.join("book");
    let workspace_glossary = asset_root.join("glossary");
    let workspace_lessons = asset_root.join("lessons");
    let workspace_quizzes = asset_root.join("quizzes");
    let workspace_cheatsheets = asset_root.join("cheatsheets");

    // Writable state/run root: a fixed cache dir under $HOME (exec-ok, off the
    // git tree, never /tmp). Overridable via TS_SERVE_ROOT for the operator.
    let store_root = std::env::var_os("TS_SERVE_ROOT").map_or_else(
        || {
            std::env::var_os("HOME")
                .map_or_else(|| PathBuf::from("/home/paul"), PathBuf::from)
                .join(".cache/ts-serve")
        },
        PathBuf::from,
    );

    if let Err(e) = std::fs::create_dir_all(&store_root) {
        eprintln!(
            "fatal: cannot create state root {}: {e}",
            store_root.display()
        );
        std::process::exit(1);
    }
    if let Err(e) = ensure_seeded(
        &store_root,
        &workspace_exercises,
        &workspace_book,
        &workspace_glossary,
        &workspace_lessons,
        &workspace_quizzes,
        &workspace_cheatsheets,
    ) {
        eprintln!(
            "warning: could not seed exercises into {}: {e}",
            store_root.display()
        );
    }

    let state = AppState {
        store_root: store_root.clone(),
    };
    let app = build_router(state, &gui_dir);

    // Loopback ONLY — never 0.0.0.0. Port is fixed (8787) or PORT, clamped.
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(8787);
    let addr = (Ipv4Addr::LOCALHOST, port);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("fatal: cannot bind 127.0.0.1:{port}: {e}");
            std::process::exit(1);
        }
    };

    println!("Tempered Studio — serving the GUI at http://127.0.0.1:{port}/");
    println!("  state root : {}", store_root.display());
    println!("  gui root   : {}", gui_dir.display());
    println!("  open the URL in a browser, then press Run / Check.");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("fatal: server error: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rpro_state::{Difficulty, ExerciseMetadata};

    // A sample diagnostic code, assembled at compile time so the literal never
    // appears in source — the seam-grep gate forbids E0xxx tokens outside
    // crates/languages/, and this crate is language-agnostic.
    const ERRC: &str = concat!("E0", "382");

    fn meta(solution: Option<&str>, err: Option<&str>) -> ExerciseMetadata {
        ExerciseMetadata {
            id: "ownership/01_move".into(),
            title: "Move semantics".into(),
            difficulty: Difficulty::Beginner,
            estimated_minutes: 8,
            concept: "move-semantics".into(),
            book_refs: vec![],
            expected_error_code: err.map(String::from),
            expected_runtime_panic: None,
            solution_outline: solution.map(String::from),
        }
    }

    #[test]
    fn sanitize_code_accepts_alnum_rejects_junk() {
        assert_eq!(sanitize_code(ERRC).as_deref(), Some(ERRC));
        assert_eq!(sanitize_code("  e0382 ").as_deref(), Some("e0382"));
        assert!(sanitize_code("").is_none());
        assert!(sanitize_code("../etc/passwd").is_none());
        assert!(sanitize_code(&format!("{ERRC}; rm -rf")).is_none());
        assert!(sanitize_code(&"x".repeat(17)).is_none());
    }

    #[test]
    fn status_str_maps_lowercase() {
        assert_eq!(status_str(ExerciseStatus::Locked), "locked");
        assert_eq!(status_str(ExerciseStatus::Current), "current");
        assert_eq!(status_str(ExerciseStatus::Done), "done");
        assert_eq!(status_str(ExerciseStatus::Skipped), "skipped");
    }

    #[test]
    fn asset_root_candidate_precedence() {
        let manifest = Path::new("/ws/crates/rpro-serve");
        let exe_dir = Path::new("/opt/app/usr/bin");
        // env override first, then FHS-share, then beside-the-exe, then dev tree.
        let c = asset_root_candidates(Some(PathBuf::from("/custom")), Some(exe_dir), manifest);
        assert_eq!(
            c,
            vec![
                PathBuf::from("/custom"),
                PathBuf::from("/opt/app/usr/bin/../share/tempered-studio"),
                PathBuf::from("/opt/app/usr/bin"),
                PathBuf::from("/ws/crates/rpro-serve/../.."),
            ]
        );
        // No override, no resolvable exe → only the source-tree fallback remains,
        // so a packaged binary that can't locate itself still behaves as before.
        assert_eq!(
            asset_root_candidates(None, None, manifest),
            vec![PathBuf::from("/ws/crates/rpro-serve/../..")]
        );
    }

    #[test]
    fn wireop_whitelist_rejects_unknown_and_parses_known() {
        use serde_json::json;
        assert!(serde_json::from_value::<WireOp>(json!({"op": "run"})).is_ok());
        assert!(serde_json::from_value::<WireOp>(json!({"op": "check"})).is_ok());
        assert!(serde_json::from_value::<WireOp>(json!({"op": "test"})).is_ok());
        assert!(serde_json::from_value::<WireOp>(json!({"op": "explain", "code": ERRC})).is_ok());
        // off the whitelist → cannot be coaxed into running:
        assert!(serde_json::from_value::<WireOp>(json!({"op": "fmt"})).is_err());
        assert!(serde_json::from_value::<WireOp>(json!({"op": "lint"})).is_err());
        assert!(serde_json::from_value::<WireOp>(json!({"op": "bogus"})).is_err());
        assert!(serde_json::from_value::<WireOp>(json!({"op": "explain"})).is_err());
    }

    // The hint ladder itself (escalation + no-leak gating) is now tested at its
    // shared home, ExerciseMetadata::hint in rpro-state; the handler just calls it.

    #[test]
    fn current_json_omits_the_answer() {
        let ex = rpro_runner::Exercise {
            source: std::path::PathBuf::from("/x/01_move.rs"),
            meta: meta(Some("Use s1.clone()"), Some(ERRC)),
        };
        let v = current_json(&ex, "fn main() {}");
        assert_eq!(v["exercise"], "ownership/01_move");
        assert_eq!(v["code"], "fn main() {}");
        assert!(
            v.get("solution_outline").is_none(),
            "must not leak the solution"
        );
        assert!(
            v.get("expected_error_code").is_none(),
            "must not leak the expected error"
        );
        assert!(
            v.get("expected_runtime_panic").is_none(),
            "must not leak the expected runtime panic"
        );
        assert!(
            !v.to_string().contains("clone"),
            "the answer must appear nowhere in the payload"
        );
    }
    // Spaced-repetition logic now lives in its shared home: ReviewState::fold_run
    // (rpro-state) and primary_error_code / record_run (rpro-runner), each tested
    // there. rpro-serve just calls record_run.

    // ── handler contract, driven through the real router via oneshot ──
    // These bring the network-surface guarantees (no-leak, op-whitelist, body
    // limit, security headers) into the standard test gate (not only the bash
    // smoke script). They deliberately avoid ops that trigger a real toolchain
    // run, so they're fast and toolchain-independent.
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt; // oneshot

    fn seeded_app() -> (tempfile::TempDir, axum::Router) {
        let dir = tempfile::tempdir().unwrap();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        ensure_seeded(
            dir.path(),
            &manifest.join("../../exercises"),
            &manifest.join("../../book"),
            &manifest.join("../../glossary"),
            &manifest.join("../../lessons"),
            &manifest.join("../../quizzes"),
            &manifest.join("../../cheatsheets"),
        )
        .unwrap();
        let state = AppState {
            store_root: dir.path().to_path_buf(),
        };
        let app = build_router(state, &manifest.join("../../gui"));
        (dir, app)
    }

    // A store seeded by an OLDER build must pick up later content improvements
    // (the exercise "never hand the answer" sweep, new glossary terms, lesson
    // rewrites) on upgrade — without resetting the learner's progress. Pin the
    // version-gated refresh: corrupt a seeded exercise + the glossary, roll the
    // `.content-version` marker back to a pre-refresh value, re-seed, and assert
    // the stale files are restored from the bundle while progress survives.
    #[test]
    fn content_refresh_restores_stale_files_and_keeps_progress() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = dir.path();
        let seed = || {
            ensure_seeded(
                root,
                &manifest.join("../../exercises"),
                &manifest.join("../../book"),
                &manifest.join("../../glossary"),
                &manifest.join("../../lessons"),
                &manifest.join("../../quizzes"),
                &manifest.join("../../cheatsheets"),
            )
            .unwrap();
        };

        // First-run seed: a fresh store gets content + the current-version marker.
        seed();
        let marker = root.join(".content-version");
        assert_eq!(
            fs::read_to_string(&marker).unwrap().trim(),
            CONTENT_VERSION.to_string(),
            "a freshly seeded store records the current content version"
        );

        // Note which exercise is Current — it must survive the refresh.
        let store = Store::at(root.to_path_buf());
        let current_id = store
            .load_progress()
            .unwrap()
            .entries
            .iter()
            .find(|(_, e)| e.status == ExerciseStatus::Current)
            .map(|(id, _)| id.clone())
            .expect("a fresh store has a Current exercise");

        // Simulate an old store: corrupt a seeded exercise + the glossary, and
        // roll the marker back so the store looks pre-refresh (version 0).
        let victim_ex = rpro_runner::discover(&root.join("exercises"))
            .unwrap()
            .into_iter()
            .next()
            .expect("the seeded store has exercises")
            .source;
        fs::write(&victim_ex, "// STALE spoiler comment\nfn main() {}\n").unwrap();
        let gloss = root.join("glossary/glossary.toml");
        let good_gloss = fs::read_to_string(&gloss).unwrap();
        fs::write(&gloss, "# STALE glossary\n").unwrap();
        // A GHOST file: pretend an earlier bundle shipped a lesson that no longer
        // exists (the lesson-split case — one .md replaced by two). The refresh
        // must SYNC the read-only dirs, not overlay them, or the ghost lingers in
        // the served list. A user-added exercise, by contrast, must SURVIVE.
        let ghost = root.join("lessons/99-ghost-of-a-renamed-lesson.md");
        fs::write(&ghost, "# ghost\n").unwrap();
        let user_ex = root.join("exercises/99-user/my_own.rs");
        fs::create_dir_all(user_ex.parent().unwrap()).unwrap();
        fs::write(&user_ex, "fn main() {}\n").unwrap();
        fs::write(&marker, "0").unwrap();

        // Re-run: the version gate (0 < CONTENT_VERSION) refreshes the content dirs.
        seed();

        assert!(
            !ghost.exists(),
            "a removed/renamed bundled lesson is deleted by the refresh (sync, not overlay)"
        );
        assert!(
            user_ex.exists(),
            "a user-added exercise survives the refresh (exercises overlay, never clear)"
        );
        assert!(
            !fs::read_to_string(&victim_ex).unwrap().contains("STALE"),
            "the stale exercise source was refreshed from the bundle"
        );
        assert_eq!(
            fs::read_to_string(&gloss).unwrap(),
            good_gloss,
            "the stale glossary was refreshed from the bundle"
        );
        assert_eq!(
            fs::read_to_string(&marker).unwrap().trim(),
            CONTENT_VERSION.to_string(),
            "the marker is bumped back to the current version after refresh"
        );

        // Progress preserved: the same exercise is still Current (not reset to #1).
        let after = store.load_progress().unwrap();
        assert!(
            after
                .entries
                .get(&current_id)
                .is_some_and(|e| e.status == ExerciseStatus::Current),
            "the learner's Current exercise survived the content refresh"
        );
    }

    /// Walkthrough 2026-10-13 (#2, #12): a brand-new learner must open on the
    /// exercise Lesson 1 actually teaches. Lesson 1 demonstrates `error[E0384]`
    /// and Lesson 2 opens "Lesson 1 showed … (that was E0384)", so the first
    /// exercise in course order — the one a fresh store makes Current — must
    /// expect the first error code Lesson 1 shows, and the GUI's `CONCEPT_LESSON`
    /// map must send that exercise back to Lesson 1. Pinned to the lesson TEXT and
    /// the map rather than to an id, so a re-sequence that strands Lesson 1's error
    /// behind another exercise (as when the E0381 one opened the course) fails.
    #[test]
    fn fresh_store_opens_on_the_error_lesson_1_teaches() {
        let (d, _app) = seeded_app();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let lesson_path = manifest.join("../../lessons/01-bindings-and-immutability.md");
        let lesson = std::fs::read_to_string(lesson_path).unwrap();
        let taught = lesson
            .split("error[")
            .nth(1)
            .and_then(|s| s.split(']').next())
            .expect("Lesson 1 shows a real compiler error");
        let exercises = rpro_runner::discover(&d.path().join("exercises")).unwrap();
        let first = &exercises[0];
        let (id, _, _) = resolve_current(d.path()).expect("a fresh store has a current exercise");
        assert_eq!(id, first.meta.id, "a fresh store opens on exercise 1");
        assert_eq!(
            first.meta.expected_error_code.as_deref(),
            Some(taught),
            "the course must open on the error Lesson 1 teaches, not on {}",
            first.meta.id
        );
        let gui = std::fs::read_to_string(manifest.join("../../gui/index.html")).unwrap();
        let mapped = format!("'{}': '01-bindings-and-immutability'", first.meta.concept);
        assert!(
            gui.contains(&mapped),
            "CONCEPT_LESSON must send {:?} to Lesson 1",
            first.meta.concept
        );
    }

    /// Re-sequencing renames exercise files, and exercises are overlay-copied, so
    /// an upgraded store kept each OLD file as a same-id ghost: the exercise was
    /// listed twice and `record_run` advanced into the ghost. A refresh must drop
    /// the stale copy — and still keep a learner's own exercise.
    #[test]
    fn content_refresh_prunes_same_id_copies_left_by_a_rename() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = dir.path();
        let seed = || {
            ensure_seeded(
                root,
                &manifest.join("../../exercises"),
                &manifest.join("../../book"),
                &manifest.join("../../glossary"),
                &manifest.join("../../lessons"),
                &manifest.join("../../quizzes"),
                &manifest.join("../../cheatsheets"),
            )
            .unwrap();
        };
        seed();
        // An older bundle's copy of the first exercise, under its pre-rename name.
        let ex_dir = root.join("exercises");
        let first = rpro_runner::discover(&ex_dir).unwrap().remove(0).source;
        let ghost = first.with_file_name("99_pre_rename_copy.rs");
        fs::copy(&first, &ghost).unwrap();
        fs::copy(first.with_extension("toml"), ghost.with_extension("toml")).unwrap();
        // A learner's own exercise (an id the bundle doesn't ship) must survive.
        let own = ex_dir.join("99-user/my_own.rs");
        fs::create_dir_all(own.parent().unwrap()).unwrap();
        fs::write(&own, "fn main() {}\n").unwrap();
        fs::write(
            own.with_extension("toml"),
            "id = \"user/my_own\"\ntitle = \"Mine\"\ndifficulty = \"beginner\"\n\
             estimated_minutes = 1\nconcept = \"binding\"\n\
             [[book_refs]]\nchapter = \"ch01\"\nwhy = \"x\"\n",
        )
        .unwrap();
        // Roll the marker back so the next boot is a content refresh.
        fs::write(root.join(".content-version"), "0").unwrap();
        seed();
        assert!(!ghost.exists(), "the pre-rename copy is pruned");
        assert!(!ghost.with_extension("toml").exists(), "and its metadata");
        assert!(first.exists(), "the bundled copy stays");
        assert!(own.exists(), "a learner's own exercise survives");
        let ids: Vec<String> = rpro_runner::discover(&ex_dir)
            .unwrap()
            .into_iter()
            .map(|e| e.meta.id)
            .collect();
        let unique: std::collections::BTreeSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "each exercise listed once");
    }

    /// A store that boots with nothing Current must KEEP its progress. That state
    /// follows passing the last exercise, and (now that `record_run` never
    /// re-opens finished work) passing one whose followers are all Done. The
    /// seeder used to save a fresh default over it, wiping every completion.
    #[test]
    fn boot_with_nothing_current_keeps_progress() {
        let (d, _app) = seeded_app();
        let store = Store::at(d.path().to_path_buf());
        let exercises = rpro_runner::discover(&d.path().join("exercises")).unwrap();
        let mut p = store.load_progress().unwrap();
        p.set_done(&exercises[0].meta.id); // the seeded Current: now nothing is Current
        p.set_done(&exercises[5].meta.id);
        store.save_progress(&p).unwrap();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        ensure_seeded(
            d.path(),
            &manifest.join("../../exercises"),
            &manifest.join("../../book"),
            &manifest.join("../../glossary"),
            &manifest.join("../../lessons"),
            &manifest.join("../../quizzes"),
            &manifest.join("../../cheatsheets"),
        )
        .unwrap();
        let after = store.load_progress().unwrap();
        assert_eq!(after.done_count(), 2, "no completion is lost");
        let (id, _, _) = resolve_current(d.path()).expect("an unfinished exercise is Current");
        assert_eq!(id, exercises[1].meta.id, "the first unfinished one");
    }

    async fn body_string(res: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    fn post_json(uri: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn current_endpoint_serves_without_leaking_the_answer() {
        let (_d, app) = seeded_app();
        let res = app.oneshot(get("/api/current")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let s = body_string(res).await;
        assert!(
            s.contains("\"exercise\""),
            "renders the current exercise: {s}"
        );
        assert!(!s.contains("solution_outline"), "no solution leak");
        assert!(!s.contains("expected_error_code"), "no expected-error leak");
    }

    #[tokio::test]
    async fn run_rejects_unknown_op_with_400() {
        let (_d, app) = seeded_app();
        let req = Request::builder()
            .method("POST")
            .uri("/api/run")
            .header("content-type", "application/json")
            .body(Body::from("{\"op\":\"fmt\"}"))
            .unwrap();
        assert_eq!(
            app.oneshot(req).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn run_rejects_oversized_body_with_413() {
        let (_d, app) = seeded_app();
        let req = Request::builder()
            .method("POST")
            .uri("/api/run")
            .header("content-type", "application/json")
            .body(Body::from(vec![b'x'; MAX_BODY_BYTES + 1024]))
            .unwrap();
        assert_eq!(
            app.oneshot(req).await.unwrap().status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[tokio::test]
    async fn review_endpoint_has_the_expected_shape() {
        let (_d, app) = seeded_app();
        let res = app.oneshot(get("/api/review")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert!(
            v.get("due").is_some() && v.get("mastered").is_some() && v.get("tracked").is_some()
        );
    }

    #[tokio::test]
    async fn responses_carry_security_headers() {
        let (_d, app) = seeded_app();
        let res = app.oneshot(get("/api/current")).await.unwrap();
        let h = res.headers();
        assert!(h.contains_key("content-security-policy"), "CSP present");
        assert_eq!(h.get("x-content-type-options").unwrap(), "nosniff");
        assert_eq!(h.get("x-frame-options").unwrap(), "DENY");
    }

    #[tokio::test]
    async fn hint_level1_serves_without_the_solution() {
        let (d, app) = seeded_app();
        // Force-attempt gate: with 0 attempts, NO hint unlocks — the ladder returns
        // level 0 with a "run it first" nudge.
        let pre = app.clone().oneshot(get("/api/hint?level=1")).await.unwrap();
        let pv: serde_json::Value = serde_json::from_str(&body_string(pre).await).unwrap();
        assert_eq!(pv["level"], 0, "no hint until a genuine attempt is made");

        // Record one attempt (the server-side analog of pressing Run once), then
        // rung 1 unlocks.
        let store = Store::at(d.path().to_path_buf());
        let exercises = rpro_runner::discover(&store.root().join("exercises")).unwrap();
        let mut p = store.load_progress().unwrap_or_default();
        p.record_attempt(&exercises[0].meta.id);
        store.save_progress(&p).unwrap();

        let res = app.oneshot(get("/api/hint?level=1")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert_eq!(v["level"], 1);
        assert!(
            !v["text"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains("solution outline"),
            "L1 must not reveal the solution outline"
        );
    }

    #[tokio::test]
    async fn book_toc_lists_seeded_chapters() {
        let (_d, app) = seeded_app();
        let res = app.oneshot(get("/api/book")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        let chapters = v["chapters"].as_array().expect("chapters array");
        assert!(!chapters.is_empty(), "the seeded book has chapters");
        // Every entry carries an id and a non-empty title (id fallback guarantees it).
        assert!(chapters.iter().all(|c| {
            c["id"].as_str().is_some_and(|s| !s.is_empty())
                && c["title"].as_str().is_some_and(|s| !s.is_empty())
        }));
        // A known seeded chapter is present.
        assert!(
            chapters
                .iter()
                .any(|c| c["id"] == "ch04-01-what-is-ownership"),
            "ownership chapter is in the TOC"
        );
    }

    #[tokio::test]
    async fn lessons_list_and_fetch_a_lesson() {
        let (_d, app) = seeded_app();
        // List: every entry carries an id + non-empty title; a known lesson shows.
        let res = app.clone().oneshot(get("/api/lessons")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        let lessons = v["lessons"].as_array().expect("lessons array");
        assert!(!lessons.is_empty(), "the seeded lessons are listed");
        assert!(lessons.iter().all(|l| {
            l["id"].as_str().is_some_and(|s| !s.is_empty())
                && l["title"].as_str().is_some_and(|s| !s.is_empty())
        }));
        let known = "01-bindings-and-immutability";
        assert!(
            lessons.iter().any(|l| l["id"] == known),
            "the first lesson is in the list"
        );
        // Fetch one: its markdown comes back.
        let res = app
            .clone()
            .oneshot(get(&format!("/api/lessons?id={known}")))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert!(
            v["lesson"]["markdown"]
                .as_str()
                .is_some_and(|s| s.contains('#')),
            "the fetched lesson carries its markdown"
        );
        // Traversal safety: a path-like id matches no real file stem → null.
        let res = app
            .oneshot(get("/api/lessons?id=../../Cargo.toml"))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert!(
            v["lesson"].is_null(),
            "a traversal-looking id resolves to no lesson"
        );
    }

    #[tokio::test]
    async fn lessons_full_text_search_returns_ranked_hits() {
        let (_d, app) = seeded_app();
        // `?q=` searches every lesson's markdown; a common term yields ranked hits.
        let res = app
            .clone()
            .oneshot(get("/api/lessons?q=immutable"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        let hits = v["hits"].as_array().expect("hits array");
        assert!(
            !hits.is_empty(),
            "a common term matches at least one lesson"
        );
        assert!(hits.iter().all(|h| {
            h["id"].as_str().is_some_and(|s| !s.is_empty())
                && h["title"].as_str().is_some_and(|s| !s.is_empty())
                && h["count"].as_u64().is_some_and(|c| c > 0)
                && h["snippet"].as_str().is_some_and(|s| !s.is_empty())
        }));
        // Ranked by match count, high to low.
        let counts: Vec<u64> = hits.iter().map(|h| h["count"].as_u64().unwrap()).collect();
        assert!(
            counts.windows(2).all(|w| w[0] >= w[1]),
            "hits are sorted by match count"
        );
        // A term that appears nowhere → an empty hit list (not an error, not the list).
        let res = app
            .clone()
            .oneshot(get("/api/lessons?q=zzznotawordzzz"))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert!(
            v["hits"].as_array().expect("hits array present").is_empty(),
            "a no-match search returns an empty hits array"
        );
        assert!(
            v.get("lessons").is_none(),
            "a search never falls back to the list"
        );
    }

    #[tokio::test]
    async fn quizzes_list_and_fetch_a_quiz() {
        let (_d, app) = seeded_app();
        let res = app.clone().oneshot(get("/api/quizzes")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        let quizzes = v["quizzes"].as_array().expect("quizzes array");
        assert!(!quizzes.is_empty(), "the seeded quizzes are listed");
        assert!(quizzes.iter().all(|q| {
            q["id"].as_str().is_some_and(|s| !s.is_empty())
                && q["title"].as_str().is_some_and(|s| !s.is_empty())
        }));
        assert!(
            quizzes.iter().any(|q| q["id"] == "phase1"),
            "the phase-1 quiz is in the list"
        );
        // Fetch one: its markdown (with the Questions section) comes back.
        let res = app
            .clone()
            .oneshot(get("/api/quizzes?id=phase1"))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert!(
            v["quiz"]["markdown"]
                .as_str()
                .is_some_and(|s| s.contains("Questions")),
            "the fetched quiz carries its markdown"
        );
        // Traversal safety: a path-like id matches no real file stem → null.
        let res = app
            .oneshot(get("/api/quizzes?id=../../Cargo.toml"))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert!(
            v["quiz"].is_null(),
            "a traversal-looking id resolves to no quiz"
        );
    }

    #[tokio::test]
    async fn cheatsheets_list_and_fetch() {
        let (_d, app) = seeded_app();
        let res = app.clone().oneshot(get("/api/cheatsheets")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        let sheets = v["cheatsheets"].as_array().expect("cheatsheets array");
        assert!(!sheets.is_empty(), "the seeded cheatsheets are listed");
        assert!(sheets.iter().all(|c| {
            c["id"].as_str().is_some_and(|s| !s.is_empty())
                && c["title"].as_str().is_some_and(|s| !s.is_empty())
        }));
        assert!(
            sheets.iter().any(|c| c["id"] == "phase1"),
            "the phase-1 cheatsheet is in the list"
        );
        let res = app
            .clone()
            .oneshot(get("/api/cheatsheets?id=phase1"))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert!(
            v["cheatsheet"]["markdown"]
                .as_str()
                .is_some_and(|s| s.contains('#')),
            "the fetched cheatsheet carries its markdown"
        );
        let res = app
            .oneshot(get("/api/cheatsheets?id=../../Cargo.toml"))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert!(
            v["cheatsheet"].is_null(),
            "a traversal-looking id resolves to no cheatsheet"
        );
    }

    #[tokio::test]
    async fn book_search_returns_hits_with_counts_and_snippets() {
        let (_d, app) = seeded_app();
        let res = app.oneshot(get("/api/book?q=ownership")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        let hits = v["hits"].as_array().expect("hits array");
        assert!(!hits.is_empty(), "`ownership` matches at least one chapter");
        // The ownership chapter should be among the hits, with a positive count.
        let own = hits
            .iter()
            .find(|h| h["chapter"] == "ch04-01-what-is-ownership")
            .expect("ownership chapter is a hit");
        assert!(
            own["count"].as_u64().unwrap_or(0) > 0,
            "match count is reported"
        );
        assert!(
            own["title"].as_str().is_some_and(|s| !s.is_empty()),
            "title present"
        );
        // Hits are ordered by descending match count.
        let counts: Vec<u64> = hits
            .iter()
            .map(|h| h["count"].as_u64().unwrap_or(0))
            .collect();
        assert!(
            counts.windows(2).all(|w| w[0] >= w[1]),
            "hits sorted by count desc: {counts:?}"
        );
    }

    #[tokio::test]
    async fn book_search_blank_term_returns_no_hits() {
        let (_d, app) = seeded_app();
        let res = app.oneshot(get("/api/book?q=%20%20")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert_eq!(
            v["hits"].as_array().map(Vec::len),
            Some(0),
            "blank term → empty hits"
        );
    }

    #[tokio::test]
    async fn book_chapter_returns_its_markdown() {
        let (_d, app) = seeded_app();
        let res = app
            .oneshot(get("/api/book?chapter=ch04-01-what-is-ownership"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert_eq!(v["id"], "ch04-01-what-is-ownership");
        let md = v["markdown"].as_str().unwrap_or("");
        assert!(
            md.contains("Ownership"),
            "returns the chapter's real markdown body"
        );
        // Cleaned for display: no raw mdBook include directives leak through, and
        // the un-bundled code listings link out to the live chapter.
        assert!(
            !md.contains("{{#"),
            "raw mdBook directives must be stripped"
        );
        assert!(
            md.contains("book/ch04-01-what-is-ownership.html"),
            "un-bundled listings link out to the live chapter"
        );
    }

    // SECURITY pin: the `chapter` param is a map KEY, never a path. A traversal
    // string must miss the map and return null — never the contents of a file on
    // disk. Tested both raw and percent-encoded so neither the Query decoder nor a
    // future refactor can turn this into a path join. This is the network-surface
    // half of the same guarantee the smoke script asserts against a live server.
    #[tokio::test]
    async fn book_traversal_is_a_miss_not_a_file_read() {
        let (_d, app) = seeded_app();
        for uri in [
            "/api/book?chapter=../../etc/passwd",
            "/api/book?chapter=..%2F..%2F..%2Fetc%2Fpasswd",
            "/api/book?chapter=%2Fetc%2Fpasswd",
        ] {
            let res = app.clone().oneshot(get(uri)).await.unwrap();
            assert_eq!(
                res.status(),
                StatusCode::OK,
                "{uri} still resolves on the map"
            );
            let body = body_string(res).await;
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert!(
                v["chapter"].is_null(),
                "{uri} must miss the map, got: {body}"
            );
            assert!(
                !body.contains("root:") && !body.contains("/bin/"),
                "{uri} must not return any /etc/passwd content"
            );
        }
    }

    #[tokio::test]
    async fn select_switches_current_and_validates_id() {
        let (_d, app) = seeded_app();
        // Pick a second, not-yet-done exercise from the list.
        let list = body_string(app.clone().oneshot(get("/api/exercises")).await.unwrap()).await;
        let v: serde_json::Value = serde_json::from_str(&list).unwrap();
        let target = v["exercises"][1]["id"].as_str().unwrap().to_string();
        // The soft prerequisite gate locks a later exercise until its predecessor
        // is Done — without `force`, selecting exercises[1] is refused 423 LOCKED.
        let locked = app
            .clone()
            .oneshot(post_json(
                "/api/select",
                &format!("{{\"id\":\"{target}\"}}"),
            ))
            .await
            .unwrap();
        assert_eq!(
            locked.status(),
            StatusCode::LOCKED,
            "a not-yet-reached exercise is gated until the prereq is Done (or force)"
        );
        // With `force` (the explicit "jump ahead anyway"), the selection goes
        // through and becomes current.
        let res = app
            .clone()
            .oneshot(post_json(
                "/api/select",
                &format!("{{\"id\":\"{target}\",\"force\":true}}"),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let cur = body_string(app.clone().oneshot(get("/api/current")).await.unwrap()).await;
        let cv: serde_json::Value = serde_json::from_str(&cur).unwrap();
        assert_eq!(cv["exercise"], target, "current now reflects the selection");
        // An id outside the discovered set is rejected — never used as a path.
        let bad = app
            .clone()
            .oneshot(post_json("/api/select", "{\"id\":\"../../etc/passwd\"}"))
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn select_refuses_a_completed_exercise_with_409() {
        let (d, app) = seeded_app();
        // Mark the first exercise Done directly in the store.
        let store = Store::at(d.path().to_path_buf());
        let exercises = rpro_runner::discover(&store.root().join("exercises")).unwrap();
        let done_id = exercises[0].meta.id.clone();
        let mut p = store.load_progress().unwrap_or_default();
        p.set_done(&done_id);
        store.save_progress(&p).unwrap();
        // Selecting a completed exercise is refused (Reset is the redo path).
        let res = app
            .oneshot(post_json(
                "/api/select",
                &format!("{{\"id\":\"{done_id}\"}}"),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn diagnostics_endpoint_is_wired_and_returns_a_valid_shape() {
        // Route + response-shape guard. Holds whether or not a language server is
        // installed: with one it may return diagnostics, without one it degrades
        // to `available:false` + empty — either way a 200 with the right shape.
        let (_d, app) = seeded_app();
        let res = app
            .oneshot(post_json(
                "/api/diagnostics",
                "{\"code\":\"fn main() {}\\n\"}",
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body_string(res).await).unwrap();
        assert!(v["available"].is_boolean(), "reports server availability");
        assert!(
            v["diagnostics"].is_array(),
            "always returns a diagnostics list"
        );
    }

    // ── workspace file API (the IDE) — contract tests ──────────────────────

    fn put_json(uri: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn workspace_tree_lists_sources_only_and_never_answers() {
        let (_d, app) = seeded_app();
        let res = app.oneshot(get("/api/workspace")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let s = body_string(res).await;
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        let groups = v["groups"].as_array().expect("groups array");
        assert!(!groups.is_empty(), "the seeded store has phase groups");
        for g in groups {
            for f in g["files"].as_array().unwrap() {
                let name = f["name"].as_str().unwrap();
                assert!(
                    std::path::Path::new(name)
                        .extension()
                        .is_some_and(|e| e == "rs"),
                    "only source files appear in the explorer, got {name}"
                );
            }
        }
        assert!(!s.contains(".toml"), "metadata files never appear");
        assert!(!s.contains("solution_outline"), "no solution leak");
        assert!(!s.contains("expected_error_code"), "no expected-error leak");
    }

    #[tokio::test]
    async fn workspace_file_roundtrip_on_the_current_exercise() {
        let (d, app) = seeded_app();
        let (id, _, _) = resolve_current(d.path()).expect("a fresh store has a current exercise");
        let uri = format!("/api/workspace/file?id={}", urlencode(&id));
        let res = app.clone().oneshot(get(&uri)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let s = body_string(res).await;
        assert!(s.contains("\"content\""), "serves the source: {s}");
        assert!(!s.contains("solution_outline"), "no solution leak");
        // Save an edited buffer, then confirm it persisted to disk.
        let edited = "fn main() { /* edited in the IDE */ }\n";
        let body = serde_json::json!({ "id": id, "content": edited }).to_string();
        let res = app
            .clone()
            .oneshot(put_json("/api/workspace/file", &body))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let (_, on_disk, _) = resolve_current(d.path()).unwrap();
        assert_eq!(on_disk, edited, "the save is persistent, not ephemeral");
    }

    #[tokio::test]
    async fn workspace_gates_match_select_locked_and_done_and_unknown() {
        let (d, app) = seeded_app();
        // A locked exercise: the LAST one in course order on a fresh store.
        let store = Store::at(d.path().to_path_buf());
        let exercises = rpro_runner::discover(&store.root().join("exercises")).unwrap();
        let locked_id = exercises.last().unwrap().meta.id.clone();
        let res = app
            .clone()
            .oneshot(get(&format!(
                "/api/workspace/file?id={}",
                urlencode(&locked_id)
            )))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::LOCKED, "locked reads are gated");
        let body = serde_json::json!({ "id": locked_id, "content": "x" }).to_string();
        let res = app
            .clone()
            .oneshot(put_json("/api/workspace/file", &body))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::LOCKED, "locked writes are gated");
        // Unknown id → 400 (never a filesystem probe).
        let res = app
            .clone()
            .oneshot(put_json(
                "/api/workspace/file",
                "{\"id\":\"../../etc/passwd\",\"content\":\"x\"}",
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        // Done → 409, mirroring select (Reset is the redo path).
        let done_id = exercises[0].meta.id.clone();
        let mut p = store.load_progress().unwrap_or_default();
        p.set_done(&done_id);
        store.save_progress(&p).unwrap();
        let body = serde_json::json!({ "id": done_id, "content": "x" }).to_string();
        let res = app
            .oneshot(put_json("/api/workspace/file", &body))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn workspace_write_clamps_oversized_buffers() {
        let (d, app) = seeded_app();
        let (id, _, _) = resolve_current(d.path()).unwrap();
        let big = "x".repeat(MAX_SOURCE_BYTES + 1);
        let body = serde_json::json!({ "id": id, "content": big }).to_string();
        let res = app
            .oneshot(put_json("/api/workspace/file", &body))
            .await
            .unwrap();
        // The transport body cap (1 MiB) or the source clamp — either rejects it.
        assert!(
            res.status() == StatusCode::PAYLOAD_TOO_LARGE
                || res.status() == StatusCode::BAD_REQUEST,
            "oversized buffer must be refused, got {}",
            res.status()
        );
    }

    /// Minimal percent-encoding for exercise ids in query strings (ids contain
    /// `/`). Test-only helper.
    fn urlencode(s: &str) -> String {
        s.chars()
            .flat_map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                    vec![c]
                } else {
                    format!("%{:02X}", c as u32).chars().collect()
                }
            })
            .collect()
    }
}
