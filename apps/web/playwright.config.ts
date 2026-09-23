import { defineConfig, devices } from '@playwright/test';

const API_PORT = 4210;
const WEB_PORT = 5273;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  // Bots now think for a random 1-6s before acting (see DECISIONS.md), so
  // a hand with several bot seats and several streets can legitimately
  // take a while — 30s was fine when bots acted in well under 1.5s.
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${String(WEB_PORT)}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Fake camera/mic (a synthetic test pattern + tone) so getUserMedia
        // works headlessly with no real hardware and no permission prompt —
        // this is what lets voice.spec.ts exercise the real WebRTC path.
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
        permissions: ['camera', 'microphone'],
      },
    },
  ],
  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: '../server',
      env: {
        JWT_SECRET: 'e2e-test-secret',
        PORT: String(API_PORT),
        CORS_ORIGIN: `http://localhost:${String(WEB_PORT)}`,
        SEED_DEFAULT_TABLES: 'false',
        // The whole suite's tests share ONE server process for the
        // entire run — production's per-minute HTTP rate limit (100)
        // becomes test flakiness, not a real signal, once the suite has
        // enough tests to add up to that many requests. See DECISIONS.md.
        RATE_LIMIT_MAX: '100000',
        // Production's real post-hand shuffle break is 5s — several tests
        // start more than one hand, and genuinely waiting 5s per hand
        // would meaningfully slow the suite for no real signal. Short but
        // non-zero so the gate itself (button hidden, then reappearing)
        // is still genuinely exercised, not bypassed.
        HAND_BREAK_MS: '1200',
      },
      url: `http://localhost:${String(API_PORT)}/health`,
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: `npx vite --port ${String(WEB_PORT)} --strictPort`,
      cwd: '.',
      env: {
        VITE_API_URL: `http://localhost:${String(API_PORT)}`,
      },
      url: `http://localhost:${String(WEB_PORT)}`,
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
