// A nine-player load check for a live server: the owner plus eight guests,
// each in their own browser sized like an iPhone, every camera and mic on,
// the 3D seated view. They play a few real hands and look around the
// table while they do. Every screen is recorded and a report is written.
// Nothing here is part of the e2e suite; run it by hand:
//
//   node scripts/liveTableSim.mjs --login            # once: sign the owner in, by hand, in a window
//   node scripts/liveTableSim.mjs --hands 4          # then the simulation itself
//
// Options: --web, --api (default the live site), --hands, --players (2-9),
// --out (default ~/Desktop/PokerClause 9-player sim <time>), --keep-table,
// --admin-user/--admin-password (instead of --login, e.g. admin/admin locally).
//
// All nine come from this one machine, so they share one IP address. The
// server limits each address to 100 requests a minute, so the guests arrive
// a few seconds apart, as they would from a group chat anyway.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const WEB = opt('web', 'https://www.pokerclause.com');
const API = opt('api', 'https://api.pokerclause.com');
const HANDS = Number(opt('hands', '4'));
const PLAYERS = Math.min(9, Math.max(2, Number(opt('players', '9'))));
const STATE_FILE = opt('admin-state', join(homedir(), '.pokerclause-sim', `owner-${new URL(WEB).hostname}.json`));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
const OUT = opt('out', join(homedir(), 'Desktop', `PokerClause ${String(PLAYERS)}-player sim ${stamp}`));
const PHONE = devices['iPhone 15 Pro'];
const NAMES = ['Owner', 'Ava', 'Ben', 'Cleo', 'Dev', 'Emi', 'Finn', 'Gus', 'Hana'];
const COLORS = ['#7c3aed', '#0ea5e9', '#16a34a', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#a3a3a3', '#6366f1'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const t0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...m);

// A real GPU (Metal) — the software renderer gets the felt wrong and is far too slow for nine tables.
const LAUNCH = (videoFile) => ({
  channel: 'chromium',
  headless: !flag('headed'),
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // The window the size of the phone's screen, or the recording shows the default window around it.
    `--window-size=${String(PHONE.viewport.width)},${String(PHONE.viewport.height)}`,
    ...(videoFile ? [`--use-file-for-fake-video-capture=${videoFile}`] : []),
  ],
});

/** The phone, but in Chromium: only Chromium can fake a camera and a mic. */
const phoneContext = (browser, extra = {}) =>
  browser.newContext({
    ...PHONE,
    defaultBrowserType: undefined,
    permissions: ['camera', 'microphone'],
    ...extra,
  });

// ---------------------------------------------------------------- owner sign-in

