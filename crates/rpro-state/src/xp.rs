//! XP and leveling — the gamification core (board #36–41).
//!
//! Pure, side-effect-free model: it turns *learning events* into XP and turns
//! total XP into a level + progress-to-next. It deliberately does NO I/O — award
//! points as the learner works, then persist the running total wherever the
//! progress store lives (that wiring is intentionally out of scope here).
//!
//! The design is adapted (not copied) from the `claude-buddy` companion's XP
//! system: an event→base-XP table plus a smoothly escalating level curve. The
//! events are re-tuned for Tempered's "predict the error, then fix it" pedagogy —
//! predicting the compiler error and passing an exercise are the core wins.

use serde::{Deserialize, Serialize};

/// A thing the learner did that is worth XP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum XpEvent {
    /// Correctly predicted the compiler error before running (Tempered's core
    /// "predict-then-run" skill — the whole point of the exercise format).
    ErrorPredicted,
    /// An exercise compiled/ran successfully (the fix landed).
    ExercisePassed,
    /// Solved on the first try, no hints, no failed attempts (mastery bonus,
    /// awarded *in addition to* `ExercisePassed`).
    FirstTrySolve,
    /// A compile attempt that didn't pass yet — effort still counts, gently.
    ExerciseAttempted,
    /// Finished every exercise/section of a lesson.
    LessonCompleted,
    /// A badge/achievement was unlocked.
    BadgeEarned,
    /// One more distinct day of practice (streak tick).
    DailyStreakDay,
    /// One minute of active study (award in whole minutes).
    MinuteStudied,
}

impl XpEvent {
    /// XP granted by one occurrence of this event.
    pub const fn base_xp(self) -> u64 {
        match self {
            XpEvent::ErrorPredicted => 15,
            XpEvent::ExercisePassed => 20,
            XpEvent::FirstTrySolve => 10,
            XpEvent::ExerciseAttempted => 5,
            XpEvent::LessonCompleted => 30,
            XpEvent::BadgeEarned => 50,
            XpEvent::DailyStreakDay => 8,
            XpEvent::MinuteStudied => 2,
        }
    }
}

/// Sum the XP for a batch of events.
pub fn award(events: &[XpEvent]) -> u64 {
    events.iter().map(|e| e.base_xp()).sum()
}

/// The top level a learner can reach.
pub const MAX_LEVEL: u32 = 20;

/// Total (cumulative) XP required to *reach* `level`.
///
/// Level 1 starts at 0. The curve is triangular — the gap to the next level
/// grows every time — so early levels feel quick and later ones feel earned.
/// `50·(L-1)·L` gives 0, 100, 300, 600, 1000, 1500, … (levels 2 and 6 line up
/// exactly with the reference curve we adapted from).
pub const fn xp_to_reach(level: u32) -> u64 {
    if level <= 1 {
        return 0;
    }
    let l = level as u64;
    50 * (l - 1) * l
}

/// The level a learner with `total_xp` has reached (clamped to `MAX_LEVEL`).
pub fn level_for_xp(total_xp: u64) -> u32 {
    let mut level = 1;
    while level < MAX_LEVEL && total_xp >= xp_to_reach(level + 1) {
        level += 1;
    }
    level
}

/// Where a learner sits within their current level — enough to render a
/// progress bar without the caller redoing the curve math.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelProgress {
    /// Current level (`1..=MAX_LEVEL`).
    pub level: u32,
    /// XP earned since entering this level.
    pub xp_into_level: u64,
    /// XP between this level and the next (0 once maxed).
    pub xp_span: u64,
    /// True once `level == MAX_LEVEL`.
    pub is_max: bool,
}

impl LevelProgress {
    /// Fraction (0.0..=1.0) filled toward the next level; 1.0 at max level.
    // XP totals stay far below 2^52, so the u64→f64 casts are exact in practice.
    #[allow(clippy::cast_precision_loss)]
    pub fn fraction(self) -> f64 {
        if self.is_max || self.xp_span == 0 {
            1.0
        } else {
            self.xp_into_level as f64 / self.xp_span as f64
        }
    }
}

