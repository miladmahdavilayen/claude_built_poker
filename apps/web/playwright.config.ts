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
