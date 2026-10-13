// Playwright E2E config for the Tempered Studio web surface (rpro-serve).
// Browser: Playwright's bundled Chromium headless shell (no system Chrome needed).
// Assumes rpro-serve is already running at RPRO_BASE (default 127.0.0.1:8787).
const { defineConfig } = require('@playwright/test');

// The specs that press Run and wait on a REAL server-side rustc round-trip.
// Under parallel load these queue behind each other (and the UI specs' browser
// launches) — the repeat offenders behind the recall-chip / dev-diag-jump
// flakes. They get their own project with a generous ceiling; a timeout is a
// ceiling, not a wait, so green runs stay just as fast.
const COMPILE_SPECS = /(dev-diag-jump|tutor|recall-chip|web|explain-flow|predict)\.spec\.js/;

module.exports = defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Cap the worker pool: the default (half the cores) lets ~10 spec files
  // stampede a box that also runs rust-analyzer + other sessions; 4 keeps the
  // suite fast while ending the browser-launch + compile pile-ups.
  workers: 4,
  // One retry (warm browser) absorbs environmental blips; a genuine regression
  // still fails both attempts, so this hides flakes, not real breaks.
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.RPRO_BASE || 'http://127.0.0.1:8787',
    headless: true,
    browserName: 'chromium',
  },
  projects: [
    { name: 'ui', testIgnore: COMPILE_SPECS },
    // 90s ceiling: worst-case contention = a few queued compiles + a cold
    // browser launch; 30s trips on the queue, 90s never has (measured green
    // runs finish these specs in 2–8s each).
    { name: 'compile', testMatch: COMPILE_SPECS, timeout: 90_000 },
  ],
});