if (flag('login')) {
  mkdirSync(join(STATE_FILE, '..'), { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', headless: false });
  const page = await (await browser.newContext()).newPage();
  await page.goto(WEB);
  console.log('Sign in as the owner in the window that just opened (the small trigger in the bottom-right corner).');
  await page.waitForURL(/\/lobby/, { timeout: 10 * 60_000 });
  await page.context().storageState({ path: STATE_FILE });
  console.log(`Saved the owner's session to ${STATE_FILE}. Now run the simulation without --login.`);
  await browser.close();
  process.exit(0);
}

// ---------------------------------------------------------------- fake cameras

/** Each player's camera: a coloured name card with something moving on it, so the nine feeds are told apart. */
function makeCameraFeeds(dir) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < PLAYERS; i++) {
    const file = join(dir, `cam-${String(i)}.y4m`);
    files.push(file);
    if (existsSync(file)) continue;
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${COLORS[i]}:s=320x240:r=15:d=8`,
      '-f', 'lavfi', '-i', 'testsrc2=s=120x90:r=15:d=8',
      '-filter_complex', `[1]hue=h=${String(i * 40)}[m];[0][m]overlay=x='100+80*sin(t*1.6+${String(i)})':y='75+50*cos(t*1.1)'`,
      '-pix_fmt', 'yuv420p', file,
    ]);
  }
  return files;
}

// ---------------------------------------------------------------- page instrumentation

/** Counts peer connections by state and frames drawn, so the report can say what each phone actually saw. */
function instrument() {
  const w = window;
  w.__sim = { pcs: [], frames: 0 };
  const Orig = w.RTCPeerConnection;
  w.RTCPeerConnection = function (...a) {
    const pc = new Orig(...a);
    w.__sim.pcs.push(pc);
    return pc;
  };
  w.RTCPeerConnection.prototype = Orig.prototype;
  const tick = () => {
    w.__sim.frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function sample(page) {
  return page
    .evaluate(async () => {
      const s = window.__sim;
      const f0 = s.frames;
      await new Promise((r) => setTimeout(r, 1000));
      const states = {};
      for (const pc of s.pcs) states[pc.connectionState] = (states[pc.connectionState] ?? 0) + 1;
      // On a phone with more than 4 cameras on, the seats' videos give way to a bar of the (at most 2) people speaking.
      const videos = [...document.querySelectorAll('.seat-video video, .voice-tile video, .speaker-bar-tile video')];
      const live = videos.filter((v) => v.readyState >= 2 && v.videoWidth > 0 && !v.paused).length;
      const dbg = window.__scene3d?.debugState?.();
      return {
        fps: s.frames - f0,
        peers: states,
        videos: videos.length,
        liveVideos: live,
        view3d: !!document.querySelector('[data-testid="table-3d"]'),
        quality: localStorage.getItem('pokerclause.tableQuality'),
        hidden: document.hidden,
        boardLean: dbg ? Number(dbg.boardLean.toFixed(2)) : null,
        reconnecting: /reconnect/i.test(document.body.innerText),
      };
    })
    .catch((e) => ({ error: String(e).slice(0, 120) }));
}

// ---------------------------------------------------------------- the people

class Player {
  constructor(index, name) {
    this.index = index;
    this.name = name;
    this.seat = index;
    this.errors = [];
    this.sockets = 0;
    this.actions = [];
    this.samples = [];
  }

  async open(videoFile) {
    this.browser = await chromium.launch(LAUNCH(videoFile));
    const extra = {};
    if (this.index === 0 && existsSync(STATE_FILE) && !opt('admin-password')) extra.storageState = STATE_FILE;
    this.ctx = await phoneContext(this.browser, extra);
    await this.ctx.addInitScript(instrument);
    await this.ctx.addInitScript(() => localStorage.setItem('pokerclause.tableView', 'seated'));
    this.page = await this.ctx.newPage();
    await this.record();
    this.page.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message}`));
    this.page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) this.errors.push(m.text().slice(0, 300));
    });
    // The board, read off the table's own updates (the scene's debug hook only exists in dev builds).
    this.board = 0;
    this.page.on('websocket', (ws) => {
      this.sockets++;
      ws.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string') return;
        if (payload.includes('"board":[')) this.lastStateAt = Date.now();
        const ph = /"phase":"([a-z-]+)"/.exec(payload);
        if (ph) this.phase = ph[1];
        // Whose turn it is, from the same updates: when this player's turn began.
        const a = /"actingSeat":(\d+|null)/.exec(payload);
        if (a) {
          const mine = a[1] === String(this.seat);
          if (mine && !this.myTurn) this.turnAt = Date.now();
          this.myTurn = mine;
        }
        const m = /"board":\[([^\]]*)\]/.exec(payload);
        if (m) this.board = m[1] ? m[1].split(',').length : 0;
      });
    });
  }

  /**
   * Records the screen as the phone shows it: Chrome's screencast (frames
   * only arrive when something changes) into ffmpeg at a steady 15 fps.
   * Playwright's own recorder crops a high-DPI phone screen.
   */
  async record() {
    const { width, height } = PHONE.viewport;
    const size = `${String(width * 2)}:${String(height * 2)}`;
    this.clip = join(OUT, 'phones', `${String(this.index + 1)} - ${this.name}.mp4`);
    this.ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '15', '-i', '-',
      '-vf', `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', this.clip,
    ]);
    this.ffmpegDone = new Promise((r) => this.ffmpeg.on('close', r));
    const cdp = await this.ctx.newCDPSession(this.page);
    let frame = null;
    cdp.on('Page.screencastFrame', (f) => {
      frame = Buffer.from(f.data, 'base64');
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: width * 2, maxHeight: height * 2 });
    this.ticker = setInterval(() => {
      if (frame) this.ffmpeg.stdin.write(frame);
    }, 1000 / 15);
  }

  async stopRecording() {
    clearInterval(this.ticker);
    this.ffmpeg.stdin.end();
    await this.ffmpegDone;
  }

  /** The 3D canvas, at a point where nothing sits on top of it. */
  async canvasPoint() {
    return this.page.evaluate(() => {
      const c = document.querySelector('.table3d-canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      for (const fy of [0.3, 0.22, 0.4, 0.15, 0.5]) {
        for (const fx of [0.5, 0.35, 0.65]) {
          const x = r.left + r.width * fx;
          const y = r.top + r.height * fy;
          if (document.elementFromPoint(x, y) === c) return { x, y };
        }
      }
      return null;
    });
  }

  async drag(dx, dy, steps = 24) {
    const p = await this.canvasPoint();
    if (!p) return;
    const m = this.page.mouse;
    await m.move(p.x, p.y);
    await m.down();
    for (let i = 1; i <= steps; i++) {
      // A real player stops looking around when it's their turn.
      if (this.myTurn && i > 1) break;
      await m.move(p.x + (dx * i) / steps, p.y + (dy * i) / steps);
      await sleep(16);
    }
    await m.up();
  }

  /** A look around: to one side, the other, and back — the way people check who's at the table. */
  async lookAround() {
    if (this.myTurn) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    await this.drag(side * rand(90, 170), 0);
    await sleep(rand(700, 1600));
    if (this.myTurn) return;
    await this.drag(-side * rand(160, 280), 0);
    await sleep(rand(700, 1600));
    if (this.myTurn) return;
    await this.drag(side * rand(70, 110), 0);
  }

  /** Leans in over the board (only works once the flop is down) and, later, sits back. */
  async leanIn() {
    await this.drag(0, rand(120, 200));
  }
  async sitBack() {
    await this.drag(0, -rand(140, 220));
  }

  boardSize() {
    return this.board;
  }

  /** On a phone's sizer: ½ pot, then the $ handle (now the button) sends it. */
  async sendHalfPot() {
    await this.page.getByRole('button', { name: '½ pot' }).click({ timeout: 3000 });
    const slider = this.page.getByLabel('Bet amount');
    await slider.focus();
    await this.page.keyboard.press('Enter');
  }

  /** Acts when it's this player's turn: mostly check/call so hands reach the river, now and then a raise or a fold. */
  async actIfTurn() {
    // A phone's action rails, or the plain bar when there's nothing to size.
    const bar = this.page.locator('.bet-overlay, .action-bar').first();
    if (!(await bar.isVisible().catch(() => false))) return false;
    await sleep(rand(700, 2200));
    const btn = (name) => bar.getByRole('button', { name, exact: true });
    const call = bar.getByRole('button', { name: /^Call/ });
    const r = Math.random();
    let did = null;
    const at = Date.now();
    try {
      if (r < 0.1 && (await btn('Raise').isVisible())) {
        await btn('Raise').click();
        await this.sendHalfPot();
        did = 'raise';
      } else if (r < 0.16 && (await btn('Bet').isVisible())) {
        await btn('Bet').click();
        await this.sendHalfPot();
        did = 'bet';
      } else if (await btn('Check').isVisible()) {
        await btn('Check').click();
        did = 'check';
      } else if (r < 0.12 && (await btn('Fold').isVisible())) {
        await btn('Fold').click();
        did = 'fold';
      } else if (await call.isVisible()) {
        await call.click();
        did = 'call';
      } else if (await btn('Fold').isVisible()) {
        await btn('Fold').click();
        did = 'fold';
      }
    } catch (e) {
      this.errors.push(`action: ${String(e).split('\n')[0]}`);
    }
    if (did) {
      // How long until the table's next update arrives from the server — the action's round trip.
      const deadline = Date.now() + 10_000;
      while ((this.lastStateAt ?? 0) < at && Date.now() < deadline) await sleep(10);
      const ms = (this.lastStateAt ?? 0) >= at ? this.lastStateAt - at : null;
      const reaction = this.turnAt ? at - this.turnAt : null;
      this.actions.push({ did, ms, reaction });
      if (flag('verbose')) log(`    ${this.name} ${did}: on the turn for ${String(reaction)} ms before acting, server answered in ${String(ms)} ms`);
      await bar.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    }
    return !!did;
  }
}

// ---------------------------------------------------------------- the run

mkdirSync(join(OUT, 'phones'), { recursive: true });
log(`Output: ${OUT}`);
log(`Server: ${WEB} (API ${API}), ${String(PLAYERS)} players, ${String(HANDS)} hands`);
if (!opt('admin-password') && !existsSync(STATE_FILE)) {
  console.error(`No owner session yet. Run with --login first (it saves to ${STATE_FILE}).`);
  process.exit(1);
}

const feeds = makeCameraFeeds(join(homedir(), '.pokerclause-sim', 'cams'));
const players = NAMES.slice(0, PLAYERS).map((n, i) => new Player(i, n));
const health = [];
let running = true;
const healthLoop = (async () => {
  while (running) {
    const at = Date.now();
    try {
      const res = await fetch(`${API}/health`);
      health.push({ t: Math.round((at - t0) / 1000), ms: Date.now() - at, status: res.status });
    } catch (e) {
      health.push({ t: Math.round((at - t0) / 1000), ms: null, status: String(e).slice(0, 80) });
    }
    await sleep(5000);
  }
})();

const owner = players[0];
await owner.open(feeds[0]);
const op = owner.page;

if (opt('admin-password')) {
  await op.goto(WEB);
  await op.locator('.admin-login-trigger').click();
  await op.getByLabel('Email or username').fill(opt('admin-user', 'admin'));
  await op.getByLabel('Password').fill(opt('admin-password'));
  await op.locator('form').getByRole('button', { name: 'Log in' }).click();
}
else await op.goto(`${WEB}/lobby`);
await op.waitForURL(/\/lobby/, { timeout: 30_000 }).catch(() => {
  console.error('The owner is not signed in (the saved session may have expired). Run with --login again.');
  process.exit(1);
});

// The table: open invite, one link for everyone, $200 each.
const tableName = `Sim ${String(PLAYERS)} humans ${stamp.slice(11)}`;
await op.getByRole('button', { name: 'Create table' }).click();
await op.getByLabel('Name', { exact: true }).fill(tableName);
await op.getByLabel('Small blind').fill('1');
await op.getByLabel('Big blind').fill('2');
await op.getByLabel('Max seats').fill('9');
await op.getByLabel(/Open invite link/).check();
await op.getByLabel('Starting chips for each player').fill('200');
await op.getByRole('button', { name: 'Create', exact: true }).click();
const link = await op.locator('.modal input[readonly]').inputValue();
await op.getByRole('button', { name: 'Go to table' }).click();
await op.waitForURL(/\/table\//);
const tableUrl = op.url();
log(`Table "${tableName}" created: ${tableUrl}`);
await op.getByTestId('table-3d').waitFor({ timeout: 60_000 });

/** Sits a player at their seat — the owner through the seat menu, a guest straight from it. */
async function sit(p) {
  const page = p.page;
  const seat = page.locator(`[data-testid="seat-${String(p.seat)}"]`);
  const sitHere = seat.getByText('Sit here');
  if (await sitHere.isVisible().catch(() => false)) await sitHere.click();
  else {
    await seat.locator('.seat-empty-tap').click();
    const item = page.getByRole('menuitem', { name: 'Sit here' });
    await item.or(page.locator('.modal')).first().waitFor();
    if (await item.isVisible()) await item.click();
  }
  const buyIn = page.getByLabel(/Buy-in/);
  if (await buyIn.isVisible().catch(() => false)) await buyIn.fill('200');
  await page.getByRole('button', { name: 'Sit down' }).click();
  await seat.and(page.locator('[data-seat-status="active"], [data-seat-status="sitting-out"]')).waitFor({ timeout: 20_000 });
}

async function joinVideo(p) {
  const btn = p.page.getByRole('button', { name: '🎥 Join with video' });
  await btn.waitFor({ timeout: 20_000 });
  await btn.click();
}

await sit(owner);
await joinVideo(owner);
log('Owner seated at seat 1 with camera and mic on');

for (const p of players.slice(1)) {
  await sleep(4000);
  await p.open(feeds[p.index]);
  await p.page.goto(link);
  await p.page.getByLabel('Display name').fill(p.name);
  await p.page.getByLabel('I’ve read and agree to the guest terms').check();
  await p.page.getByRole('button', { name: 'Play now' }).click();
  await p.page.locator('[data-testid="seat-0"]').waitFor({ timeout: 60_000 });
  await sit(p);
  await joinVideo(p);
  log(`${p.name} joined by the link, seat ${String(p.seat + 1)}, camera and mic on`);
}

// Give the mesh (8 connections a phone) time to come up, then see what everyone gets.
await sleep(15_000);
const before = await Promise.all(players.map((p) => sample(p.page)));
log('Before the first hand:', before.map((s, i) => `${NAMES[i]} ${String(s.peers?.connected ?? 0)}/${String(PLAYERS - 1)} peers ${String(s.fps)}fps`).join(' | '));

// Everyone plays (and looks around) on their own, at once.
let handsStarted = 0;
let lastBoard = 0;
const sampler = (async () => {
  while (running) {
    await sleep(15_000);
    const s = await Promise.all(players.map((p) => sample(p.page)));
    s.forEach((x, i) => players[i].samples.push({ t: Math.round((Date.now() - t0) / 1000), ...x }));
    log('  ' + s.map((x, i) => `${NAMES[i]} ${String(x.fps ?? 'x')}fps ${String(x.peers?.connected ?? 0)}/${String(PLAYERS - 1)}p`).join(' | '));
  }
})();

const loops = players.map(async (p) => {
  let leaned = false;
  let nextLook = Date.now() + rand(4000, 15000);
  while (running) {
    const acted = await p.actIfTurn();
    const board = p.boardSize();
    if (p.index === 0) lastBoard = Math.max(lastBoard, board);
    // Lean in once the flop is down (the owner always, the others now and then); sit back when the hand ends.
    if (board >= 3 && !leaned && (p.index === 0 || Math.random() < 0.02)) {
      await p.leanIn();
      leaned = true;
    } else if (board === 0 && leaned) {
      await p.sitBack();
      leaned = false;
    } else if (!acted && Date.now() > nextLook) {
      await p.lookAround();
      nextLook = Date.now() + rand(p.index === 0 ? 12_000 : 20_000, 45_000);
    }
    await sleep(400);
  }
});

const playHand = op.getByRole('button', { name: 'Play Hand' });
let stopReason = null;
try {
while (handsStarted < HANDS) {
  await playHand.waitFor({ timeout: 180_000 });
  await op.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Play Hand');
    return b && !b.disabled;
  }, null, { timeout: 60_000 });
  await playHand.click();
  handsStarted++;
  lastBoard = 0;
  const until = async (ok, ms) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await sleep(200);
    return ok();
  };
  if (!(await until(() => owner.phase === 'in-hand', 30_000))) throw new Error('the hand did not start');
  log(`Hand ${String(handsStarted)} of ${String(HANDS)} dealt`);
  if (!(await until(() => owner.phase !== 'in-hand', 600_000))) log('  (still going after 10 min)');
  log(`Hand ${String(handsStarted)} over (board ${String(lastBoard)} cards)`);
}
} catch (e) {
  stopReason = String(e).split('\n')[0];
  log(`Stopped early: ${stopReason}`);
}
// Let the last hand's showdown and chip push play out on camera.
await sleep(8000);
const after = await Promise.all(players.map((p) => sample(p.page)));
running = false;
await Promise.all([...loops, sampler, healthLoop]);

if (!flag('keep-table')) {
  try {
    await op.getByRole('button', { name: 'Table menu' }).click();
    await op.getByRole('button', { name: 'Terminate table' }).click();
    await op.getByRole('button', { name: 'Yes, terminate' }).click();
    await op.waitForURL(/\/lobby/, { timeout: 15_000 });
    log('Table terminated');
  } catch (e) {
    log(`Could not terminate the table: ${String(e).split('\n')[0]}`);
  }
}

for (const p of players) await p.stopRecording();
for (const p of players) {
  await p.ctx.close();
  await p.browser.close();
}

// ---------------------------------------------------------------- videos and report

const clips = players.map((p) => p.clip).filter((c) => existsSync(c));
if (clips.length === 9) {
  // All nine phones side by side: a 3x3 grid, seat 1 top left.
  const inputs = clips.flatMap((c) => ['-i', c]);
  const scaled = clips.map((_, i) => `[${String(i)}]scale=262:440,setsar=1[v${String(i)}]`).join(';');
  const layout = clips.map((_, i) => `${String((i % 3) * 262)}_${String(Math.floor(i / 3) * 440)}`).join('|');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', `${scaled};${clips.map((_, i) => `[v${String(i)}]`).join('')}xstack=inputs=9:layout=${layout}:fill=black[out]`, '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(OUT, 'All 9 phones.mp4')]);
}

const okHealth = health.filter((h) => h.status === 200).map((h) => h.ms);
const pct = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : null);
const actionMs = players.flatMap((p) => p.actions.map((a) => a.ms)).filter((ms) => ms !== null);
const lines = [
  `# ${tableName}`,
  '',
  ...(stopReason ? [`**Stopped early:** ${stopReason}`, ''] : []),
  `${WEB} — ${String(PLAYERS)} players on iPhone 15 Pro screens (Chromium, fake camera + mic), 3D seated view, ${String(handsStarted)} hands, ${String(Math.round((Date.now() - t0) / 1000))} s.`,
  '',
  '## Server',
  `- Health checks: ${String(okHealth.length)}/${String(health.length)} OK; median ${String(pct(okHealth, 0.5))} ms, worst ${String(Math.max(...okHealth, 0))} ms.`,
  `- Action round trip (tap → the server's updated table arrives): median ${String(pct(actionMs, 0.5))} ms, 95th ${String(pct(actionMs, 0.95))} ms, worst ${String(Math.max(...actionMs, 0))} ms over ${String(actionMs.length)} actions.`,
  '',
  '## Each phone (at the end)',
  '| Player | Cameras shown | Peer links | FPS | 3D | Sockets opened | Actions | Errors |',
  '|---|---|---|---|---|---|---|---|',
  ...players.map((p, i) => {
    const s = after[i];
    return `| ${String(i + 1)} ${p.name} | ${String(s.liveVideos ?? '?')}/${String(PLAYERS)} | ${JSON.stringify(s.peers ?? {})} | ${String(s.fps ?? '?')} | ${s.view3d ? 'yes' : 'NO'} | ${String(p.sockets)} | ${String(p.actions.length)} | ${String(p.errors.length)} |`;
  }),
  '',
  '## Errors seen',
  ...players.flatMap((p) => [...new Set(p.errors)].slice(0, 15).map((e) => `- ${p.name}: ${e}`)),
];
writeFileSync(join(OUT, 'Report.md'), lines.join('\n') + '\n');
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify({ health, before, after, players: players.map((p) => ({ name: p.name, errors: p.errors, actions: p.actions, samples: p.samples, sockets: p.sockets })) }, null, 2));
log(`Done. ${String(clips.length)} recordings and a report in ${OUT}`);