/// Break `total_xp` down into level + progress-within-level.
pub fn progress_for_xp(total_xp: u64) -> LevelProgress {
    let level = level_for_xp(total_xp);
    let is_max = level >= MAX_LEVEL;
    let floor = xp_to_reach(level);
    let xp_span = if is_max {
        0
    } else {
        xp_to_reach(level + 1) - floor
    };
    LevelProgress {
        level,
        xp_into_level: total_xp.saturating_sub(floor),
        xp_span,
        is_max,
    }
}

/// A short, Rust-flavored title for a level — a bit of colour for the UI.
/// Titles repeat past the curated list; every level always gets a name.
pub fn level_title(level: u32) -> &'static str {
    const TITLES: [&str; 10] = [
        "Hello-World Hatchling",
        "Binding Beginner",
        "Control-Flow Cadet",
        "Ownership Apprentice",
        "Borrow-Checker Wrangler",
        "Lifetime Journeyer",
        "Trait Tactician",
        "Generics Adept",
        "Concurrency Captain",
        "Unsafe-Aware Sage",
    ];
    let idx = (level.saturating_sub(1) as usize).min(TITLES.len() - 1);
    TITLES[idx]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_xp_matches_the_pedagogy() {
        // Passing an exercise is worth more than merely attempting it, and a
        // badge is the biggest single hit.
        assert!(XpEvent::ExercisePassed.base_xp() > XpEvent::ExerciseAttempted.base_xp());
        assert!(XpEvent::BadgeEarned.base_xp() >= XpEvent::ExercisePassed.base_xp());
        assert_eq!(XpEvent::ErrorPredicted.base_xp(), 15);
        assert_eq!(XpEvent::MinuteStudied.base_xp(), 2);
    }

    #[test]
    fn award_sums_events() {
        let got = award(&[
            XpEvent::ErrorPredicted, // 15
            XpEvent::ExercisePassed, // 20
            XpEvent::FirstTrySolve,  // 10
        ]);
        assert_eq!(got, 45);
        assert_eq!(award(&[]), 0);
    }

    #[test]
    fn curve_thresholds() {
        assert_eq!(xp_to_reach(1), 0);
        assert_eq!(xp_to_reach(2), 100);
        assert_eq!(xp_to_reach(3), 300);
        assert_eq!(xp_to_reach(6), 1500);
        // Strictly increasing across the whole range.
        for l in 1..MAX_LEVEL {
            assert!(xp_to_reach(l + 1) > xp_to_reach(l), "not increasing at {l}");
        }
    }

    #[test]
    fn level_boundaries_are_exact() {
        assert_eq!(level_for_xp(0), 1);
        assert_eq!(level_for_xp(99), 1);
        assert_eq!(level_for_xp(100), 2);
        assert_eq!(level_for_xp(299), 2);
        assert_eq!(level_for_xp(300), 3);
        assert_eq!(level_for_xp(1499), 5);
        assert_eq!(level_for_xp(1500), 6);
    }

    #[test]
    fn level_caps_at_max() {
        assert_eq!(level_for_xp(u64::MAX), MAX_LEVEL);
        let p = progress_for_xp(u64::MAX);
        assert!(p.is_max);
        assert_eq!(p.level, MAX_LEVEL);
        assert_eq!(p.xp_span, 0);
        assert!((p.fraction() - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn progress_within_level_is_consistent() {
        // 150 XP: level 2 (>=100, <300), 50 into a 200-wide span.
        let p = progress_for_xp(150);
        assert_eq!(p.level, 2);
        assert_eq!(p.xp_into_level, 50);
        assert_eq!(p.xp_span, 200);
        assert!(!p.is_max);
        assert!((p.fraction() - 0.25).abs() < 1e-9);
    }

    #[test]
    fn every_level_has_a_title() {
        for l in 1..=MAX_LEVEL {
            assert!(!level_title(l).is_empty());
        }
        assert_eq!(level_title(1), "Hello-World Hatchling");
    }
}
