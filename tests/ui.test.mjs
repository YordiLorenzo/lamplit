// UI edge cases for Lamplit in Chromium, with a fake Tauri API (no Windows needed; page.mjs serves the page as
// Tauri does, so a script, style or image the CSP blocks fails the run).
// Setup once: `npm --prefix tests ci`, then `npm --prefix tests exec -- playwright-core install --no-shell chromium`,
// or set CHROME to the path of a Chrome or Edge executable. The art checks run on small generated images; for
// realistic covers in the screenshots, copy %LOCALAPPDATA%\lamplit\art from a Windows PC that has run Lamplit to
// tests/art.
// Run: `npm --prefix tests test` (the unit tests in logic.test.mjs and contract.test.mjs, then this file). PERF=1 adds
// timing checks, which depend on the machine. Screenshots land in tests/shots/.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipc, known, like, values } from './fixtures.mjs';
import { dockTests } from './dock.mjs';
import { probeTests } from './probe.mjs';
import { assetOrigin, commands, cspHeader, emit, idle, open as openPage, pageOrigin, serveFile, settled, until } from './page.mjs';
import { SCENES } from '../ui/screensaver/scenes.js';
import { SPRINGS } from '../ui/springs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = process.argv[2] ?? path.join(here, '..', 'ui');
const shots = path.join(here, 'shots');
mkdirSync(shots, { recursive: true });
const artDir = path.join(here, 'art');

const noArt = { portrait: null, hero: null, logo: null };
/** Art for the games: tests/art when it is there, else the generated set (see generateArt). */
let art = (existsSync(artDir) ? readdirSync(artDir) : []).map((id) => {
  const f = (n) => (existsSync(path.join(artDir, id, n)) ? path.join(artDir, id, n) : null);
  return { portrait: f('portrait.jpg'), hero: f('hero.jpg'), logo: f('logo.png') };
});

function game(i, { noArt: none, ...extra } = {}) {
  const store = ['steam', 'epic', 'ea', null, 'xbox'][i % 5];
  return like(ipc('games')[0], {
    id: `pc:${i}`,
    name: `Game ${String(i).padStart(3, '0')}`,
    store,
    dir: `D:\\Games\\Game ${i}`,
    note: null,
    last_played: 0,
    play_minutes: 0,
    favourite: false,
    hidden: false,
    art: none || !art.length ? noArt : art[i % art.length],
    requires: store ? [store] : [],
    ...extra,
  });
}

/** What the page hears about a launched game. @param {string} state @param {string} id */
const play = (state, id, changes = {}) => like(ipc('play').find((p) => p.state === state), { id, ...changes });
/** Rust's news that a game runs: the game being started has the screen, and its starting screen ends. */
async function running(page, id) {
  await emit(page, 'play', play('running', id));
}
/** Back to the game: the game gets the screen once the home screen is under the veil (launch.js backToGame). */
const resumed = (page) => until(page, () => window.__calls.at(-1)?.[0] === 'launch_resume');
/** One line of the starting screen, in one of the states Rust sends. */
const step = (changes) => like(ipc('launch-step'), { ...changes, state: known('step_state', changes.state) });

const perf = process.env.PERF === '1';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`);
}

// Channel 'chromium' is Playwright's own full Chromium build, in its new headless mode.
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: 'chromium' });

/** A cover, a hero and a logo drawn in the browser and saved to a temporary folder, removed when the run ends. */
async function generateArt() {
  const page = await browser.newPage();
  const files = await page.evaluate(() => {
    const draw = (width, height, type, colour) => {
      const canvas = Object.assign(document.createElement('canvas'), { width, height });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, width, height);
      return canvas.toDataURL(type).split(',')[1];
    };
    return {
      'portrait.jpg': draw(60, 90, 'image/jpeg', '#2a4d8f'),
      'hero.jpg': draw(192, 62, 'image/jpeg', '#b4432c'),
      'logo.png': draw(64, 24, 'image/png', '#f0f0f0'),
    };
  });
  await page.close();
  const dir = mkdtempSync(path.join(tmpdir(), 'lamplit-art-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [name, base64] of Object.entries(files)) writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
  return { portrait: path.join(dir, 'portrait.jpg'), hero: path.join(dir, 'hero.jpg'), logo: path.join(dir, 'logo.png') };
}

if (!art.length) {
  console.log('SKIP realistic covers: tests/art is missing, so the screenshots show generated art');
  art = [await generateArt()];
}
const pageErrors = [];
/** Every command any page called, to check each one is tested. */
const called = new Set();

const open = (opts, viewport) => openPage(browser, uiDir, opts, viewport);

/** Closes a page, keeping its errors and the commands it called for the checks at the end. */
async function close(page) {
  pageErrors.push(...(await page.evaluate(() => window.__errors)));
  // main.js logs what nothing caught, an exception after an await among them, as an error line.
  pageErrors.push(...(await page.evaluate(() => window.__logs.filter((line) => line.startsWith('error ')))));
  for (const [cmd] of await page.evaluate(() => window.__calls)) called.add(cmd);
  await page.close();
}

const state = (page) =>
  page.evaluate(() => ({
    title: document.getElementById('title').textContent,
    titleOn: document.getElementById('title').classList.contains('on'),
    logoOn: document.getElementById('logo').classList.contains('on'),
    store: document.getElementById('store').textContent,
    hint: document.getElementById('hint').textContent,
    overlay: document.getElementById('overlay').classList.contains('on'),
    overlayTitle: document.getElementById('overlayTitle').textContent,
    overlaySub: document.getElementById('overlaySub').textContent,
    toast: [...document.querySelectorAll('#toast.on, #gameNews.on')].map((t) => t.textContent).join(' | '),
    empty: document.getElementById('empty').hidden ? '' : document.getElementById('empty').textContent,
    details: document.getElementById('details').classList.contains('on'),
    dName: document.getElementById('dName').textContent,
    dPlayed: document.getElementById('dPlayed').textContent,
    covers: document.querySelectorAll('#track .cover').length,
    focusIndex: [...document.querySelectorAll('.cover')].findIndex((c) => c.classList.contains('focus')),
    focusName: document.querySelector('.cover.focus .name')?.textContent ?? null,
    calls: window.__calls.map((c) => c[0]),
    lastCall: window.__calls.at(-1),
    errors: window.__errors,
    scrollW: document.documentElement.scrollWidth,
  }));

// 1. Discovery not finished yet, then nothing found.
{
  const page = await open({ games: null });
  let s = await state(page);
  check('loading text while discovery runs', s.empty === 'Looking for games…', s.empty);
  await page.evaluate(() => window.__emit('games', []));
  s = await state(page);
  check('empty list says so', s.empty === 'No games found', s.empty);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  s = await state(page);
  check('keys on an empty list do nothing', !s.calls.includes('launch_start') && s.errors.length === 0, JSON.stringify(s.errors));
  await page.screenshot({ path: path.join(shots, 'empty.png') });
  await close(page);
}

// 2. One game without any art; edges; launch; running; ended.
{
  const page = await open({ games: [game(1, { name: 'Lonely Game', noArt: true })] });
  let s = await state(page);
  check('no-art game shows its name as title', s.titleOn && s.title === 'Lonely Game');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  s = await state(page);
  check('edges keep focus', s.focusIndex === 0);
  await page.screenshot({ path: path.join(shots, 'one-game-no-art.png') });
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('Enter launches', s.lastCall?.[0] === 'launch_start' && s.lastCall[1].id === 'pc:1');
  check('starting overlay shows', s.overlay && s.overlayTitle === 'Starting Lonely Game…', s.overlayTitle);
  await page.keyboard.press('ArrowRight');
  s = await state(page);
  check('navigation is ignored while starting', s.focusIndex === 0);
  await running(page, 'pc:1');
  s = await state(page);
  check('running hides the overlay', !s.overlay);
  check('focused running game offers Back to game', s.hint.includes('Back to game'), s.hint);
  await page.keyboard.press('Enter');
  await resumed(page);
  s = await state(page);
  check('Enter on the running game resumes it', s.lastCall?.[0] === 'launch_resume');
  await emit(page, 'play', play('ended', 'pc:1'));
  s = await state(page);
  check('ended returns to browsing', !s.overlay && s.hint.includes('Play') && !s.hint.includes('Back to game'), s.hint);
  await page.keyboard.press('i');
  s = await state(page);
  check('a game that ran counts as played', s.dPlayed === 'Played today', s.dPlayed);
  await close(page);
}

// 3. Launch failure and timeout messages; Escape cancels.
{
  const launchError = like(ipc('error'), { message: "Windows couldn't open D:\\x.exe (error 2)" });
  const page = await open({ games: [game(1), game(2)], launchError });
  await page.keyboard.press('Enter');
  await idle(page);
  let s = await state(page);
  check('launch error shows a toast and leaves starting', s.toast.includes("couldn't open") && !s.overlay, s.toast);
  const logs = await page.evaluate(() => window.__logs);
  check('a failed command is logged', logs.includes("warn launch_start failed: Windows couldn't open D:\\x.exe (error 2)"), JSON.stringify(logs));
  await close(page);
}
{
  // Tauri itself refuses a call (arguments it can't read, say) with a plain string rather than Lamplit's error.
  const page = await open({ games: [game(1)], launchError: 'invalid args `id` for command `launch_start`' });
  await page.keyboard.press('Enter');
  await idle(page);
  const s = await state(page);
  check("Tauri's own refusal reaches the player as its text, after the game's name", s.toast.endsWith(': invalid args `id` for command `launch_start`') && !s.overlay, s.toast);
  await close(page);
}
{
  const page = await open({ games: [game(1), game(2)] });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  let s = await state(page);
  check('Escape cancels a launch', s.calls.includes('launch_cancel') && !s.overlay);
  await page.keyboard.press('i');
  s = await state(page);
  check("a cancelled launch doesn't count as played", s.dPlayed === 'Not played yet', s.dPlayed);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await emit(page, 'launch-step', step({ id: 'pc:1', key: 'timeout', state: 'warn', label: "Game 001 hasn't started yet", store: 'steam' }));
  s = await state(page);
  check('a slow start stays on the starting screen with a way to the store', s.overlay && s.hint.includes('Open') && s.hint.includes('Cancel'), s.hint);
  await emit(page, 'play', play('failed', 'pc:1', { message: "EA app isn't installed, and Game 001 needs it." }));
  s = await state(page);
  check('a failed launch shows why', !s.overlay && s.toast.includes("isn't installed"), s.toast);
  await close(page);
}

// 4. A game that closes right after starting brings back the overlay; another game's news leaves it alone.
{
  const page = await open({ games: [game(1), game(2), game(3)] });
  await page.keyboard.press('Enter');
  await running(page, 'pc:1');
  await emit(page, 'play', play('starting', 'pc:1'));
  let s = await state(page);
  check('restarting shows the waiting overlay', s.overlay && s.overlaySub.startsWith('Waiting'), s.overlaySub);
  await page.keyboard.press('Escape');
  // Game 1 runs; summon Lamplit, start game 2, then game 1 closes while 2 is starting.
  await running(page, 'pc:1');
  await emit(page, 'summoned', 'pc:1');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await emit(page, 'play', play('ended', 'pc:1'));
  s = await state(page);
  check("another game's end keeps the starting overlay", s.overlay && s.overlayTitle.includes('Game 002'), s.overlayTitle);
  await emit(page, 'play', play('starting', 'pc:1'));
  s = await state(page);
  check("another game's restart keeps the starting overlay", s.overlay && s.overlayTitle.includes('Game 002'), s.overlayTitle);
  await running(page, 'pc:2');
  s = await state(page);
  check('the launched game still clears its overlay', !s.overlay);
  // Game 2 runs; summon Lamplit, start game 1, then game 2 closes to restart while 1 is starting, and 1 fails.
  await emit(page, 'summoned', 'pc:2');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await emit(page, 'play', play('starting', 'pc:2'));
  await emit(page, 'play', play('failed', 'pc:1'));
  await page.keyboard.press('ArrowRight');
  s = await state(page);
  check(
    "a game that closed during another game's launch no longer counts as running",
    s.focusName === 'Game 002' && s.hint.includes('Play') && !s.hint.includes('Back to game'),
    `${s.focusName} ${s.hint}`
  );
  await close(page);
}

// 5. Focus moves to a game that ends, so Details showing another game closes: ✕ there would start the wrong game.
{
  const page = await open({ games: [game(1), game(2), game(3)] });
  await page.keyboard.press('Enter');
  await running(page, 'pc:1');
  await emit(page, 'summoned', 'pc:1');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('i');
  let s = await state(page);
  check('details open on another game while one runs', s.details && s.dName === 'Game 002', s.dName);
  await emit(page, 'play', play('ended', 'pc:1'));
  s = await state(page);
  check('the running game ending closes details', !s.details && s.focusName === 'Game 001', `${s.details} ${s.focusName}`);
  await close(page);
}

// 6. A 'games' event that comes in while the page still waits for library_games wins over that older answer.
{
  const page = await open({ games: [game(1)], earlyGames: [game(1), game(2, { name: 'New Install' })] });
  const s = await state(page);
  check('a games event during start-up wins over the slower answer', s.covers === 2, `${s.covers} covers`);
  await close(page);
}

// 7. Clicking a cover after the row was re-sorted picks that game.
{
  const page = await open({ games: [game(1), game(2), game(3), game(4)] });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter'); // game 3
  await running(page, 'pc:3');
  await emit(page, 'play', play('ended', 'pc:3'));
  let s = await state(page);
  check('ended game moves to the front and keeps focus', s.focusIndex === 0, `focus ${s.focusIndex}`);
  // Click the cover that is now second (game 1), once the row has slid there.
  await settled(page);
  const second = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#track .cover')][1].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(second.x, second.y);
  s = await state(page);
  check('click after re-sort focuses the clicked cover', s.focusIndex === 1, `focus ${s.focusIndex}`);
  await close(page);
}

// 8. Pad and keyboard together: keys are ignored for 2 s after pad input (Steam mirrors the pad as keys).
{
  const page = await open({ games: [game(1), game(2), game(3), game(4)] });
  await page.evaluate(() => window.__emit('pad', 'right'));
  await page.keyboard.press('ArrowRight');
  let s = await state(page);
  check('mirrored key after pad input is ignored', s.focusIndex === 1, `focus ${s.focusIndex}`);
  await page.waitForTimeout(2100); // the 2 s window itself
  await page.keyboard.press('ArrowRight');
  s = await state(page);
  check('keyboard works again 2 s later', s.focusIndex === 2, `focus ${s.focusIndex}`);
  await page.evaluate(() => window.__emit('pad', 'menu'));
  s = await state(page);
  check('Options opens details', s.details);
  await page.evaluate(() => window.__emit('pad', 'back'));
  s = await state(page);
  check('Circle closes details', !s.details);
  check('the hints show PlayStation symbols at first', s.hint === '✕Play≡Game menu△Settings□Find', s.hint);
  await emit(page, 'pad-kind', known('pad_kind', 'xbox'));
  s = await state(page);
  const colour = await page.evaluate(() => getComputedStyle(document.querySelector('#hint b')).color);
  check('an Xbox controller turns the hints into its letters', s.hint === 'APlay≡Game menuYSettingsXFind' && colour === 'rgb(127, 211, 110)', `${s.hint} ${colour}`);
  await page.evaluate(() => window.__emit('pad', 'menu'));
  await emit(page, 'pad-kind', known('pad_kind', 'other'));
  s = await state(page);
  check('other controllers keep the letters, also in Details', s.details && s.hint === 'APlayBClose', s.hint);
  await emit(page, 'pad-kind', known('pad_kind', 'dualsense'));
  s = await state(page);
  check('a DualSense brings the symbols back', s.hint === '✕Play○Close', s.hint);
  await close(page);
  // Rust reads the controllers before the page listens: the page asks which kind was used last.
  const early = await open({ games: [game(1), game(2)], padKind: known('pad_kind', 'xbox') });
  s = await state(early);
  check('the hints start in the letters of a controller used before the page listened', s.hint === 'APlay≡Game menuYSettingsXFind', s.hint);
  await close(early);
}

// 9. 300 games with long names: layout at 1080p and 4K, no horizontal scroll, and with PERF=1 the speed of moving.
for (const vp of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
  const many = Array.from({ length: 300 }, (_, i) =>
    game(i, i === 1 ? { name: 'The Extraordinarily Long Title Of A Game: Definitive Remastered Anniversary Edition Deluxe', noArt: true } : {})
  );
  const page = await open({ games: many }, vp);
  const t = await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      window.__emit('pad', 'right');
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { median: times[50], p95: times[95], max: times[99] };
  });
  let s = await state(page);
  check(`${vp.width}p: 100 moves land on game 100`, s.focusIndex === 100, `focus ${s.focusIndex}`);
  check(`${vp.width}p: no horizontal page scroll`, s.scrollW <= vp.width, `scrollWidth ${s.scrollW}`);
  if (perf) {
    check(`${vp.width}p: move handling under 4 ms (median)`, t.median < 4, `median ${t.median.toFixed(2)} ms, p95 ${t.p95.toFixed(2)}, max ${t.max.toFixed(2)}`);
    // Frame times while scrolling fast: count long frames.
    const frames = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const deltas = [];
          let last = performance.now();
          let n = 0;
          const step = (now) => {
            deltas.push(now - last);
            last = now;
            if (n % 3 === 0) window.__emit('pad', n < 90 ? 'left' : 'right');
            if (++n < 120) requestAnimationFrame(step);
            else resolve(deltas.slice(5));
          };
          requestAnimationFrame(step);
        })
    );
    frames.sort((a, b) => a - b);
    check(`${vp.width}p: frames while scrolling`, frames[Math.floor(frames.length * 0.95)] < 34, `median ${frames[Math.floor(frames.length / 2)].toFixed(1)} ms, p95 ${frames[Math.floor(frames.length * 0.95)].toFixed(1)} ms`);
  }
  await page.evaluate(() => {
    for (let i = 0; i < 200; i++) window.__emit('pad', 'left');
    window.__emit('pad', 'right');
  });
  await settled(page);
  const titleBox = await page.evaluate(() => {
    const r = document.getElementById('title').getBoundingClientRect();
    return { right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight };
  });
  check(`${vp.width}p: long title stays inside its column`, titleBox.right <= titleBox.w * 0.55 && titleBox.bottom < titleBox.h * 0.5, JSON.stringify(titleBox));
  await page.screenshot({ path: path.join(shots, `long-title-${vp.width}.png`) });
  await page.evaluate(() => window.__emit('pad', 'menu'));
  await settled(page);
  await page.screenshot({ path: path.join(shots, `details-${vp.width}.png`) });
  await close(page);
}

// 10. Art arriving later, and a broken logo, fall back cleanly.
{
  const page = await open({ games: [game(1, { noArt: true }), game(2)] });
  await emit(page, 'art', like(ipc('art'), { id: 'pc:1', art: art[0] }));
  await until(page, () => document.getElementById('logo').classList.contains('on'));
  let s = await state(page);
  check('art arriving later swaps in the logo', s.logoOn && !s.titleOn);
  const fallback = '140 170 255';
  await until(page, (gone) => !['', gone].includes(document.documentElement.style.getPropertyValue('--accent')), fallback);
  const painted = await page.evaluate(() => ({
    cover: document.querySelector('#track .cover').classList.contains('has-art'),
    accent: document.documentElement.style.getPropertyValue('--accent'),
  }));
  check('the cover shows its art, and the accent comes from the hero', painted.cover && !['', fallback].includes(painted.accent), JSON.stringify(painted));
  // Read in the same turn as the event: a logo drawn again is hidden until it has loaded again.
  const kept = await page.evaluate(() => {
    window.__emit('stores', []);
    return document.getElementById('logo').classList.contains('on');
  });
  check('store news leaves the logo alone', kept);
  await emit(page, 'art', like(ipc('art'), { id: 'pc:1', art: { ...noArt, logo: '/nope/missing.png' } }));
  await until(page, () => document.getElementById('title').classList.contains('on'));
  s = await state(page);
  check('a broken logo falls back to the title', s.titleOn && !s.logoOn);
  check('no page errors anywhere', s.errors.length === 0, JSON.stringify(s.errors));
  await close(page);
}

// 11. Settings: sections with a summary each, rows inside, ← → on ranges, ○ back to the section it came from.
{
  const page = await open({ games: [game(1), game(2)] });
  const sound = ipc('sound');
  const accessories = ipc('accessories');
  const device = (id, name, kind, isDefault) => like(sound.outputs[0], { id, windows_name: name, name, kind, default: isDefault });
  await page.evaluate((data) => {
    const s = (window.__settings = { ...data, display_mode: '3840 × 2160 at 120 Hz' });
    s.prefs_state = () => s.prefs;
    s.sound_state = () => s.sound;
    s.accessories_state = () => s.accessories;
    s.sound_change_volume = ({ delta }) => (s.sound.volume += delta);
    s.sound_set_default = ({ id }) => {
      s.sound.outputs.forEach((d) => (d.default = d.id === id));
      return s.sound;
    };
    s.prefs_set_touchpad_mouse = ({ on }) => {
      s.prefs.touchpad_mouse = on;
      return s.prefs;
    };
    s.headset_set = ({ setting, value }) => {
      s.accessories.headset[setting === 'sidetone' ? 'sidetone' : 'auto_off'] = value;
      return s.accessories.headset;
    };
  }, {
    stores_status: [ipc('stores')[1]],
    overlay_state: like(ipc('overlays'), { nvidia_stats: false }),
    quiet_state: like(ipc('quiet'), { state: known('quiet_state', 'on'), active: true, notes: [] }),
    setup_state: like(ipc('setup'), { needed: false }),
    sound: like(sound, {
      outputs: [device('tv', 'TV (Living Room TV)', 'tv', false), device('hs', 'PRO X 2 headset', 'headset', true)],
      inputs: [device('mic', 'PRO X 2 headset', 'headset', true)],
      volume: 45,
      muted: false,
    }),
    accessories: like(accessories, {
      headset: like(accessories.headset, { on: true, battery: 80, charge: known('charge', 'charging'), sidetone: 40, auto_off: 30 }),
      controllers: [
        like(accessories.controllers[0], { id: 'bt-pad', battery: { percent: 65, level: null, charge: known('charge', 'battery') }, headphones: false }),
        accessories.controllers[1],
      ],
    }),
    prefs: like(ipc('prefs'), { touchpad_mouse: false }),
  });
  const view = () =>
    page.evaluate(() => ({
      title: document.getElementById('settingsTitle').textContent,
      rows: [...document.querySelectorAll('#settingsList .row')].map((r) => r.textContent),
      focus: document.querySelector('#settingsList .row.focus')?.textContent ?? null,
      open: document.getElementById('settings').classList.contains('on'),
      hint: document.getElementById('hint').textContent,
      toast: [...document.querySelectorAll('#toast.on, #gameNews.on')].map((t) => t.textContent).join(' | '),
      lastCall: window.__calls.at(-1),
    }));
  await page.keyboard.press('c');
  await idle(page);
  let v = await view();
  check('settings open on the list of sections, Power last', v.open && v.title === 'Settings' && v.rows.length === 9 && v.rows[8].startsWith('Power'), JSON.stringify(v.rows));
  check('section summaries say what is going on', v.rows[0].includes('PRO X 2 headset · 45%') && v.rows[1].includes('On · 80% · charging') && v.rows[2].includes('2 connected · 65%, medium') && v.rows[4].includes('EA app: sign in'), JSON.stringify(v.rows));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  v = await view();
  check('a section opens with its rows', v.title === 'Headset' && v.rows.some((r) => r.startsWith('Battery')), JSON.stringify(v.rows));
  check('the first changeable row is focused, with ↔ in the hints', v.focus?.startsWith('Sidetone') && v.hint.includes('Adjust'), `${v.focus} | ${v.hint}`);
  await page.keyboard.press('ArrowRight');
  await idle(page);
  v = await view();
  check('→ raises the sidetone through the headset', v.lastCall?.[0] === 'headset_set' && v.lastCall[1].setting === ipc('headset-settings')[0] && v.lastCall[1].value === 50 && v.focus.includes('50%'), JSON.stringify(v.lastCall));
  // A held → repeats faster than a slow headset answers.
  await page.evaluate(() => {
    const s = window.__settings;
    const set = s.headset_set;
    s.headset_set = (args) => new Promise((resolve) => setTimeout(() => resolve(set(args)), 150));
  });
  const callsBefore = await page.evaluate(() => window.__calls.length);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await idle(page);
  v = await view();
  const sent = await page.evaluate(
    (n) => window.__calls.slice(n).filter((c) => c[0] === 'headset_set').map((c) => c[1].value),
    callsBefore
  );
  check('a held → waits for the headset instead of sending the same value again', JSON.stringify(sent) === '[60]' && v.focus?.includes('60%'), `${JSON.stringify(sent)} ${v.focus}`);
  // A controller's news refreshes the rows while the headset is still answering.
  const racedFrom = await page.evaluate(() => window.__calls.length);
  await page.keyboard.press('ArrowRight');
  await until(page, (n) => window.__calls.slice(n).some((c) => c[0] === 'headset_set'), racedFrom);
  await emit(page, 'accessories', null);
  await idle(page);
  v = await view();
  check("a refresh while the headset answers keeps the headset's answer", v.focus?.includes('70%'), v.focus);
  await page.keyboard.press('ArrowRight');
  await idle(page);
  const raced = await page.evaluate(
    (n) => window.__calls.slice(n).filter((c) => c[0] === 'headset_set').map((c) => c[1].value),
    racedFrom
  );
  check('the next press steps on from that answer', JSON.stringify(raced) === '[70,80]', JSON.stringify(raced));
  // Two accessory events close together, and the older refresh answers last with what it read before the change.
  await page.evaluate(() => {
    const s = window.__settings;
    const before = structuredClone(s.accessories);
    s.accessories_state = () => {
      s.accessories_state = () => s.accessories;
      return new Promise((resolve) => setTimeout(() => resolve(before), 150));
    };
    window.__emit('accessories', null);
    s.accessories.headset.battery = 75;
    window.__emit('accessories', null);
  });
  await idle(page);
  v = await view();
  check('an older refresh that answers last is dropped', v.rows.some((r) => r.startsWith('Battery') && r.includes('75%')), JSON.stringify(v.rows));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  await idle(page);
  v = await view();
  check('← steps the auto-off timer down', v.lastCall?.[1]?.setting === ipc('headset-settings')[1] && v.lastCall[1].value === 20, JSON.stringify(v.lastCall));
  await page.keyboard.press('Escape');
  v = await view();
  check('○ goes back to the sections, on the one it came from', v.title === 'Settings' && v.focus?.startsWith('Headset'), v.focus);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await idle(page);
  v = await view();
  check('✕ on a device makes it the output', v.lastCall?.[0] === 'sound_set_default' && v.lastCall[1].id === 'tv' && v.rows[0].includes('In use'), JSON.stringify(v.lastCall));
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await idle(page);
  v = await view();
  check('→ on Volume raises it by 5', v.lastCall?.[0] === 'sound_change_volume' && v.focus?.includes('50%'), `${JSON.stringify(v.lastCall)} ${v.focus}`);
  // Plugging in a controller with headphones adds an output above Volume.
  await page.evaluate((pad) => {
    window.__settings.sound.outputs.unshift(pad);
    window.__emit('accessories', null);
  }, like(device('pad', 'Headphones (DualSense Wireless Controller)', 'controller', false), { name: 'Controller headphones' }));
  await idle(page);
  v = await view();
  check('focus stays on its row when a device appears above it', v.rows[0].startsWith('Controller headphones') && v.focus?.startsWith('Volume'), `${v.rows[0]} ${v.focus}`);
  await page.screenshot({ path: path.join(shots, 'settings-sound.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  v = await view();
  check('Controllers opens on the touchpad-mouse switch', v.title === 'Controllers' && v.focus?.startsWith('Touchpad as mouse') && v.focus.endsWith('Off'), v.focus);
  await page.keyboard.press('Enter');
  await idle(page);
  v = await view();
  check('✕ switches the touchpad mouse on', v.lastCall?.[0] === 'prefs_set_touchpad_mouse' && v.focus?.endsWith('On'), `${JSON.stringify(v.lastCall)} ${v.focus}`);
  await page.keyboard.press('ArrowDown');
  v = await view();
  check('a Bluetooth controller can be turned off', v.focus === 'Turn off', JSON.stringify(v.rows));
  const headings = await page.evaluate(() => [...document.querySelectorAll('#settingsList h3')].map((h) => h.textContent));
  check(
    'an Xbox controller shows its name, connection and battery level, and nothing to turn off',
    headings[1] === 'Controller 2 · Xbox controller · Wireless' && v.rows.at(-1) === 'BatteryMedium' && v.rows.filter((r) => r === 'Turn off').length === 1,
    JSON.stringify({ headings, rows: v.rows })
  );
  await page.keyboard.press('ArrowDown');
  v = await view();
  check('↓ stays on the last row that can take focus', v.focus === 'Turn off', v.focus);
  await page.keyboard.press('Enter');
  await idle(page);
  v = await view();
  check('Turn off asks Lamplit for that controller', v.lastCall?.[0] === 'controller_turn_off' && v.lastCall[1].id === 'bt-pad' && v.toast.includes('turned off'), JSON.stringify(v.lastCall));
  await page.evaluate(() => {
    window.__settings.accessories.controllers = [];
    window.__emit('accessories', null);
    window.__emit('notice', 'Sound: TV (Living Room TV)');
  });
  await idle(page);
  v = await view();
  check('accessory news refreshes the open section', v.rows.some((r) => r.includes('No controller connected')), JSON.stringify(v.rows));
  check('Lamplit moving the sound shows a toast', v.toast === 'Sound: TV (Living Room TV)', v.toast);
  await page.keyboard.press('Escape');
  await settled(page);
  const stores = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#settingsList .row')].find((x) => x.textContent.startsWith('Stores')).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(stores.x, stores.y);
  v = await view();
  check('a mouse click opens a section', v.title === 'Stores', v.title);
  await page.keyboard.press('c');
  v = await view();
  check('△ closes the settings from inside a section', !v.open && v.hint.includes('Settings'), v.hint);
  await page.keyboard.press('Escape');
  const s = await state(page);
  check('settings: no page errors', s.errors.length === 0, JSON.stringify(s.errors));
  await close(page);
}

// 12. Store names come from the stores list, which has every store, installed or not: the starting screen says what
// a game starts through and Details names the store. The pill shows the store's key.
{
  const games = [
    game(1, { store: 'steam', requires: ['steam'] }),
    game(2, { store: null, requires: [] }),
    game(3, { store: 'epic', requires: ['epic'] }),
  ];
  const page = await open({ games });
  const [steam, ea] = ipc('stores');
  await emit(page, 'stores', [steam, like(ea, { store: 'epic', name: 'Epic Games Launcher', installed: false })]);
  const shown = () =>
    page.evaluate(() => ({
      pill: document.getElementById('store').innerText,
      note: document.getElementById('note').textContent,
      details: document.getElementById('dStore').textContent,
    }));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('i');
  let v = await shown();
  check(
    "a store app that isn't installed is named, with a warning",
    v.details === 'Epic Games Launcher' && v.note === "Epic Games Launcher isn't installed",
    JSON.stringify(v)
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('i');
  v = await shown();
  check('a store game names its store', v.pill === 'STEAM' && v.details === 'Steam', JSON.stringify(v));
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('i');
  v = await shown();
  check('a game outside any store says so', v.pill === 'PC' && v.details === 'Not from a store', JSON.stringify(v));
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  const s = await state(page);
  check('the starting screen names the store app a game starts through', s.overlaySub === 'Through Steam', s.overlaySub);
  await close(page);
}

// 13. Signing in during a launch: the starting screen points at the store app that waits, newest first.
{
  const page = await open({ games: [game(1), game(2)] });
  await emit(page, 'stores', ipc('stores')); // Steam and the EA app
  await page.keyboard.press('Enter');
  await idle(page);
  const steps = () => page.evaluate(() => [...document.querySelectorAll('#steps li')].map((li) => `${li.className} ${li.textContent}`));
  await emit(page, 'launch-step', step({ id: 'pc:1', key: 'store:ea', state: 'block', label: 'Sign in to EA app', store: 'ea' }));
  let s = await state(page);
  check('a sign-in to do names its store app and offers Try anyway', s.hint.includes('Open EA app') && s.hint.includes('Try anyway'), s.hint);
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('✕ opens the store app that waits', s.lastCall?.[0] === 'launch_show' && s.lastCall[1].store === 'ea', JSON.stringify(s.lastCall));
  await page.keyboard.press('c');
  await idle(page);
  s = await state(page);
  check('△ goes ahead without a confirmed sign-in', s.lastCall?.[0] === 'launch_anyway', JSON.stringify(s.lastCall));
  await emit(page, 'launch-step', step({ id: 'pc:1', key: 'hint', state: 'warn', label: 'Still waiting: Steam may need you', store: 'steam' }));
  s = await state(page);
  check('a newer warning names its own store app, without Try anyway', s.hint.includes('Open Steam') && !s.hint.includes('Try anyway'), s.hint);
  const before = s.calls.length;
  await page.keyboard.press('c');
  await idle(page);
  s = await state(page);
  check('△ does nothing on a warning', s.calls.length === before, JSON.stringify(s.calls.slice(before)));
  const lines = await steps();
  await emit(page, 'launch-step', step({ id: 'pc:2', key: 'store:steam', state: 'busy', label: 'Checking Steam', store: 'steam' }));
  const after = await steps();
  check("another game's steps stay off this starting screen", lines.length === 2 && JSON.stringify(after) === JSON.stringify(lines), JSON.stringify(after));
  await close(page);
}

// 14. A game that runs: the PS button brings it into focus, a restart stops it counting as running, and an older
// launch's failure leaves the one on screen alone.
{
  const page = await open({ games: [game(1), game(2), game(3)] });
  await page.keyboard.press('Enter');
  await running(page, 'pc:1');
  await page.keyboard.press('ArrowRight');
  await emit(page, 'summoned', 'pc:1');
  let s = await state(page);
  check('the PS button brings focus to the running game', s.focusName === 'Game 001', s.focusName);
  await emit(page, 'play', play('starting', 'pc:1'));
  await page.keyboard.press('Escape');
  s = await state(page);
  check('a game that closed to restart no longer counts as running', s.hint.includes('Play') && !s.hint.includes('Back to game'), s.hint);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await emit(page, 'play', play('failed', 'pc:1'));
  s = await state(page);
  check("another game's failure leaves this launch on screen", s.overlay && s.overlayTitle.includes('Game 002') && !s.toast, `${s.overlayTitle} ${s.toast}`);
  await close(page);
}

// 15. A new list of games: focus stays on its game, and Details close when their game is gone.
{
  const page = await open({ games: [game(1), game(2), game(3)] });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await emit(page, 'games', [game(1), game(9, { name: 'New Install' }), game(2), game(3)]);
  let s = await state(page);
  check('a game added in front of the focused one leaves focus on it', s.focusName === 'Game 003', s.focusName);
  await page.keyboard.press('i');
  await emit(page, 'games', [game(1), game(2)]);
  s = await state(page);
  check('Details close when their game leaves the list', !s.details, `${s.details} ${s.focusName}`);
  await page.keyboard.press('i');
  await emit(page, 'games', []);
  s = await state(page);
  check('an empty list closes Details too', !s.details && s.errors.length === 0, JSON.stringify(s.errors));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  s = await state(page);
  const atOnce = s.lastCall?.[0] === 'library_rescan';
  await until(page, () => window.__calls.at(-1)?.[0] === 'library_rescan');
  s = await state(page);
  check('coming forward looks for new installs, once the way in has played', !atOnce && s.lastCall?.[0] === 'library_rescan', `${atOnce} ${JSON.stringify(s.lastCall)}`);
  await close(page);
}

// 16. Every switch in Settings: each calls its command with the new value and shows what that answers.
{
  const page = await open({ games: [game(1)] });
  await page.evaluate((data) => {
    const s = (window.__settings = { ...data, stores_status: data.stores, display_mode: '1920 × 1080 at 60 Hz' });
    for (const [cmd, key] of [['sound_state', 'sound'], ['accessories_state', 'accessories'], ['prefs_state', 'prefs'], ['quiet_state', 'quiet'], ['overlay_state', 'overlays'], ['setup_state', 'setup']]) {
      s[cmd] = () => s[key];
    }
    s.sound_set_mute = ({ mic, muted }) => {
      s.sound[mic ? 'mic_muted' : 'muted'] = muted;
    };
    // NVIDIA's log said nothing within 2 s: what a page that flips its own value would never show.
    s.overlay_toggle_stats = () => null;
    s.quiet_set = ({ on }) => (s.quiet = { state: on ? 'on' : 'off', active: on, notes: on ? [] : ['Close Ubisoft Connect so Lamplit can restore its settings.'] });
    for (const pref of ['sound_follows', 'steam_devtools', 'online_art']) {
      s[`prefs_set_${pref}`] = ({ on }) => ((s.prefs[pref] = on), s.prefs);
    }
  }, { sound: ipc('sound'), accessories: ipc('accessories'), prefs: ipc('prefs'), quiet: ipc('quiet'), overlays: ipc('overlays'), setup: ipc('setup'), stores: ipc('stores') });
  const view = () =>
    page.evaluate(() => ({
      rows: [...document.querySelectorAll('#settingsList .row')].map((r) => r.textContent),
      focus: document.querySelector('#settingsList .row.focus')?.textContent ?? null,
      toast: [...document.querySelectorAll('#toast.on, #gameNews.on')].map((t) => t.textContent).join(' | '),
      calls: window.__calls,
    }));
  /** Moves focus to the row that starts with `label` and presses ✕ on it; returns the commands that sent. */
  const press = async (label) => {
    for (let i = 0; i < 20; i++) {
      const v = await view();
      if (v.focus?.startsWith(label)) break;
      const at = v.rows.findIndex((r) => r === v.focus), want = v.rows.findIndex((r) => r.startsWith(label));
      if (want < 0) throw new Error(`no row ${label} in ${JSON.stringify(v.rows)}`);
      await page.keyboard.press(want > at ? 'ArrowDown' : 'ArrowUp');
    }
    const before = (await view()).calls.length;
    await page.keyboard.press('Enter');
    await idle(page);
    return (await view()).calls.slice(before);
  };
  const section = async (title) => {
    await page.keyboard.press('Escape');
    return press(title);
  };
  await page.keyboard.press('c');
  await idle(page);
  await press('Sound');
  let sent = await press('Mute');
  let v = await view();
  check('Mute sends the new value and shows it', JSON.stringify(sent[0]) === '["sound_set_mute",{"mic":false,"muted":true}]' && v.focus === 'MuteOn', `${JSON.stringify(sent)} ${v.focus}`);
  sent = await press('Sound follows');
  v = await view();
  check('Sound follows switches off', JSON.stringify(sent[0]) === '["prefs_set_sound_follows",{"on":false}]' && v.focus?.endsWith('Off'), `${JSON.stringify(sent)} ${v.focus}`);
  await section('Overlay and pop-ups');
  sent = await press('Performance stats');
  v = await view();
  check('the stats switch shows what NVIDIA answered', sent[0]?.[0] === 'overlay_toggle_stats' && v.focus?.endsWith('Unknown'), `${JSON.stringify(sent)} ${v.focus}`);
  // NVIDIA answers slowly; a second press meanwhile would switch the stats back.
  await page.evaluate(() => {
    window.__settings.overlay_toggle_stats = () => new Promise((resolve) => setTimeout(() => resolve(true), 150));
  });
  const togglesFrom = (await view()).calls.length;
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await idle(page);
  v = await view();
  const toggles = v.calls.slice(togglesFrom).filter((c) => c[0] === 'overlay_toggle_stats').length;
  check('a second press waits for NVIDIA instead of switching the stats back', toggles === 1 && v.focus?.endsWith('On'), `${toggles} ${v.focus}`);
  sent = await press('Quiet mode');
  v = await view();
  check('Quiet mode switches off while it is on, and says what had to wait', JSON.stringify(sent[0]) === '["quiet_set",{"on":false}]' && v.focus?.endsWith('Off') && v.toast.includes('Ubisoft'), `${JSON.stringify(sent)} ${v.focus} ${v.toast}`);
  await section('Stores');
  sent = await press('EA app');
  check('a store row opens that store app', JSON.stringify(sent[0]) === '["stores_open",{"store":"ea"}]', JSON.stringify(sent));
  // Rust refuses the first time (Steam's folder can't be written): the row shows what Rust holds, read again.
  await page.evaluate((error) => {
    const s = window.__settings;
    const works = s.prefs_set_steam_devtools;
    s.prefs_set_steam_devtools = () => {
      s.prefs_set_steam_devtools = works;
      throw error;
    };
  }, like(ipc('error'), { message: 'Access is denied. (os error 5)' }));
  sent = await press('Open it');
  v = await view();
  check(
    "a refused DevTools switch stays Off, as Rust's prefs say",
    sent[0]?.[0] === 'prefs_set_steam_devtools' && sent.some((c) => c[0] === 'prefs_state') && v.focus?.endsWith('Off') && v.toast.includes('denied'),
    `${JSON.stringify(sent)} ${v.focus} ${v.toast}`
  );
  sent = await press('Open it');
  v = await view();
  check("Steam's DevTools port switches on and says when", JSON.stringify(sent[0]) === '["prefs_set_steam_devtools",{"on":true}]' && v.focus?.endsWith('On') && v.toast.includes('next starts'), `${JSON.stringify(sent)} ${v.focus} ${v.toast}`);
  await section('System');
  sent = await press('Find art online');
  v = await view();
  check('Find art online switches off', JSON.stringify(sent[0]) === '["prefs_set_online_art",{"on":false}]' && v.focus?.endsWith('Off'), `${JSON.stringify(sent)} ${v.focus}`);
  sent = await press('First-time setup');
  v = await view();
  check('setup asks for the Windows prompt', sent[0]?.[0] === 'setup_start' && v.toast.includes('Windows prompt'), `${JSON.stringify(sent)} ${v.toast}`);
  await page.evaluate((setup) => {
    window.__settings.setup = setup;
    window.__emit('setup', setup);
    window.__emit('notice', 'Setup is done.');
  }, like(ipc('setup'), { needed: false }));
  v = await view();
  check('setup that ended takes its row away and says so', !v.rows.some((r) => r.startsWith('First-time setup')) && v.toast === 'Setup is done.', `${JSON.stringify(v.rows)} ${v.toast}`);
  await close(page);
}

// 17. Every step state Rust sends has its own look on the starting screen.
{
  const page = await open({ games: [game(1)] });
  await page.keyboard.press('Enter');
  await idle(page);
  for (const state of values.step_state) {
    await emit(page, 'launch-step', step({ id: 'pc:1', key: state, state, label: state, store: null }));
  }
  const icons = await page.evaluate(() =>
    [...document.querySelectorAll('#steps li')].map((li) => {
      const look = getComputedStyle(li.querySelector('.icon'));
      return { state: li.className, styled: look.backgroundColor !== 'rgba(0, 0, 0, 0)' || look.animationName !== 'none' };
    })
  );
  check('every step state has its icon', icons.length === values.step_state.length && icons.every((i) => i.styled), JSON.stringify(icons));
  await close(page);
}

// 18. Every pad step Rust sends does what it should in the cover row, each from where the one before left off.
{
  const page = await open({ games: Array.from({ length: 12 }, (_, i) => game(i + 1)) });
  const seen = () =>
    page.evaluate(() => ({
      focus: [...document.querySelectorAll('#track .cover')].findIndex((c) => c.classList.contains('focus')),
      details: document.getElementById('details').classList.contains('on'),
      settings: document.getElementById('settings').classList.contains('on'),
      // On, and not on its way back into the filter line.
      find: document.getElementById('find').matches('.on:not(.going)'),
      overlay: document.getElementById('overlay').classList.contains('on'),
      calls: window.__calls.map((c) => c[0]),
    }));
  const browsing = (v, focus) => v.focus === focus && !v.details && !v.settings && !v.find && !v.overlay;
  /** [step, what it does, whether that held, given the number of calls before the step] */
  const steps = [
    ['right', 'moves to the next game', (v) => browsing(v, 1)],
    ['r1', 'jumps five games on', (v) => browsing(v, 6)],
    ['l1', 'jumps five games back', (v) => browsing(v, 1)],
    ['left', 'moves to the game before', (v) => browsing(v, 0)],
    ['up', 'does nothing in the row', (v, calls) => browsing(v, 0) && v.calls.length === calls],
    ['down', 'does nothing in the row', (v, calls) => browsing(v, 0) && v.calls.length === calls],
    ['back', 'does nothing while no game runs', (v, calls) => browsing(v, 0) && v.calls.length === calls],
    ['menu', 'opens Details', (v) => v.details],
    ['back', 'closes Details', (v) => browsing(v, 0)],
    ['triangle', 'opens Settings', (v) => v.settings],
    ['triangle', 'closes Settings', (v) => browsing(v, 0)],
    ['square', 'opens Find', (v) => v.find],
    ['back', 'closes Find', (v, calls) => browsing(v, 0) && v.calls.length === calls],
    ['ok', 'starts the focused game', (v) => v.overlay && v.calls.at(-1) === 'launch_start'],
    ['back', 'cancels the start', (v) => browsing(v, 0) && v.calls.at(-1) === 'launch_cancel'],
  ];
  for (const [step, what, held] of steps) {
    const calls = (await seen()).calls.length;
    await emit(page, 'pad', step);
    await idle(page);
    const v = await seen();
    check(`pad ${step} ${what}`, held(v, calls), JSON.stringify({ ...v, calls: v.calls.slice(calls) }));
  }
  const untried = values.pad.filter((p) => !steps.some(([step]) => step === p));
  check('every pad step Rust sends is tried', untried.length === 0, untried.join(', '));
  await close(page);
}

// 19. The page opens while a game runs (after a reload, say): that game counts as running.
{
  const page = await open({ games: [game(1), game(2), game(3)], running: 'pc:2' });
  const playing = await page.evaluate(() => [...document.querySelectorAll('#track .cover.playing .name')].map((n) => n.textContent));
  check('a game that runs when the page opens shows as Playing', JSON.stringify(playing) === '["Game 002"]', JSON.stringify(playing));
  let s = await state(page);
  check('another game offers ○ Back to game', s.focusName === 'Game 001' && s.hint.includes('○Back to game'), `${s.focusName} ${s.hint}`);
  await page.keyboard.press('Escape');
  await resumed(page);
  s = await state(page);
  check('○ in the row goes back to the running game', s.lastCall?.[0] === 'launch_resume', JSON.stringify(s.lastCall));
  await close(page);
}

// 20. Play time on the home screen and in Details; favourites and hidden games from Details, shown again from
// Settings.
{
  const games = [game(1), game(2), game(3, { play_minutes: 754 }), game(4)];
  const page = await open({ games });
  await page.evaluate((list) => {
    const s = (window.__settings = { list });
    /** Rust's answer: every game, with the change. */
    const set = (flag) => ({ id, on }) => {
      s.list.find((g) => g.id === id)[flag] = on;
      return s.list;
    };
    s.library_set_favourite = set('favourite');
    s.library_set_hidden = set('hidden');
  }, games);
  const details = () =>
    page.evaluate(() => ({
      choices: [...document.querySelectorAll('#dChoices .row')].map((r) => r.textContent),
      focus: document.querySelector('#dChoices .row.focus')?.textContent ?? null,
      pressed: document.querySelector('#dChoices .row.focus')?.getAttribute('aria-pressed') ?? null,
      time: document.getElementById('dTime').textContent,
      line: document.getElementById('dMeta').innerText.replace(/\s+/g, ' '),
      meta: document.getElementById('meta').innerText.replace(/\s+/g, ' '),
    }));
  await page.keyboard.press('i');
  let d = await details();
  check('a game Lamplit never saw run has no play time', d.time === '' && /^[^·]+ · Not played yet$/.test(d.line) && !d.meta.includes('played'), JSON.stringify(d));
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  d = await details();
  check('the home screen shows whole hours played', d.meta.endsWith('12 h played'), d.meta);
  await page.keyboard.press('i');
  d = await details();
  let s = await state(page);
  check('the menu has one line under the name: store, last played and hours played', d.time === '12 h' && /^[^·]+ · (Played|Not played)[^·]+ · 12 h$/.test(d.line), JSON.stringify(d));
  check('Details open on Play, with the other choices below', d.focus === 'Play' && JSON.stringify(d.choices) === '["Play","Favourite","Change art","Hide this game"]' && s.hint.includes('✕Play'), `${JSON.stringify(d)} ${s.hint}`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await idle(page);
  d = await details();
  s = await state(page);
  check('✕ on Favourite asks Rust', JSON.stringify(s.lastCall) === '["library_set_favourite",{"id":"pc:3","on":true}]', JSON.stringify(s.lastCall));
  check('a favourite moves to the front and keeps focus, Details open', s.details && s.focusIndex === 0 && s.focusName === 'Game 003' && d.focus === 'Favourite' && d.pressed === 'true', `${s.focusIndex} ${s.focusName} ${d.focus}`);
  check('Details hint Select on a choice other than Play', s.hint.includes('✕Select'), s.hint);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('i');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  d = await details();
  check('Details stop at the last choice', d.focus === 'Hide this game', d.focus);
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('✕ on Hide this game asks Rust', JSON.stringify(s.lastCall) === '["library_set_hidden",{"id":"pc:1","on":true}]', JSON.stringify(s.lastCall));
  check('a hidden game leaves the row, and focus stays in its place', !s.details && s.covers === 3 && s.focusIndex === 1 && s.focusName === 'Game 002', `${s.covers} ${s.focusIndex} ${s.focusName}`);
  check('hiding says where to find the game again', s.toast.includes('Settings > Hidden games'), s.toast);
  // A click on a choice picks it, as ✕ would.
  await page.keyboard.press('i');
  await settled(page);
  const second = await page.evaluate(() => {
    const r = document.querySelectorAll('#dChoices .row')[1].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(second.x, second.y);
  await idle(page);
  s = await state(page);
  check('a click on a choice in Details picks it', JSON.stringify(s.lastCall) === '["library_set_favourite",{"id":"pc:2","on":true}]', JSON.stringify(s.lastCall));
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await idle(page);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#settingsList .row')].map((r) => r.textContent));
  let list = await rows();
  check('Settings list the hidden games', list.includes('Hidden games1 game'), JSON.stringify(list));
  for (let i = 0; i < list.indexOf('Hidden games1 game'); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  list = await rows();
  check('Hidden games names each one', JSON.stringify(list) === '["Game 001Show"]', JSON.stringify(list));
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  list = await rows();
  check('✕ shows a hidden game again', JSON.stringify(s.lastCall) === '["library_set_hidden",{"id":"pc:1","on":false}]' && s.covers === 4 && s.toast === 'Game 001 is back in the row.', `${JSON.stringify(s.lastCall)} ${s.covers} ${s.toast}`);
  check('the section says when none is left', JSON.stringify(list) === '["No hidden games"]', JSON.stringify(list));
  await page.keyboard.press('c');
  await emit(page, 'games', games.map((g) => ({ ...g, hidden: true })));
  s = await state(page);
  check('every game hidden says how to show them again', s.empty.startsWith('Every game is hidden') && s.hint.includes('Settings'), `${s.empty} | ${s.hint}`);
  await page.keyboard.press('c');
  list = await rows();
  check('Settings open with no game in the row', list.some((r) => r.startsWith('Hidden games4 games')), JSON.stringify(list));
  await close(page);
}

// 21. Settings > Power: Sleep at one press; Restart and Shut down once Cross is held, which they say before the press,
// naming a running game that will close. Let go early, nothing happens; a held key's repeat, a mirrored Enter and a
// click on the cover don't finish a hold.
{
  const page = await open({ games: [game(1), game(2, { name: 'Racer' })], running: 'pc:2' });
  await page.evaluate(() => (window.__settings = {}));
  const view = () =>
    page.evaluate(() => ({
      open: document.getElementById('settings').classList.contains('on'),
      rows: [...document.querySelectorAll('#settingsList .row')].map((r) => r.querySelector('.label').firstChild.textContent),
      notes: [...document.querySelectorAll('#settingsList .row')].map((r) => r.querySelector('.note')?.textContent ?? ''),
      focus: document.querySelector('#settingsList .row.focus .label')?.firstChild.textContent ?? null,
      holding: !!document.querySelector('#settingsList .row.focus.holding'),
      hint: document.getElementById('hint').textContent,
      toast: [...document.querySelectorAll('#toast.on, #gameNews.on')].map((t) => t.textContent).join(' | '),
      calls: window.__calls.map((c) => c[0]),
    }));
  // Keys, until the controller has been used: keys right after it are taken for Steam mirroring it (logic.js counts).
  let pad = false;
  const press = (key, step) => (pad ? emit(page, 'pad', step) : page.keyboard.press(key));
  const powerSection = async () => {
    await press('c', 'triangle');
    await idle(page);
    for (let i = 0; i < 10; i++) await press('ArrowDown', 'down');
    await press('Enter', 'ok');
  };
  await powerSection();
  let v = await view();
  check('Power offers sleep, restart and shut down', JSON.stringify(v.rows) === '["Sleep","Restart","Shut down"]' && v.focus === 'Sleep', JSON.stringify(v.rows));
  check('... restart and shut down say before the press that the running game will close', JSON.stringify(v.notes) === '["","Racer is running and will close","Racer is running and will close"]', JSON.stringify(v.notes));
  await page.keyboard.press('ArrowDown');
  v = await view();
  check('... and the hint says to hold', v.hint.includes('Hold to restart'), v.hint);
  await page.keyboard.down('Enter');
  await page.waitForTimeout(300);
  v = await view();
  const early = v.calls.length;
  check('holding Enter on Restart fills its ring, and sends nothing yet', v.holding && !v.calls.includes('power_restart'), JSON.stringify(v));
  await page.keyboard.up('Enter');
  await page.waitForTimeout(900);
  v = await view();
  check('... let go early, nothing happens', !v.holding && !v.calls.slice(early).includes('power_restart') && v.open, JSON.stringify(v.calls.slice(early)));
  await page.keyboard.down('Enter');
  // A held key repeats: the repeat starts no new hold, and the hold goes on.
  await page.keyboard.down('Enter');
  await until(page, () => window.__calls.some((c) => c[0] === 'power_restart'));
  await page.keyboard.up('Enter');
  await idle(page);
  v = await view();
  check('held to the end, it restarts, from the home screen', v.calls.at(-1) === 'power_restart' && !v.open, `${v.calls.at(-1)} ${v.open}`);
  await page.evaluate((error) => {
    window.__settings.power_shut_down = () => {
      throw error;
    };
  }, like(ipc('error'), { message: "Windows didn't shut down. Another Windows account is signed in on this PC: sign it out first." }));
  pad = true;
  await powerSection();
  await press('ArrowDown', 'down');
  await press('ArrowDown', 'down');
  await emit(page, 'pad', 'ok');
  await until(page, () => window.__calls.some((c) => c[0] === 'power_shut_down'));
  await emit(page, 'pad', 'ok-up');
  await idle(page);
  v = await view();
  check('a shutdown Windows refuses says why', v.calls.at(-1) === 'power_shut_down' && v.toast.startsWith("Windows didn't shut down."), `${v.calls.at(-1)} ${v.toast}`);
  await powerSection();
  await press('Enter', 'ok');
  await idle(page);
  v = await view();
  check('one press on Sleep puts the PC to sleep: any button wakes it', v.calls.at(-1) === 'power_sleep' && !v.open, `${v.calls.at(-1)} ${v.open}`);
  // The controller's Cross let go ends a hold too, as Enter's does.
  await powerSection();
  await press('ArrowDown', 'down');
  const fresh = (await view()).calls.length;
  await emit(page, 'pad', 'ok');
  await page.waitForTimeout(300);
  await emit(page, 'pad', 'ok-up');
  await page.waitForTimeout(900);
  v = await view();
  check("Cross let go before the ring is full doesn't restart", !v.calls.slice(fresh).includes('power_restart') && !v.holding, JSON.stringify(v.calls.slice(fresh)));
  // Moving off the row lets go too.
  await emit(page, 'pad', 'ok');
  await page.waitForTimeout(200);
  await emit(page, 'pad', 'up');
  await page.waitForTimeout(1000);
  v = await view();
  check('moving off a held row lets go', !v.calls.slice(fresh).includes('power_restart') && v.focus === 'Sleep', JSON.stringify(v.calls.slice(fresh)));
  // The focused cover still shows beside Settings: a click on it mustn't start or finish anything.
  await page.click('#track .cover.focus');
  await idle(page);
  v = await view();
  check("a click on the focused cover doesn't act on a Power row", v.open && !v.calls.slice(fresh).some((c) => c.startsWith('power_')), `${v.open} ${JSON.stringify(v.calls.slice(fresh))}`);
  await close(page);
}

// 23. The running game hidden as the last game in the row: Circle still goes back to it.
{
  const page = await open({ games: [game(1)], running: 'pc:1' });
  await page.evaluate((g) => {
    window.__settings = { library_set_hidden: ({ on }) => [{ ...g, hidden: on }] };
  }, game(1));
  await page.keyboard.press('i');
  let s = await state(page);
  check('Details of the running game offer Back to game', s.hint.includes('✕Back to game'), s.hint);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('with every game hidden, the hints still offer the running game', s.covers === 0 && s.hint.includes('○Back to game'), `${s.covers} ${s.hint}`);
  await page.keyboard.press('Escape');
  await resumed(page);
  s = await state(page);
  check('○ goes back to a running game that is hidden', s.lastCall?.[0] === 'launch_resume', JSON.stringify(s.lastCall));
  await close(page);
}

// 22. A game that ends moves to the front of the games that aren't favourites; the favourites stay in front of it.
{
  const page = await open({ games: [game(1, { favourite: true }), game(2), game(3)] });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await running(page, 'pc:3');
  await emit(page, 'play', play('ended', 'pc:3'));
  const order = await page.evaluate(() => [...document.querySelectorAll('#track .cover')].map((c) => c.textContent));
  const s = await state(page);
  check('the favourite stays first when another game ends', JSON.stringify(order) === '["Game 001Playing","Game 003Playing","Game 002Playing"]' && s.focusName === 'Game 003', `${JSON.stringify(order)} ${s.focusName}`);
  await close(page);
}

// 24. Find a game: the on-screen keyboard narrows the row as it types, the store chip's list and the sort chip order
// it, and ○ brings every game back. With a controller, the mouse and the keyboard.
const findView = (page) =>
  page.evaluate(() => ({
    open: document.getElementById('find').classList.contains('on') && !document.getElementById('find').classList.contains('going'),
    query: document.getElementById('findQuery').textContent,
    focus: /** @type {HTMLElement} */ (document.querySelector('#find .focus'))?.dataset.id ?? null,
    row: [...document.querySelectorAll('#track .cover .name')].map((n) => n.textContent),
    focused: document.querySelector('#track .cover.focus .name')?.textContent ?? null,
    filters: document.getElementById('filters').textContent,
    stores: [...document.querySelectorAll('#findStores .choice')].map((c) => c.textContent),
    chosen: [...document.querySelectorAll('#find .choice.on')].map((c) => /** @type {HTMLElement} */ (c).dataset.id),
    list: document.getElementById('findStores').classList.contains('on') && !document.getElementById('findStores').classList.contains('going'),
    store: document.getElementById('findStore').textContent,
    sort: document.getElementById('findSort').textContent,
    count: document.getElementById('findCount').textContent,
    noMatch: !document.getElementById('noMatch').hidden,
    info: !document.getElementById('info').classList.contains('off'),
    hint: document.getElementById('hint').textContent,
    settings: document.getElementById('settings').classList.contains('on'),
    details: document.getElementById('details').classList.contains('on'),
    calls: window.__calls.length,
    lastCall: window.__calls.at(-1),
  }));
{
  /** [name, store, days since last played] */
  const named = [
    ['Red Dead Redemption 2', 'rockstar', 2],
    ['Cyberpunk 2077', 'epic', 1],
    ['Titanfall 2', 'steam', 3],
    ['Portal 2', 'steam', null],
    ["Tom Clancy's Ghost Recon Wildlands", 'ubisoft', null],
    ['Loose Game', null, null],
  ];
  const now = Math.floor(Date.now() / 1000);
  const games = named.map(([name, store, days], i) =>
    game(i + 1, { name, store, requires: store ? [store] : [], last_played: days == null ? 0 : now - days * 86400 })
  );
  const page = await open({ games });
  const seen = () => findView(page);
  const pad = async (...steps) => {
    for (const s of steps) await emit(page, 'pad', s);
  };
  /** Moves focus with the d-pad to the key, chip or store `id`, a row at a time, then presses ✕ on it. */
  const pick = async (id) => {
    for (let i = 0; i < 30; i++) {
      const way = await page.evaluate((id) => {
        const from = document.querySelector('#find .focus').getBoundingClientRect();
        const to = document.querySelector(`#find [data-id="${id}"]`).getBoundingClientRect();
        if (Math.abs(to.y - from.y) > 2) return to.y > from.y ? 'down' : 'up';
        return Math.abs(to.x - from.x) > 2 ? (to.x > from.x ? 'right' : 'left') : null;
      }, id);
      if (!way) break;
      await pad(way);
    }
    await pad('ok');
  };
  const all = named.map(([name]) => name);

  await pad('square');
  let v = await seen();
  check('□ opens Find on the keyboard', v.open && v.focus === 'a' && ['✕Select', '□Delete', '△Space', '○Done'].every((h) => v.hint.includes(h)), `${v.focus} ${v.hint}`);
  for (const key of 'rdr') await pick(key);
  v = await seen();
  check('the d-pad types, and the row keeps only what matches', v.query === 'rdr' && JSON.stringify(v.row) === '["Red Dead Redemption 2"]' && v.focused === 'Red Dead Redemption 2', `${v.query} ${JSON.stringify(v.row)}`);
  check('the home screen says what narrows the row', v.filters.includes('rdr') && v.filters.includes('1 of 6 games'), v.filters);
  await page.screenshot({ path: path.join(shots, 'find.png') });
  await pad('square');
  v = await seen();
  check('□ deletes a letter', v.query === 'rd' && v.row.length === 1, `${v.query} ${JSON.stringify(v.row)}`);
  await pad('square', 'square');
  v = await seen();
  check('an empty search shows every game again, in the usual order', v.query === '' && JSON.stringify(v.row) === JSON.stringify(['Cyberpunk 2077', 'Red Dead Redemption 2', 'Titanfall 2', 'Loose Game', 'Portal 2', "Tom Clancy's Ghost Recon Wildlands"]) && v.filters === '', `${JSON.stringify(v.row)} ${v.filters}`);
  const before = v.calls;
  await pad('triangle', 'square');
  v = await seen();
  check('△ adds no space to an empty search, and □ has nothing to delete', v.query === '' && v.calls === before, v.query);
  // The mouse: a click types the key it lands on.
  for (const key of ['r', 'e', 'd', 'space', 'd', 'e', 'a']) await page.click(`#find [data-id="${key}"]`);
  v = await seen();
  check('a click types a key, and Space goes between words', v.query === 'red dea' && JSON.stringify(v.row) === '["Red Dead Redemption 2"]', `${v.query} ${JSON.stringify(v.row)}`);
  await pick('clear');
  v = await seen();
  check('Clear empties the search', v.query === '' && v.row.length === 6, `${v.query} ${v.row.length}`);
  await pick('store');
  v = await seen();
  check(
    "✕ on the store chip opens its list on the store chosen now, with its hints",
    v.list && v.focus === 'store:all' && v.hint === '✕Select○Back' && v.store === 'All stores',
    `${v.list} ${v.focus} ${v.hint}`
  );
  await pad('back');
  v = await seen();
  check('○ closes only the list, with focus on its chip', v.open && !v.list && v.focus === 'store', `${v.open} ${v.list} ${v.focus}`);
  await pick('store');
  await pick('store:steam');
  v = await seen();
  check('the store choices: All stores, then the stores with games, games outside any store last as PC', JSON.stringify(v.stores) === '["All stores","steam","epic","ubisoft","rockstar","PC"]', JSON.stringify(v.stores));
  check(
    'a store keeps its own games, the list closes and the chip names the store',
    JSON.stringify(v.row) === '["Titanfall 2","Portal 2"]' && v.chosen.includes('store:steam') && !v.list && v.focus === 'store' && v.store === 'steam',
    `${JSON.stringify(v.row)} ${v.chosen} ${v.list} ${v.store}`
  );
  check("the count stands on Find's line beside the chips", v.count === '2 of 6 games', v.count);
  await pick('sort');
  v = await seen();
  check('✕ on the sort chip sorts the row A to Z', JSON.stringify(v.row) === '["Portal 2","Titanfall 2"]' && v.sort === 'A to Z' && v.focus === 'sort', `${JSON.stringify(v.row)} ${v.sort}`);
  await page.screenshot({ path: path.join(shots, 'find-choices.png') });
  await pad('back');
  v = await seen();
  check('○ closes Find and the row stays narrowed, with ○ All games', !v.open && v.row.length === 2 && v.hint.includes('○All games') && v.hint.includes('□Find') && /steam.*A to Z.*2 of 6 games/.test(v.filters), `${v.hint} | ${v.filters}`);
  await page.screenshot({ path: path.join(shots, 'find-narrowed.png') });
  await pad('ok');
  v = await seen();
  check('✕ starts the game focused in the narrowed row', v.lastCall?.[0] === 'launch_start' && v.lastCall[1].id === 'pc:4', JSON.stringify(v.lastCall));
  await pad('back', 'right');
  v = await seen();
  check('the narrowed row moves as the full one does', v.focused === 'Titanfall 2', v.focused);
  await pad('back');
  v = await seen();
  check('○ brings every game back, on the same game and in the same sort', v.row.length === 6 && v.focused === 'Titanfall 2' && JSON.stringify(v.row) === JSON.stringify([...all].sort()) && v.filters === 'A to Z' && !v.hint.includes('All games'), `${v.focused} ${JSON.stringify(v.row)} ${v.filters} ${v.hint}`);

  // A search that matches nothing leaves an empty row that still answers □ and ○.
  await pad('square');
  for (const key of 'zq') await pick(key);
  await pad('back');
  v = await seen();
  check('no match says so, with nothing focused', v.noMatch && v.row.length === 0 && !v.info && v.filters.includes('0 of 6 games'), `${v.noMatch} ${v.info} ${v.filters}`);
  check('an empty row offers △ Settings, □ Find and ○ All games', v.hint === '△Settings□Find○All games', v.hint);
  const calls = v.calls;
  await pad('ok', 'menu', 'right');
  v = await seen();
  check('an empty row ignores ✕, Options and moves', v.calls === calls && v.row.length === 0, JSON.stringify(v.lastCall));
  await page.screenshot({ path: path.join(shots, 'find-no-match.png') });
  await pad('back');
  v = await seen();
  check('○ on an empty row brings every game back', v.row.length === 6 && !v.noMatch && v.info, `${v.row.length} ${v.noMatch}`);

  // A game the filter hides comes into view when Lamplit points at it: when it ends, and when PS is held.
  await pad('square');
  await pick('sort');
  await pick('store');
  await pick('store:steam');
  await pad('back');
  await running(page, 'pc:2');
  await emit(page, 'play', play('ended', 'pc:2'));
  v = await seen();
  check('a game the store filter hides gets focus when it ends, with every game back', v.focused === 'Cyberpunk 2077' && v.row.length === 6 && v.filters === '', `${v.focused} ${v.filters}`);
  await running(page, 'pc:1');
  await pad('square');
  for (const key of 'portal') await pick(key);
  await emit(page, 'summoned', 'pc:1');
  v = await seen();
  check('holding PS closes Find and brings the running game into view', !v.open && v.focused === 'Red Dead Redemption 2' && v.row.length === 6 && v.hint.includes('Back to game'), `${v.open} ${v.focused} ${v.hint}`);
  await close(page);
}
{
  // The keyboard: F opens Find, and there every character types, also I, C and Backspace, which act elsewhere.
  const page = await open({ games: [game(1, { name: 'Portal 2' }), game(2, { name: 'Red Dead Redemption 2' }), game(3, { name: 'Celeste' })] });
  await page.keyboard.press('f');
  let v = await findView(page);
  check('F opens Find', v.open && v.focus === 'a', `${v.open} ${v.focus}`);
  await page.keyboard.type('Red ic');
  v = await findView(page);
  check('I and C type in Find', v.open && v.query === 'Red ic' && !v.details && !v.settings, v.query);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('d');
  v = await findView(page);
  check('Backspace deletes in Find, and typing moves focus to Done', v.open && v.query === 'Red d' && v.focus === 'done' && JSON.stringify(v.row) === '["Red Dead Redemption 2"]', `${v.query} ${v.focus}`);
  await page.keyboard.press('Enter');
  v = await findView(page);
  check('Enter after typing closes Find on its results', !v.open && v.focused === 'Red Dead Redemption 2' && v.row.length === 1, `${v.open} ${v.focused}`);
  await page.keyboard.press('Escape');
  v = await findView(page);
  check('Esc on the narrowed row brings every game back', v.row.length === 3 && v.focused === 'Red Dead Redemption 2', `${v.row.length} ${v.focused}`);
  await page.keyboard.press('f');
  await page.keyboard.type('cel');
  const cover = await page.evaluate(() => {
    const r = document.querySelector('#track .cover.focus').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(cover.x, cover.y);
  v = await findView(page);
  check('a click on the focused result closes Find and plays it', !v.open && v.lastCall?.[0] === 'launch_start' && v.lastCall[1].id === 'pc:3', JSON.stringify(v.lastCall));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await page.click('#findStore');
  v = await findView(page);
  check('a click on the store chip opens its list', v.list && v.focus === 'store:all', `${v.list} ${v.focus}`);
  await page.click('#find [data-id="store:all"]');
  v = await findView(page);
  check('a click on the store already chosen closes the list, with focus on its chip', !v.list && v.focus === 'store' && v.chosen.includes('store:all'), `${v.list} ${v.focus}`);
  await page.keyboard.press('Backspace');
  v = await findView(page);
  check('Backspace on an empty search moves focus to Done too', v.open && v.focus === 'done' && v.query === '', `${v.focus} ${v.query}`);
  await close(page);
}
// 25. A game hidden while the player moves on: Rust's late answer leaves focus on the game they moved to, whose
// Details are open, so ✕ there plays the game they name.
{
  const games = [game(1), game(2), game(3)];
  const page = await open({ games });
  await page.evaluate((list) => {
    window.__settings = {
      // Rust answers when the test says so.
      library_set_hidden: ({ id, on }) =>
        new Promise((resolve) => {
          window.__answer = () => resolve(list.map((g) => (g.id === id ? { ...g, hidden: on } : g)));
        }),
    };
  }, games);
  await page.keyboard.press('i');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('i');
  await page.evaluate(() => window.__answer());
  await idle(page);
  const s = await state(page);
  const named = await page.evaluate(() => document.getElementById('dName').textContent);
  check('a hide that answers late keeps focus on the game the player moved to', s.details && s.focusName === 'Game 003' && named === 'Game 003', `${s.details} ${s.focusName} ${named}`);
  await close(page);
}

// 26. The hero art drifts only while Lamplit is used: with another window in front it holds still (a drift that never
// stops makes a VNC viewer resend the whole screen), and the next press moves it again.
{
  const page = await open({ games: [game(1), game(2)] });
  const drift = () =>
    page.evaluate(() => ({
      still: document.body.classList.contains('still'),
      play: getComputedStyle(document.querySelector('.hero')).animationPlayState,
    }));
  let d = await drift();
  check('the art drifts while Lamplit is in use', !d.still && d.play === 'running', JSON.stringify(d));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  d = await drift();
  check('another window in front holds the art still', d.still && d.play === 'paused', JSON.stringify(d));
  // The pointer passing over Lamplit behind another window mustn't start it again.
  await page.evaluate(() => {
    document.hasFocus = () => false;
    window.dispatchEvent(new Event('blur'));
  });
  await page.mouse.move(400, 300);
  await page.mouse.move(600, 400);
  d = await drift();
  check('the pointer over Lamplit behind another window leaves the art still', d.still && d.play === 'paused', JSON.stringify(d));
  await page.evaluate(() => {
    document.hasFocus = () => true;
  });
  await page.keyboard.press('ArrowRight');
  d = await drift();
  check('a press moves the art again', !d.still && d.play === 'running', JSON.stringify(d));
  await close(page);
}

// 27. A key Steam mirrors and the pad's own press count once, but a real second press right after still counts.
{
  const page = await open({ games: [game(1), game(2), game(3), game(4)] });
  await page.waitForTimeout(2100);
  await page.keyboard.press('ArrowRight');
  await emit(page, 'pad', 'right');
  await emit(page, 'pad', 'right');
  const s = await state(page);
  check('a mirrored key counts once, and the next real press after it still moves', s.focusIndex === 2, `focus ${s.focusIndex}`);
  await close(page);
}

/** The screensaver as the page shows it, and what is underneath. */
const saverView = (page) =>
  page.evaluate(() => {
    const el = document.getElementById('saver');
    return {
      on: !!el?.classList.contains('on'),
      mode: el?.dataset.mode ?? '',
      scene: el?.dataset.scene ?? '',
      focus: [...document.querySelectorAll('.cover')].findIndex((c) => c.classList.contains('focus')),
      starting: document.getElementById('overlay').classList.contains('on'),
      calls: window.__calls.map((c) => c[0]),
    };
  });
/** Waits for the screensaver to show (it fades in once its first frame is drawn). */
const saverOn = (page) =>
  // As long as a runner drawing in software takes to compile a scene and fade it in.
  page.waitForFunction(() => document.querySelector('#saver.on'), null, { timeout: 30000 }).catch(() => {});
/**
 * From now on the page's clock (open with `clock`) moves only as the test moves it, with runFor and fastForward,
 * whatever pace the runner keeps: a key and the pad press Steam mirrors from it come at one time, as they do.
 */
const holdClock = async (page) => page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 50));
/** On a held clock: lets the page's frames run until the screensaver shows (it fades in once they've come on time). */
async function saverShows(page) {
  for (let i = 0; i < 600 && !(await page.evaluate(() => Boolean(document.querySelector('#saver.on')))); i++) await page.clock.runFor(50);
}

// 28. The screensaver: after five minutes without input it covers the screen, and the first press only ends it. The
// key, the pad's own press of the same button (Steam mirrors one as the other), a held direction's repeats and a click
// do nothing else. It stays away while a game runs or another window is in front.
{
  const page = await open({ games: [game(1), game(2), game(3), game(4)], clock: true });
  await holdClock(page);
  await page.clock.fastForward('04:50');
  await page.waitForTimeout(200);
  let v = await saverView(page);
  check('no screensaver before five minutes without input', !v.on, JSON.stringify(v));
  await page.clock.fastForward('00:15');
  await saverShows(page);
  v = await saverView(page);
  check('the screensaver shows after five minutes without input', v.on && ['webgl', 'css'].includes(v.mode), JSON.stringify(v));
  await page.keyboard.press('ArrowRight');
  await emit(page, 'pad', 'right');
  v = await saverView(page);
  check('a key ends the screensaver and moves nothing, nor does the pad press Steam mirrored it from', !v.on && v.focus === 0, JSON.stringify(v));
  await page.clock.runFor(600);
  await emit(page, 'pad', 'right');
  v = await saverView(page);
  check('the next press moves again', v.focus === 1, `focus ${v.focus}`);

  await page.clock.fastForward('05:05');
  await saverShows(page);
  await emit(page, 'pad', 'ok');
  v = await saverView(page);
  check('✕ ends the screensaver without starting the game', !v.on && !v.starting && !v.calls.includes('launch_start'), JSON.stringify(v));

  await page.clock.runFor(600);
  await page.clock.fastForward('05:05');
  await saverShows(page);
  // Rust repeats a held direction after 380 ms, then every 110 ms, then faster.
  await emit(page, 'pad', 'left');
  for (const gap of [380, 110, 110, 70]) {
    await page.clock.runFor(gap);
    await emit(page, 'pad', 'left');
  }
  v = await saverView(page);
  check('a direction held after the press that ended the screensaver moves nothing', !v.on && v.focus === 1, JSON.stringify(v));

  // Steam's mirrored key can come before the controller's own press of the same direction: held on, the direction
  // still moves nothing.
  await page.clock.runFor(600);
  await page.clock.fastForward('05:05');
  await saverShows(page);
  await page.keyboard.press('ArrowLeft');
  await emit(page, 'pad', 'left');
  for (const gap of [380, 110, 110, 70]) {
    await page.clock.runFor(gap);
    await emit(page, 'pad', 'left');
  }
  v = await saverView(page);
  check('a direction held after its mirrored key ended the screensaver moves nothing', !v.on && v.focus === 1, JSON.stringify(v));

  // The pointer rests on the focused cover while the screensaver shows; a click there ends it and starts nothing.
  const [x, y] = await page.evaluate(() => {
    const r = document.querySelector('.cover.focus').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await page.mouse.move(x, y);
  await page.clock.runFor(600);
  await page.clock.fastForward('05:05');
  await saverShows(page);
  await page.mouse.move(x + 3, y + 2);
  v = await saverView(page);
  check('a twitch of the pointer leaves the screensaver on', v.on, JSON.stringify(v));
  await page.mouse.click(x + 3, y + 2);
  v = await saverView(page);
  check('a click ends the screensaver, and the cover under it starts nothing', !v.on && !v.starting && !v.calls.includes('launch_start'), JSON.stringify(v));

  await page.clock.runFor(600);
  await running(page, 'pc:2');
  await page.clock.fastForward('10:00');
  await page.waitForTimeout(200);
  v = await saverView(page);
  check('no screensaver while a game runs', !v.on, JSON.stringify(v));
  await emit(page, 'play', play('ended', 'pc:2'));
  await page.clock.fastForward('05:05');
  await saverShows(page);
  await running(page, 'pc:2');
  // It ends on its next frame.
  await page.clock.runFor(100);
  v = await saverView(page);
  check('a game that starts ends the screensaver', !v.on, JSON.stringify(v));

  await emit(page, 'play', play('ended', 'pc:2'));
  await page.evaluate(() => {
    document.hasFocus = () => false;
    window.dispatchEvent(new Event('blur'));
  });
  await page.clock.fastForward('10:00');
  await page.waitForTimeout(200);
  v = await saverView(page);
  check('no screensaver while another window is in front', !v.on, JSON.stringify(v));
  await close(page);
}

// 29. Settings > Screensaver: ← and → step the delay (Off among them), saved through Rust; Off keeps it away; Show it
// now shows it, and the ✕ that asked for it doesn't end it.
{
  const page = await open({ games: [game(1), game(2)], clock: true });
  await page.evaluate((prefs) => {
    const s = (window.__settings = { prefs });
    s.prefs_state = () => s.prefs;
    s.prefs_set_screensaver_minutes = ({ minutes }) => ((s.prefs.screensaver_minutes = minutes), s.prefs);
  }, ipc('prefs'));
  const view = () =>
    page.evaluate(() => ({
      open: document.getElementById('settings').classList.contains('on'),
      rows: [...document.querySelectorAll('#settingsList .row')].map((r) => r.textContent),
      focus: document.querySelector('#settingsList .row.focus')?.textContent ?? null,
      sent: window.__calls.filter((c) => c[0].startsWith('prefs_set_screensaver')),
    }));
  /** Moves focus down to the row that starts with `label`. */
  const down = async (label) => {
    for (let i = 0; i < 12 && !(await view()).focus?.startsWith(label); i++) await page.keyboard.press('ArrowDown');
  };
  await page.keyboard.press('c');
  await idle(page);
  await down('Screensaver');
  let v = await view();
  check('Settings lists the screensaver with its delay', v.focus === 'ScreensaverAfter 5 min', v.focus);
  await page.keyboard.press('Enter');
  await idle(page);
  v = await view();
  check(
    'the Screensaver section: the delay and Show it now, and no choice of scenes',
    JSON.stringify(v.rows.slice(0, 2)) === '["Starts after5 min","Show it now"]' && !v.rows.some((r) => r.startsWith('Scenes')) && v.focus === 'Starts after5 min',
    JSON.stringify(v.rows)
  );
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowLeft');
    await idle(page);
  }
  v = await view();
  check(
    '← steps the delay down to Off and stops there',
    JSON.stringify(v.sent) === '[["prefs_set_screensaver_minutes",{"minutes":2}],["prefs_set_screensaver_minutes",{"minutes":0}]]' && v.focus === 'Starts afterOff',
    JSON.stringify(v)
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.clock.fastForward('30:00');
  await page.waitForTimeout(200);
  let s = await saverView(page);
  check('with the screensaver Off, half an hour without input shows none', !s.on, JSON.stringify(s));

  await page.keyboard.press('c');
  await idle(page);
  await down('Screensaver');
  await page.keyboard.press('Enter');
  await down('Show it now');
  await holdClock(page);
  await page.keyboard.press('Enter');
  // The pad's own press of the ✕ that Steam mirrored as Enter, at the same time.
  await emit(page, 'pad', 'ok');
  await saverShows(page);
  s = await saverView(page);
  check("Show it now shows the screensaver, and the ✕ that asked doesn't end it", s.on && SCENES.some((x) => x.id === s.scene), JSON.stringify(s));
  await page.clock.runFor(600);
  await page.keyboard.press('Escape');
  v = await view();
  s = await saverView(page);
  check('a press ends it and leaves Settings where it was', !s.on && v.open && v.focus === 'Show it now', JSON.stringify({ s, v }));
  await close(page);
}

// 30. Without WebGL2 the screensaver is a moving CSS gradient, still in the colours of the player's game art, with the
// game's logo.
{
  const plain = await generateArt();
  const page = await open({ games: [game(1, { art: plain })], clock: true });
  await page.evaluate(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return type === 'webgl2' ? null : get.call(this, type, ...rest);
    };
  });
  await page.clock.fastForward('05:05');
  await saverOn(page);
  const v = await page.evaluate(() => {
    const el = document.getElementById('saver');
    const css = el.querySelector('.saver-css');
    return {
      on: el.classList.contains('on'),
      mode: el.dataset.mode,
      shown: getComputedStyle(css).display,
      canvas: getComputedStyle(el.querySelector('canvas')).display,
      moving: css.querySelector('i').getAnimations().length,
      colours: [1, 2, 3].map((i) => getComputedStyle(css).getPropertyValue(`--c${i}`).trim()),
      logo: el.querySelector('.saver-mark img').getAttribute('src'),
      log: window.__logs.find((line) => line.includes('screensaver on')),
    };
  });
  check('without WebGL2 the screensaver shows a moving CSS gradient', v.on && v.mode === 'css' && v.shown === 'block' && v.canvas === 'none' && v.moving > 0, JSON.stringify(v));
  // The generated hero art is one red-orange (#b4432c); a main colour of the palette keeps its hue.
  const hue = (css) => {
    const [r, g, b] = css.match(/\d+/g).map(Number);
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const art = hue('rgb(180 67 44)');
  check(
    "the screensaver's colours come from the game's art",
    v.colours.some((c) => c && Math.min(Math.abs(hue(c) - art), 360 - Math.abs(hue(c) - art)) < 12),
    `${JSON.stringify(v.colours)} near ${Math.round(art)}`
  );
  check("the game's logo drifts over it", v.logo?.endsWith(encodeURIComponent(plain.logo)), v.logo);
  check('the log says why there is no WebGL', /css \(WebGL2 is not available\), colours from 1 game$/.test(v.log ?? ''), v.log);
  await close(page);
}

// 31. A game's menu lifts its cover: the card grows out of the row over the blurred, dimmed screen, the menu opens
// beside it on screen, and Back lowers the card onto its cover again, also from halfway up.
for (const vp of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 1440, height: 1080 }]) {
  const page = await open({ games: [game(1), game(2), game(3)] }, vp);
  const lifted = () =>
    page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const lift = document.getElementById('lift');
      const veil = getComputedStyle(lift.querySelector('.veil'));
      const cover = document.querySelector('#track .cover.focus');
      return {
        shown: lift.classList.contains('shown'),
        on: lift.classList.contains('on'),
        visibility: getComputedStyle(lift).visibility,
        veil: { opacity: veil.opacity, drawn: lift.querySelector('.veil').classList.contains('drawn') },
        card: box(document.getElementById('card')),
        menu: box(document.getElementById('details')),
        menuOn: document.getElementById('details').classList.contains('on'),
        cover: box(cover),
        coverHidden: getComputedStyle(cover).visibility === 'hidden',
        drift: getComputedStyle(document.querySelector('.hero')).animationPlayState,
        w: innerWidth,
        h: innerHeight,
      };
    });
  const rest = await lifted();
  await page.keyboard.press('i');
  // The veil is drawn a frame or two after the press (veil.js): the lift has settled once it has come in.
  await until(page, () => {
    const veil = document.querySelector('#lift .veil');
    return veil.classList.contains('drawn') && getComputedStyle(veil).opacity === '1' && document.getElementById('details').classList.contains('on');
  });
  await settled(page);
  let l = await lifted();
  const at = `${vp.width}x${vp.height}`;
  check(`${at}: the menu lifts the focused cover over a blurred, dimmed screen`, l.on && l.veil.opacity === '1' && l.veil.drawn && l.coverHidden, JSON.stringify(l));
  check(`${at}: the lifted cover is larger than in the row, and higher`, l.card.h > rest.cover.h * 1.4 && l.card.y + l.card.h / 2 < rest.cover.y + rest.cover.h / 2 - l.h * 0.1, JSON.stringify([rest.cover, l.card]));
  check(`${at}: the menu opens beside the cover, inside the screen`, l.menuOn && l.menu.x >= l.card.x + l.card.w && l.menu.x + l.menu.w <= l.w * 0.95 + 1 && l.menu.y >= 0 && l.menu.y + l.menu.h <= l.h, JSON.stringify([l.card, l.menu]));
  // Once the menu rests, the art behind holds still as one opaque copy under the veil (veil.js, 54).
  await until(page, () => document.getElementById('stage').dataset.stage === 'staged');
  l = await lifted();
  check(`${at}: once the menu rests, the art behind holds still under the veil`, l.drift === 'paused', l.drift);
  await page.screenshot({ path: path.join(shots, `menu-${vp.width}x${vp.height}.png`) });
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('lift').classList.contains('shown'));
  l = await lifted();
  check(`${at}: Back lowers the cover into the row, which shows it again`, !l.shown && l.visibility === 'hidden' && !l.coverHidden && l.drift === 'running', JSON.stringify(l));
  if (vp.width === 1920) {
    // Back while the card still rises: it turns round from where it is, rather than jumping. Sampled once the card
    // has risen some way, and again once it has started down, whatever pace the frames keep.
    const start = await page.evaluate(() => document.getElementById('card').getBoundingClientRect().height);
    await page.keyboard.press('i');
    await until(page, (from) => document.getElementById('card').getBoundingClientRect().height > from * 1.15, start);
    const rising = (await lifted()).card;
    await page.keyboard.press('Escape');
    await until(page, (from) => document.getElementById('card').getBoundingClientRect().height < from - 1, rising.h);
    const lowering = (await lifted()).card;
    check('Back during the lift lowers the card from where it was', lowering.h < rising.h && lowering.h > rest.cover.h * 1.02, JSON.stringify({ rising, lowering, cover: rest.cover }));
    await until(page, () => !document.getElementById('lift').classList.contains('shown'));
    // A click on the blurred screen closes the menu too.
    await page.keyboard.press('i');
    await settled(page);
    await page.mouse.click(l.w - 20, 20);
    l = await lifted();
    check('a click beside the menu closes it', !l.on, JSON.stringify(l));
    if (perf) {
      await until(page, () => !document.getElementById('lift').classList.contains('shown'));
      const frames = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const deltas = [];
            let last = performance.now();
            window.__emit('pad', 'menu');
            const step = (now) => {
              deltas.push(now - last);
              last = now;
              if (deltas.length < 45) requestAnimationFrame(step);
              else resolve(deltas.slice(2));
            };
            requestAnimationFrame(step);
          })
      );
      frames.sort((a, b) => a - b);
      check('frames while the cover lifts', frames[Math.floor(frames.length * 0.95)] < 20, `median ${frames[Math.floor(frames.length / 2)].toFixed(1)} ms, p95 ${frames[Math.floor(frames.length * 0.95)].toFixed(1)} ms`);
    }
  }
  await close(page);
}

// 32. Change art: Steam's matches for the game's name as covers, the card showing the one in focus, then the choice
// saved; no art; back to automatic; another search typed on the keyboard; and a search that fails.
{
  const games = [game(1, { name: 'Cyberpunk 2077' }), game(2)];
  const [withCover, noCover] = ipc('art-candidates');
  const found = [like(withCover, { portrait: art[0].portrait }), noCover];
  const page = await open({ games });
  await page.evaluate(
    ([list, found, error]) => {
      const s = (window.__settings = { list });
      s.library_art_search = ({ query }) => {
        if (query === 'offline') throw error;
        if (query === 'slow') return new Promise((answer) => setTimeout(() => answer(found), 1000));
        return query === 'nothing' ? [] : found;
      };
      /** Rust's answer: every game, the chosen art on the game. */
      s.library_set_art = ({ id, choice }) => {
        const g = s.list.find((x) => x.id === id);
        g.art_choice = choice;
        g.art = { portrait: choice?.steam === found[0].appid ? found[0].portrait : null, hero: null, logo: null };
        return s.list;
      };
    },
    [games, found, like(ipc('error'), { message: 'Find art online is off. Settings > System switches it on.' })]
  );
  const picker = () =>
    page.evaluate(() => ({
      open: document.getElementById('artPick').classList.contains('on'),
      menu: document.getElementById('details').classList.contains('on'),
      editing: document.getElementById('artPick').classList.contains('editing'),
      query: document.getElementById('artQuery').textContent,
      status: document.getElementById('artStatus').textContent,
      tiles: [...document.querySelectorAll('#artTiles .tile')].map((t) => t.querySelector('.caption').textContent + (t.querySelector('.badge') ? ' (chosen)' : '')),
      choices: [...document.querySelectorAll('#artChoices .choice')].map((c) => c.textContent + (c.classList.contains('on') ? ' (on)' : '')),
      focus: (document.querySelector('#artPick .focus .caption') ?? document.querySelector('#artPick .focus'))?.textContent ?? null,
      face: { art: document.getElementById('face').classList.contains('has-art'), image: document.getElementById('face').style.backgroundImage },
      hint: document.getElementById('hint').textContent,
      lastCall: window.__calls.at(-1),
    }));
  await page.keyboard.press('i');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await idle(page);
  let p = await picker();
  check('Change art searches Steam for the game\'s name', p.open && !p.menu && JSON.stringify(p.lastCall) === '["library_art_search",{"query":"Cyberpunk 2077"}]', JSON.stringify(p));
  check('the matches show as covers, with no art below', JSON.stringify(p.tiles) === '["Cyberpunk 2077","Cyberpunk 2077: Phantom Liberty"]' && JSON.stringify(p.choices) === '["No art, show the name"]', JSON.stringify(p));
  check('focus starts on the first match, which the lifted cover shows', p.focus === 'Cyberpunk 2077' && p.face.art && p.face.image.includes(encodeURIComponent(found[0].portrait)), JSON.stringify(p));
  check('Change art hints Select, Edit search and Back', p.hint === '✕Select□Edit search○Back', p.hint);
  await settled(page);
  await page.screenshot({ path: path.join(shots, 'change-art.png') });
  await page.keyboard.press('ArrowRight');
  p = await picker();
  check('a match without a cover shows the name on the lifted cover', p.focus === 'Cyberpunk 2077: Phantom Liberty' && !p.face.art, JSON.stringify(p));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await idle(page);
  p = await picker();
  let s = await state(page);
  check('✕ on a match saves it for the game', JSON.stringify(s.lastCall) === '["library_set_art",{"id":"pc:1","choice":{"steam":1091500}}]', JSON.stringify(s.lastCall));
  check('then the menu is back, with the cover in its new art', !p.open && p.menu && p.face.art && s.hint.includes('✕Select'), JSON.stringify(p));
  // Again: the choice is marked, and automatic art is a choice now.
  await page.keyboard.press('Enter');
  await idle(page);
  p = await picker();
  check('the chosen match is marked, and Back to automatic offered', p.tiles[0] === 'Cyberpunk 2077 (chosen)' && JSON.stringify(p.choices) === '["No art, show the name","Back to automatic"]', JSON.stringify(p));
  await page.keyboard.press('ArrowDown');
  p = await picker();
  check('No art shows the name on the lifted cover', p.focus === 'No art, show the name' && !p.face.art, JSON.stringify(p));
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('✕ on No art saves it', JSON.stringify(s.lastCall) === '["library_set_art",{"id":"pc:1","choice":"none"}]', JSON.stringify(s.lastCall));
  await page.keyboard.press('Enter');
  await idle(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  p = await picker();
  check('No art is marked as the choice', p.choices[0] === 'No art, show the name (on)' && p.focus === 'Back to automatic', JSON.stringify(p));
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('✕ on Back to automatic clears the choice', JSON.stringify(s.lastCall) === '["library_set_art",{"id":"pc:1","choice":null}]', JSON.stringify(s.lastCall));
  // Other words, typed on the keyboard: on screen with the pad, or on the PC's keyboard.
  await page.keyboard.press('Enter');
  await idle(page);
  await page.keyboard.press('f');
  p = await picker();
  check('□ edits the search on the keyboard', p.editing && p.query === 'Cyberpunk 2077' && p.hint === '✕Select□Delete△Space○Cancel', JSON.stringify(p));
  for (let i = 0; i < 'Cyberpunk 2077'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('nothing');
  await page.keyboard.press('Enter');
  await idle(page);
  p = await picker();
  check('Done searches for the words typed', !p.editing && JSON.stringify(p.lastCall) === '["library_art_search",{"query":"nothing"}]' && p.status.startsWith('Nothing on Steam\'s store matches "nothing"') && p.tiles.length === 0, JSON.stringify(p));
  check('with no matches, focus is on the search', p.focus?.includes('nothing'), JSON.stringify(p));
  await page.keyboard.press('Enter');
  for (let i = 0; i < 'nothing'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('offline');
  await page.keyboard.press('Escape');
  p = await picker();
  check('○ on the keyboard keeps the search it had', !p.editing && p.query === 'nothing', JSON.stringify(p));
  await page.keyboard.press('Enter');
  for (let i = 0; i < 'nothing'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('offline');
  await page.keyboard.press('Enter');
  await idle(page);
  p = await picker();
  check('a search that fails says why, and No art still works', p.status === 'Find art online is off. Settings > System switches it on.' && p.choices[0].startsWith('No art'), JSON.stringify(p));
  // Back on the keyboard before a search has answered, typing other words: the answer leaves them as they are.
  await page.keyboard.press('Enter');
  for (let i = 0; i < 'offline'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('slow');
  await page.keyboard.press('Enter');
  await page.keyboard.press('f');
  for (let i = 0; i < 'slow'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('other');
  await idle(page);
  p = await picker();
  check('a search answering while the player types leaves the words on the keyboard', p.editing && p.query === 'other', JSON.stringify(p));
  await page.keyboard.press('Enter');
  await idle(page);
  p = await picker();
  check('... and Done searches for those words', JSON.stringify(p.lastCall) === '["library_art_search",{"query":"other"}]', JSON.stringify(p.lastCall));
  await page.keyboard.press('Escape');
  p = await picker();
  check('○ goes back to the menu', !p.open && p.menu, JSON.stringify(p));
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('lift').classList.contains('shown'));
  s = await state(page);
  check('and ○ again to the row', s.hint.startsWith('✕Play'), s.hint);
  await close(page);
}

// 33. Add a game: a program Lamplit passed over, or an exe browsed for on the drives, named on the keyboard, then its
// art; a game added by hand can be removed again. With nothing found at all, ✕ on the empty row adds one.
{
  const games = [game(1)];
  const [program] = ipc('programs');
  const programs = [program, like(program, { name: 'Zeta Tool', exe: 'C:\\Program Files\\Zeta\\zeta.exe', folder: 'C:\\Program Files\\Zeta' })];
  const games2 = ipc('folder');
  const drive = (letter) => ({ name: `${letter}:`, path: `${letter}:\\`, kind: known('entry_kind', 'drive'), title: null });
  const folders = {
    '': { path: null, parent: null, entries: [drive('C'), drive('D')] },
    'C:\\': { path: 'C:\\', parent: null, entries: [] },
    'D:\\': { path: 'D:\\', parent: null, entries: [{ ...games2.entries[0], name: 'Games', path: 'D:\\Games' }] },
    'D:\\Games': games2,
  };
  const page = await open({ games });
  await page.evaluate(
    ([list, programs, folders, base]) => {
      const s = (window.__settings = { list });
      s.library_programs = programs;
      s.library_browse = ({ path }) => folders[path ?? ''];
      s.library_add_game = ({ exe, name }) => {
        if (name === 'Taken') throw { kind: 'player', message: 'That folder belongs to Game 001, which Lamplit already has.' };
        const id = `manual:${exe.toLowerCase()}`;
        s.list = [...s.list, { ...base, id, name, store: null, dir: exe.slice(0, exe.lastIndexOf('\\')), manual: true, requires: [] }];
        return { id, games: s.list };
      };
      s.library_art_search = [];
      s.library_remove_game = ({ id }) => (s.list = s.list.filter((g) => g.id !== id));
    },
    [games, programs, folders, game(9)]
  );
  const add = () =>
    page.evaluate(() => ({
      open: document.getElementById('add').classList.contains('on'),
      naming: document.getElementById('add').classList.contains('naming'),
      title: document.getElementById('addTitle').textContent,
      path: document.getElementById('addPath').textContent,
      rows: [...document.querySelectorAll('#addList > *')].map((r) => (r.tagName === 'H3' ? `# ${r.textContent}` : r.textContent)),
      focus: document.querySelector('#addList .row.focus')?.textContent ?? null,
      name: document.getElementById('addName').textContent,
      hint: document.getElementById('hint').textContent,
      lastCall: window.__calls.at(-1),
    }));
  const settingsRows = () => page.evaluate(() => [...document.querySelectorAll('#settingsList .row')].map((r) => r.textContent));
  await page.keyboard.press('c');
  await idle(page);
  const at = (await settingsRows()).findIndex((r) => r.startsWith('Add a game'));
  for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await idle(page);
  let a = await add();
  check('Settings > Add a game lists browsing first, then the programs Lamplit passed over', a.open && a.title === 'Add a game' && JSON.stringify(a.rows) === '["Browse drives and folders","# Programs on this PC","Old RacerC:\\\\Program Files\\\\Old Racer","Zeta ToolC:\\\\Program Files\\\\Zeta"]' && a.focus === 'Browse drives and folders', JSON.stringify(a));
  await settled(page);
  await page.screenshot({ path: path.join(shots, 'add-list.png') });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  a = await add();
  check('a program goes to naming, with its name filled in and focus on Done', a.naming && a.title === 'Name the game' && a.name === 'Old Racer' && a.path === program.exe && a.hint === '✕Select□Delete△Space○Back', JSON.stringify(a));
  await page.keyboard.press('Enter');
  await idle(page);
  let s = await state(page);
  const lift = () =>
    page.evaluate(() => ({
      art: document.getElementById('artPick').classList.contains('on'),
      face: document.querySelector('#face .name').textContent,
    }));
  const added = await page.evaluate(() => window.__calls.find((c) => c[0] === 'library_add_game'));
  check('Done adds the game', JSON.stringify(added) === `["library_add_game",{"exe":${JSON.stringify(program.exe)},"name":"Old Racer"}]`, JSON.stringify(added));
  let l = await lift();
  check('then its cover lifts into Change art, searching for its name', !(await add()).open && s.focusName === 'Old Racer' && l.art && l.face === 'Old Racer' && JSON.stringify(s.lastCall) === '["library_art_search",{"query":"Old Racer"}]', JSON.stringify({ ...l, focus: s.focusName, last: s.lastCall }));
  // Its menu offers Remove, which says the files stay, and happens once Cross is held.
  await page.keyboard.press('Escape');
  const choices = await page.evaluate(() => [...document.querySelectorAll('#dChoices .row')].map((r) => r.textContent));
  check('the menu of a game added by hand offers Remove from Lamplit, saying the files stay', choices.at(-1) === 'Remove from LamplitLamplit forgets it. The files stay.' && (await page.evaluate(() => document.getElementById('dStore').textContent)) === 'Added by hand', JSON.stringify(choices));
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  s = await state(page);
  check('✕ pressed on Remove removes nothing', s.lastCall?.[0] !== 'library_remove_game' && s.hint.includes('Hold to remove'), `${JSON.stringify(s.lastCall)} ${s.hint}`);
  await page.keyboard.down('Enter');
  await until(page, () => window.__calls.some((c) => c[0] === 'library_remove_game'));
  await page.keyboard.up('Enter');
  await idle(page);
  s = await state(page);
  check('held, it removes it from the row', s.lastCall?.[0] === 'library_remove_game' && s.covers === 1 && s.toast === 'Old Racer is no longer in Lamplit.', `${JSON.stringify(s.lastCall)} ${s.covers} ${s.toast}`);
  // Browsing: drives, folders, an exe; ○ goes up a level with focus on where it came from.
  await page.keyboard.press('c');
  await idle(page);
  for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await idle(page);
  await page.keyboard.press('Enter');
  await idle(page);
  a = await add();
  check('Browse starts at the drives', a.title === "Choose the game's exe" && a.path === 'This PC' && JSON.stringify(a.rows) === '["C:","D:"]' && JSON.stringify(a.lastCall) === '["library_browse",{"path":null}]', JSON.stringify(a));
  // A folder with nothing to open or choose: ✕ does nothing there.
  await page.keyboard.press('Enter');
  await idle(page);
  const errors = await page.evaluate(() => window.__errors.length);
  await page.keyboard.press('Enter');
  await idle(page);
  a = await add();
  check('✕ in a folder with no folders or exes does nothing', a.path === 'C:\\' && JSON.stringify(a.rows) === '["No folders or exes here"]' && (await page.evaluate(() => window.__errors.length)) === errors, JSON.stringify(a) + JSON.stringify(await page.evaluate(() => window.__errors)));
  await page.keyboard.press('Escape');
  await idle(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await idle(page);
  await page.keyboard.press('Enter');
  await idle(page);
  a = await add();
  check('folders open with ✕ or →, folders first, then exes', a.path === 'D:\\Games' && JSON.stringify(a.rows) === '["Racer","tetris.exe"]' && a.hint === '✕Open○Back', JSON.stringify(a));
  await page.keyboard.press('ArrowDown');
  a = await add();
  check('an exe is chosen, not opened', a.focus === 'tetris.exe' && a.hint === '✕Choose○Back', a.hint);
  await settled(page);
  await page.screenshot({ path: path.join(shots, 'add-browse.png') });
  await page.keyboard.press('Escape');
  await idle(page);
  a = await add();
  check('○ goes up a level, onto the folder it came from', a.path === 'D:\\' && a.focus === 'Games', JSON.stringify(a));
  await page.keyboard.press('ArrowLeft');
  await idle(page);
  a = await add();
  check('← goes up too, to the drives at the top', a.path === 'This PC' && a.focus === 'D:', JSON.stringify(a));
  await page.keyboard.press('Enter');
  await idle(page);
  await page.keyboard.press('Enter');
  await idle(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  a = await add();
  check('an exe goes to naming, with the name of its folder or file', a.naming && a.name === 'Tetris' && a.path === 'D:\\Games\\tetris.exe', JSON.stringify(a));
  // The on-screen keyboard: a capital at each word. (The pad's ✕ right after the key's Enter would count as Steam's
  // mirror of it.)
  await page.waitForTimeout(350);
  await emit(page, 'pad', 'triangle');
  for (const step of ['up', 'up', 'up', 'left']) await emit(page, 'pad', step);
  a = await add();
  const focusKey = await page.evaluate(() => document.querySelector('#addKeys .key.focus').textContent);
  await emit(page, 'pad', 'ok');
  a = await add();
  check('the names keyboard types a capital at the start of a word', a.name === `Tetris ${focusKey.toUpperCase()}`, `${a.name} ${focusKey}`);
  await settled(page);
  await page.screenshot({ path: path.join(shots, 'add-name.png') });
  await emit(page, 'pad', 'square');
  await emit(page, 'pad', 'square');
  await page.waitForTimeout(2100);
  await page.keyboard.type(' Classic');
  a = await add();
  check('the PC\'s keyboard types into the name as typed', a.name === 'Tetris Classic', a.name);
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('a browsed exe is added with the name typed', JSON.stringify(await page.evaluate(() => window.__calls.filter((c) => c[0] === 'library_add_game').at(-1))) === '["library_add_game",{"exe":"D:\\\\Games\\\\tetris.exe","name":"Tetris Classic"}]' && s.focusName === 'Tetris Classic', JSON.stringify(s.calls.slice(-3)));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // A refusal stays on naming, with Rust's reason.
  await page.keyboard.press('c');
  await idle(page);
  for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await idle(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2100);
  for (let i = 0; i < 'Old Racer'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('Taken');
  await page.keyboard.press('Enter');
  await idle(page);
  a = await add();
  s = await state(page);
  check('a game Rust refuses stays on naming, and says why', a.naming && s.toast.includes('That folder belongs to Game 001'), `${a.naming} ${s.toast}`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const settings = await page.evaluate(() => ({
    open: document.getElementById('settings').classList.contains('on'),
    focus: document.querySelector('#settingsList .row.focus')?.textContent,
  }));
  check('○ from Add a game goes back to Settings, on Add a game', settings.open && settings.focus?.startsWith('Add a game'), JSON.stringify(settings));
  await close(page);

  // Nothing found at all: the empty row offers to add a game.
  const empty = await open({ games: [] });
  await empty.evaluate(() => (window.__settings = { library_programs: [] }));
  s = await state(empty);
  check('with no games found, ✕ adds one', s.empty === 'No games found' && s.hint.startsWith('✕Add a game'), s.hint);
  await empty.keyboard.press('Enter');
  await idle(empty);
  const e = await empty.evaluate(() => ({
    open: document.getElementById('add').classList.contains('on'),
    rows: [...document.querySelectorAll('#addList > *')].map((r) => r.textContent),
  }));
  check('…and lists that no other programs were found', e.open && JSON.stringify(e.rows) === '["Browse drives and folders","Programs on this PC","No other programs found"]', JSON.stringify(e));
  await empty.keyboard.press('Escape');
  s = await state(empty);
  check('○ from there goes back to the empty row', s.hint.startsWith('✕Add a game'), s.hint);
  await close(empty);
}

await dockTests({ open, close, check, shots });
await probeTests({ open, close, check, games: [game(1), game(2), game(3)] });

// 31. Every scene compiles and draws: each one in the screensaver's preview, served the way Tauri serves the page and
// under the same content security policy, Gallery and Drift with the covers and hero art cut from the README's
// screenshots. Without WebGL2 in this browser, each shows the CSS gradient instead.
{
  const repo = path.join(here, '..');
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP blocked ${e.blockedURI} (${e.violatedDirective})`))
  );
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route(`${pageOrigin}/**`, (route) =>
    serveFile(route, path.join(repo, new URL(route.request().url()).pathname), { 'Content-Security-Policy': cspHeader })
  );
  const shown = [];
  let webgl2 = null;
  for (const scene of SCENES) {
    await page.goto(`${pageOrigin}/ui/screensaver/preview.html?scene=${scene.id}&hud=0`);
    // Raymarched scenes compile slowly on a GPU that is emulated in software.
    await page.waitForFunction(() => document.querySelector('#saver.on'), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(400);
    const v = await page.evaluate(() => ({
      on: !!document.querySelector('#saver.on'),
      scene: document.getElementById('saver')?.dataset.scene,
      mode: document.getElementById('saver')?.dataset.mode,
      reason: window.preview?.saver.reason ?? '',
      webgl2: !!document.createElement('canvas').getContext('webgl2'),
    }));
    webgl2 ??= v.webgl2;
    shown.push(`${scene.id}:${v.on && v.scene === scene.id ? v.mode : 'not shown'}${v.reason ? ` (${v.reason})` : ''}`);
  }
  const want = webgl2 ? 'webgl' : 'css';
  check(
    `every scene draws (${want === 'webgl' ? 'with WebGL2' : 'as the CSS gradient: no WebGL2 here'})`,
    shown.every((x) => x.endsWith(`:${want}`)),
    shown.join(', ')
  );
  check('the preview and its scenes load without errors under the CSP', errors.length === 0, JSON.stringify(errors));
  // Thirty seconds into a scene its game's logo or name has drifted in, but not over the scenes that show the games'
  // own art.
  const marks = {};
  for (const id of ['ink', 'gallery', 'drift']) {
    await page.goto(`${pageOrigin}/ui/screensaver/preview.html?scene=${id}&at=30&hud=0`);
    await page.waitForFunction(() => document.querySelector('#saver.on'), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(400);
    marks[id] = await page.evaluate(() => Number(document.querySelector('.saver-mark').style.opacity));
  }
  check("the game's logo drifts over Ink but not over Gallery or Drift", marks.ink > 0.2 && marks.gallery === 0 && marks.drift === 0, JSON.stringify(marks));
  if (webgl2) {
    // A show that ends frees its buffers a second later, but keeps the art's textures: the next one uploads none.
    await page.goto(`${pageOrigin}/ui/screensaver/preview.html?scene=drift&hud=0`);
    await page.waitForFunction(() => window.preview?.saver.art.heroes.length > 1, null, { timeout: 30000 });
    // Drift has drawn with the hero images, uploading them.
    await page.waitForFunction(() => window.preview.saver.renderer.images.size >= 2, null, { timeout: 30000 }).catch(() => {});
    const again = await page.evaluate(async () => {
      /** @param {() => boolean} ok */
      const until = async (ok) => {
        for (let i = 0; i < 300 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      };
      const { saver } = window.preview;
      const scene = saver.current.scene;
      let uploads = 0;
      const upload = WebGL2RenderingContext.prototype.texImage2D;
      // The art's uploads are the ones from an image (six arguments); the palettes' gradients come as bytes.
      WebGL2RenderingContext.prototype.texImage2D = function (...args) {
        if (args.length === 6) uploads++;
        return upload.apply(this, args);
      };
      const art = saver.renderer.images.size;
      saver.stop();
      await until(() => saver.renderer.targets.every((t) => !t));
      const freed = saver.renderer.targets.every((t) => !t);
      saver.start(scene);
      // Its first frame drawn, with the hero images.
      await until(() => saver.drawn);
      return { scene: saver.current.scene.id, art, freed, drawn: saver.drawn, uploads };
    });
    check(
      'a show that ends frees its buffers, and the next one uploads no art again',
      again.scene === 'drift' && again.art >= 2 && again.freed && again.drawn && again.uploads === 0,
      JSON.stringify(again)
    );
    // The frame Lamplit draws ahead (Saver.prime) waits while the last show fades out, though its scene is compiled.
    const fading = await page.evaluate(async () => {
      const { saver } = window.preview;
      let draws = 0;
      const draw = WebGL2RenderingContext.prototype.drawArrays;
      WebGL2RenderingContext.prototype.drawArrays = function (...args) {
        draws++;
        return draw.apply(this, args);
      };
      saver.stop();
      saver.opening = saver.current.scene;
      saver.prime();
      const whileFading = draws;
      // Once the fade-out has ended.
      for (let i = 0; i < 300 && getComputedStyle(saver.root).visibility !== 'hidden'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      saver.prime();
      return { whileFading, once: draws, freed: saver.renderer.targets.every((t) => !t), canvas: saver.canvas.width };
    });
    check(
      'the frame drawn ahead waits while a show fades out, then draws unseen and lets its buffers go',
      fading.whileFading === 0 && fading.once > 0 && fading.freed && fading.canvas === 1,
      JSON.stringify(fading)
    );
    // The frames' times in the two checks below are the test's own: requestAnimationFrame and performance.now follow
    // the times it steps through, so a runner drawing in software, whose frames come late anyway, sees the same.
    await page.evaluate(() => {
      window.__frames = () => {
        const real = { raf: window.requestAnimationFrame, now: performance.now };
        let t = real.now.call(performance);
        /** @type {FrameRequestCallback[]} */
        let due = [];
        window.requestAnimationFrame = (callback) => due.push(callback);
        performance.now = () => t;
        return {
          get t() {
            return t;
          },
          /** The next frame, `gap` ms after the one before. @param {number} gap */
          step(gap) {
            t += gap;
            const now = due;
            due = [];
            for (const callback of now) callback(t);
          },
          end() {
            window.requestAnimationFrame = real.raf;
            performance.now = real.now;
          },
        };
      };
    });
    // The fade-in waits for the frames to come on time for 450 ms (a GPU coming up from its idle clocks takes up to
    // 265 ms a frame at first), 750 ms at most from the first frame drawn. Meanwhile the screensaver is drawn but too
    // faint to see, so the GPU does the work it will do once it shows, and the fade starts from there. Here the frames
    // come 40 ms apart for a while from the start, then at 60 Hz: not at all, for 100 ms, and for 1.5 s.
    const fadeIn = await page.evaluate(() => {
      const { saver } = window.preview;
      const look = () => {
        const style = getComputedStyle(saver.root);
        return `${style.visibility} ${Number(style.opacity).toFixed(3)}`;
      };
      const fadesInAfter = (/** @type {number} */ lateFor) => {
        const frames = window.__frames();
        const start = frames.t;
        saver.start(saver.current.scene);
        /** How the screensaver looks while it waits, and as the fade starts. */
        const seen = { waiting: '', fading: '' };
        for (let i = 0; i < 300 && !saver.root.classList.contains('on'); i++) {
          frames.step(frames.t - start < lateFor ? 40 : 1000 / 60);
          if (saver.root.classList.contains('waiting')) seen.waiting = look();
        }
        seen.fading = look();
        const at = Math.round(frames.t - start);
        saver.stop();
        frames.end();
        return { at, ...seen };
      };
      return { onTime: fadesInAfter(0), late100: fadesInAfter(100), late1500: fadesInAfter(1500) };
    });
    const faint = (/** @type {{ waiting: string, fading: string }} */ f) => f.waiting === 'visible 0.004' && f.fading === 'visible 0.004';
    check(
      'the screensaver waits drawn but unseen until its frames come on time for 450 ms, 750 ms at most, then fades in from there',
      [fadeIn.onTime, fadeIn.late100, fadeIn.late1500].every(faint) &&
        fadeIn.onTime.at >= 450 &&
        fadeIn.late100.at >= 550 &&
        fadeIn.late100.at < fadeIn.late1500.at &&
        fadeIn.late1500.at >= 750 &&
        fadeIn.late1500.at < 1200,
      JSON.stringify(fadeIn)
    );
    // A GPU still at a low power state draws the scenes in time for 30 frames a second while the screen misses
    // refreshes at its own rate, which the fade-in and the mark's drift show. Here the frames come at 60 Hz for half a
    // second, which keeps the scale, then 33 ms apart, missing every other refresh: within 900 ms, about as long as a
    // show waits to fade in, the scale steps down twice at least, and the next show starts at the full scale again.
    // Counting only frames late for 30 frames a second, as it did before, took no step.
    const adapts = await page.evaluate(() => {
      const { saver } = window.preview;
      const frames = window.__frames();
      saver.start(saver.current.scene);
      for (let i = 0; i < 30; i++) frames.step(1000 / 60);
      const onTime = saver.scale;
      for (let i = 0; i < 27; i++) frames.step(1000 / 30);
      const missing = saver.scale;
      const width = saver.renderer.targets[0]?.width;
      saver.stop();
      saver.start(saver.current.scene);
      const next = saver.scale;
      saver.stop();
      frames.end();
      return { onTime, missing, width, next };
    });
    check(
      'refreshes the screen misses step the scale down within the wait to fade in, frames on time keep it, and the next show starts at the full scale',
      adapts.onTime === 0.6 && adapts.missing <= 0.6 * 0.85 * 0.85 && adapts.next === 0.6,
      JSON.stringify(adapts)
    );
  }
  await page.close();
}

// 32. A game's news takes the screen from Add a game: a game that closes right after starting (a launcher handing
// over) shows the starting screen, and the panel goes with it rather than staying over the row, catching clicks.
{
  const page = await open({ games: [game(1), game(2)] });
  await page.evaluate(() => (window.__settings = { library_programs: [] }));
  const openAdd = async () => {
    await page.keyboard.press('c');
    await idle(page);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#settingsList .row')].map((r) => r.textContent));
    for (let i = 0; i < rows.findIndex((r) => r.startsWith('Add a game')); i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await idle(page);
  };
  const panel = () => page.evaluate(() => document.getElementById('add').classList.contains('on'));
  await openAdd();
  const before = await panel();
  await emit(page, 'play', play('starting', 'pc:2'));
  let s = await state(page);
  check('a game coming back while Add a game is open closes the panel for the starting screen', before && !(await panel()) && s.overlay, `${before} ${await panel()} ${s.overlay}`);
  await emit(page, 'play', play('ended', 'pc:2'));
  // Focus is on the game that ended, the second.
  await page.keyboard.press('ArrowLeft');
  s = await state(page);
  check('after it, the controller moves the row again', !(await panel()) && !s.overlay && s.focusName === 'Game 001', `${await panel()} ${s.focusName}`);
  await openAdd();
  await emit(page, 'summoned', null);
  check('a controller bringing Lamplit forward closes Add a game too', !(await panel()), String(await panel()));
  await close(page);
}

// 33. Starting a game: a window that may need the player gets a line of its own, and ✕ shows it; once the game's
// window is up, the starting screen fades to black, ends once the window has the screen, and the black lifts. A
// window that goes during the fade (a game that replaces its window) leaves the starting screen as it was.
{
  const page = await open({ games: [game(1), game(2)] });
  await page.keyboard.press('Enter');
  await idle(page);
  await emit(page, 'launch-step', step({ id: 'pc:1', key: 'window', state: 'warn', label: 'Game 001 may need you', store: null }));
  let s = await state(page);
  check('a window that may need the player offers to show it', s.hint.startsWith('✕Show the window'), s.hint);
  await page.waitForTimeout(350);
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('✕ shows that window', JSON.stringify(s.lastCall) === '["launch_show",{"store":null}]', JSON.stringify(s.lastCall));
  const look = () =>
    page.evaluate(() => ({
      curtain: getComputedStyle(document.getElementById('curtain')).opacity,
      overlay: document.getElementById('overlay').classList.contains('on'),
    }));
  await emit(page, 'play', play('up', 'pc:1'));
  await until(page, () => Number(getComputedStyle(document.getElementById('curtain')).opacity) > 0.2);
  let v = await look();
  check('the game\'s window up: the starting screen fades to black first', v.overlay && Number(v.curtain) > 0.2, JSON.stringify(v));
  await until(page, () => getComputedStyle(document.getElementById('curtain')).opacity === '1');
  v = await look();
  check('under the black the launch goes on until the window has the screen', v.overlay && v.curtain === '1', JSON.stringify(v));
  await running(page, 'pc:1');
  v = await look();
  check('once it has, the starting screen ends under the black', !v.overlay && v.curtain === '1', JSON.stringify(v));
  await until(page, () => getComputedStyle(document.getElementById('curtain')).opacity === '0');
  v = await look();
  check('then the black lifts, the home screen ready behind the game', v.curtain === '0', JSON.stringify(v));
  // News of another game, while one starts, doesn't fade the screen.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await idle(page);
  await emit(page, 'play', play('up', 'pc:1'));
  await running(page, 'pc:1');
  await page.waitForTimeout(150);
  v = await look();
  check('another game running leaves the starting screen as it is', v.overlay && v.curtain === '0', JSON.stringify(v));
  // The window of the game being started goes during the fade, and no other is up yet: no news that it runs.
  await emit(page, 'play', play('up', 'pc:2'));
  await until(page, () => !document.body.classList.contains('curtain'));
  await until(page, () => getComputedStyle(document.getElementById('curtain')).opacity === '0');
  v = await look();
  s = await state(page);
  check('a window gone during the fade: the black lifts on the starting screen', v.overlay && v.curtain === '0' && s.overlayTitle === 'Starting Game 002…', JSON.stringify(v) + s.overlayTitle);
  await emit(page, 'launch-step', step({ id: 'pc:2', key: 'hint', state: 'warn', label: 'Still waiting: Steam may need you', store: 'steam' }));
  await emit(page, 'launch-step', step({ id: 'pc:2', key: 'window', state: 'warn', label: 'A window opened that may need you', store: null }));
  s = await state(page);
  check('... which still offers to show a window that may need the player', s.hint.startsWith('✕Show the window'), s.hint);
  // That window closes: ✕ goes back to the store app, which may still need the player.
  await emit(page, 'launch-step', step({ id: 'pc:2', key: 'window', state: 'ok', label: 'That window has closed', store: null }));
  s = await state(page);
  check('a window that closed is no longer offered, the store app is again', s.hint.startsWith('✕Open the store app'), s.hint);
  await page.keyboard.press('Escape');
  await idle(page);
  s = await state(page);
  check('... and still cancels', !s.overlay && JSON.stringify(s.lastCall) === '["launch_cancel",null]', JSON.stringify(s.lastCall));
  await close(page);
}

// 34. A launch's news that its game has the screen ends its starting screen there and then, so nothing of that launch
// is left to end the next one: the player starts another game straight away, or cancels during the fade and starts
// another, and that game's starting screen stays, with no black over it.
{
  const page = await open({ games: [game(1), game(2), game(3)] });
  const curtain = () => page.evaluate(() => document.body.classList.contains('curtain'));
  await page.keyboard.press('Enter');
  await idle(page);
  await emit(page, 'play', play('up', 'pc:1'));
  await running(page, 'pc:1');
  let s = await state(page);
  check('a game whose window has the screen ends its starting screen at once', !s.overlay, JSON.stringify(s.overlayTitle));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('another game started straight away shows its starting screen, not black', s.overlay && !(await curtain()), `${s.overlay} ${await curtain()}`);
  await page.keyboard.press('Escape');
  await idle(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await idle(page);
  await emit(page, 'play', play('up', 'pc:3'));
  await page.keyboard.press('Escape');
  await idle(page);
  check('cancelling during the fade lifts the black', !(await curtain()), String(await curtain()));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await idle(page);
  // The cancelled game's window still gets the screen behind Lamplit's.
  await running(page, 'pc:3');
  await page.waitForTimeout(2300);
  s = await state(page);
  check('the game started next keeps its starting screen, with no black over it', s.overlay && s.overlayTitle === 'Starting Game 002…' && !(await curtain()), `${s.overlay} ${s.overlayTitle} ${await curtain()}`);
  await close(page);
}

// 35. Back from a game (the dock's Home, or holding PS): the home screen comes forward under a veil in the game's
// colours, on the game's card, and the veil lifts as the screen settles in. A summon with no game running has none.
{
  const page = await open({ games: [game(1), game(2)] });
  await page.keyboard.press('ArrowRight');
  await running(page, 'pc:1');
  await page.evaluate(() => {
    window.__arrival = [];
    new MutationObserver(() => {
      const now = ['arriving', 'arrived'].filter((c) => document.body.classList.contains(c)).join(' ') || 'none';
      if (window.__arrival.at(-1) !== now) window.__arrival.push(now);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  });
  await emit(page, 'summoned', 'pc:1');
  await until(page, () => window.__arrival.includes('arrived') && window.__arrival.at(-1) === 'none' && window.__logs.some((l) => l.startsWith('info home: arrive')));
  let s = await state(page);
  let seen = await page.evaluate(() => window.__arrival.splice(0));
  const logged = await page.evaluate(() => window.__logs.filter((l) => l.startsWith('info home: arrive')));
  check("back from a game, a veil shows first, then lifts as the screen settles in, on the game's card, and the log says how it ran", JSON.stringify(seen) === '["arriving","arrived","none"]' && s.focusName === 'Game 001' && /frames, worst \d+ ms, 95% \d+ ms$/.test(logged[0] ?? ''), `${JSON.stringify(seen)} ${s.focusName} ${logged}`);
  await emit(page, 'play', play('ended', 'pc:1'));
  await emit(page, 'summoned', null);
  await page.waitForTimeout(100);
  seen = await page.evaluate(() => window.__arrival.splice(0));
  check('a summon with no game running comes without the veil', seen.every((c) => c === 'none'), JSON.stringify(seen));
  await close(page);
}

// 35b. Back from a game, the dock's window goes once the home screen has drawn, and Windows composes the screen anew:
// frames come late for a moment. The screen settles in only once they come on time again, under the veil, rather than
// starting on a late one.
{
  const page = await open({ games: [game(1), game(2)] });
  await page.keyboard.press('ArrowRight');
  await running(page, 'pc:1');
  const frames = page.evaluate(
    () =>
      new Promise((resolve) => {
        const seen = [];
        const start = performance.now();
        const step = () => {
          const told = window.__calls.some(([cmd]) => cmd === 'dock_home_drawn');
          seen.push({ at: performance.now(), told, arrived: document.body.classList.contains('arrived'), late: false });
          // One late frame, as soon as the dock is told to go.
          if (told && !seen.some((f) => f.late)) {
            seen.at(-1).late = true;
            const end = performance.now() + 40;
            while (performance.now() < end);
          }
          if (performance.now() - start < 900) requestAnimationFrame(step);
          else resolve(seen);
        };
        requestAnimationFrame(step);
      })
  );
  await emit(page, 'summoned', 'pc:1');
  const seen = await frames;
  const late = seen.findIndex((f) => f.late);
  const settled = seen.findIndex((f) => f.arrived);
  const after = settled > late + 1 ? seen[settled].at - seen[late + 1].at : 0;
  check('back from a game, the screen settles in once frames come on time after the dock goes, not on a late one', late >= 0 && settled > late + 2 && after >= 45, `late at frame ${late}, settled at ${settled}, ${Math.round(after)} ms after`);
  await close(page);
}

// 32. Holding PS while the screensaver shows only ends it, as any first press does: Rust sends `summoned` rather than
// a press, and the game menu open underneath stays open. A summon after the grace does what a summon does.
{
  const page = await open({ games: [game(1), game(2)], clock: true });
  await page.keyboard.press('i');
  await page.clock.fastForward('05:05');
  await saverOn(page);
  await emit(page, 'summoned', null);
  let v = await saverView(page);
  let s = await state(page);
  check('holding PS ends the screensaver and closes nothing underneath', !v.on && s.details, JSON.stringify({ on: v.on, menu: s.details }));
  await page.clock.runFor(600);
  await emit(page, 'summoned', null);
  s = await state(page);
  check('a summon after that closes the game menu, as before', !s.details, JSON.stringify({ menu: s.details }));
  await close(page);
}

// 35. The game menu at its fullest, on 1080p and 4K screens: a name over three lines, a game added by hand (Remove
// from Lamplit is one more choice), its warning, and an Xbox app's folder path. Every choice stays inside the panel,
// the panel stays clear of the hints, and the folder takes at most two lines, its own name on the second. Change art's
// panel, with its keyboard open, fits too.
for (const viewport of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
  const folder = '39C668CD.TombRaiderDefinitiveEdition_1.0.65.0_x64_WW_r7bfsmp40f67j';
  const tomb = game(1, {
    name: 'Tomb Raider: Definitive Edition Game of the Year Collectors Bundle',
    store: 'xbox',
    requires: ['xbox'],
    dir: `C:\\Program Files\\WindowsApps\\${folder}`,
    manual: true,
    last_played: 1761560000,
    play_minutes: 600,
  });
  const page = await open({ games: [tomb] }, viewport);
  const fit = (sheet, rows) =>
    page.evaluate(
      ([sheet, rows]) => {
        const box = (el) => el.getBoundingClientRect();
        const panel = box(document.getElementById(sheet));
        const last = box([...document.querySelectorAll(rows)].at(-1));
        const hints = box(document.getElementById('hint'));
        const dir = document.getElementById('dDir');
        const text = document.createRange();
        text.selectNodeContents(dir);
        return {
          inside: last.bottom <= panel.bottom && last.top >= panel.top,
          clear: panel.top >= innerHeight * 0.05 - 1 && panel.bottom <= hints.top,
          lines: new Set([...text.getClientRects()].map((r) => Math.round(r.top))).size,
          own: dir.lastElementChild?.textContent ?? '',
        };
      },
      [sheet, rows]
    );
  await page.keyboard.press('i');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await settled(page);
  let f = await fit('details', '#dChoices .row');
  const at = `${viewport.width}x${viewport.height}`;
  check(`${at}: every choice of the fullest game menu is inside its panel, clear of the hints`, f.inside && f.clear, JSON.stringify(f));
  check(`${at}: the folder takes at most two lines, its own name on the second`, f.lines <= 2 && f.own === folder, JSON.stringify(f));
  await page.screenshot({ path: path.join(shots, `menu-fullest-${viewport.width}.png`) });
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await idle(page);
  await page.keyboard.press('f');
  await settled(page);
  f = await fit('artPick', '#artKeys [data-id]');
  check(`${at}: Change art's keyboard is inside its panel, clear of the hints`, f.inside && f.clear, JSON.stringify(f));
  await close(page);
}

// 36. Show it now with a mouse (over Moonlight, say): the pointer that clicked moves a pixel or two while the
// screensaver gets its colours ready, and as the hand settles; that neither calls it off nor ends it. A real move,
// once the hand has settled, still ends it.
{
  const page = await open({ games: [game(1), game(2)], clock: true });
  // The art takes a moment to load, as it can on a TV PC, so the moves below come while the show gets ready.
  await page.route(`${assetOrigin}/**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fallback();
  });
  const focus = () => page.evaluate(() => document.querySelector('#settingsList .row.focus')?.textContent ?? '');
  await page.keyboard.press('c');
  await idle(page);
  for (let i = 0; i < 12 && !(await focus()).startsWith('Screensaver'); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await idle(page);
  const row = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#settingsList .row')].find((x) => x.textContent.startsWith('Show it now'));
    const b = r?.getBoundingClientRect();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  });
  await page.mouse.move(row.x, row.y);
  await page.waitForTimeout(100);
  // From the click on, the page's clock moves as the test says rather than with the runner, whose frames may come slow
  // (drawn in software): the moves after the click come while the hand settles (SETTLE_MS, screensaver/index.js),
  // however long the runner takes to make them, and the screensaver's frames come on time once it shows.
  await holdClock(page);
  await page.mouse.click(row.x, row.y);
  for (const [dx, dy] of [[1, 0], [2, 1], [3, 1], [2, 3]]) {
    await page.mouse.move(row.x + dx, row.y + dy);
    await page.waitForTimeout(60);
  }
  // The show starts once its colours are in, and fades in once its frames have come on time for 450 ms: 700 ms after
  // the click, still within the hand's second to settle.
  await page.waitForFunction(() => window.__logs.some((l) => l.includes('screensaver on')), null, { polling: 100, timeout: 20000 }).catch(() => {});
  await page.clock.runFor(700);
  let v = await saverView(page);
  check('Show it now starts though the pointer moves a pixel or two while it gets ready', v.on, JSON.stringify(v));
  await page.mouse.move(row.x + 14, row.y + 9);
  v = await saverView(page);
  check('the hand settling on the mouse right after the click leaves it on', v.on, JSON.stringify(v));
  // Over a second after the click: the hand has settled where it last moved to.
  await page.clock.runFor(500);
  await page.mouse.move(row.x + 16, row.y + 11);
  v = await saverView(page);
  check('a pixel or two once settled leaves it on', v.on, JSON.stringify(v));
  await page.mouse.move(row.x + 60, row.y + 40);
  v = await saverView(page);
  check('a real move of the mouse ends it', !v.on, JSON.stringify(v));
  await close(page);
}

// 37. Back to the game from the home screen, the reverse of the dock's Home: the home screen eases out under the veil in
// the game's colours, and only then does the game get the screen. Lamplit's window, behind the game, lets the veil go
// once the game has the foreground, or a while later if it never takes it. With reduced motion the game gets the
// screen at once.
{
  const page = await open({ games: [game(1), game(2)] });
  await running(page, 'pc:1');
  await page.evaluate(() => {
    window.__seen = [];
    const veil = () => (document.body.classList.contains('leaving') ? 'veiled' : 'bare');
    Object.assign((window.__settings ??= {}), { launch_resume: () => void window.__seen.push(`resume ${veil()}`) });
    // Only the veil's own changes, from what it last was: the body's other classes come and go at their own pace.
    let last = veil();
    new MutationObserver(() => {
      if (veil() === last) return;
      last = veil();
      window.__seen.push(last);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  });
  const seen = () => page.evaluate(() => window.__seen.splice(0));
  const resumed = () => until(page, () => window.__seen.some((s) => s.startsWith('resume')));
  await page.keyboard.press('Enter');
  await until(page, () => window.__seen.length);
  let s = await seen();
  check('back to the game: the home screen goes under the veil before the game gets the screen', JSON.stringify(s) === '["veiled"]', JSON.stringify(s));
  await resumed();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  s = await seen();
  check('... then the game gets the screen, and the veil goes once it has it', JSON.stringify(s) === '["resume veiled","bare"]', JSON.stringify(s));
  // Holding PS brings Lamplit back; this time the game never takes the screen.
  await emit(page, 'summoned', 'pc:1');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(700);
  await seen();
  await page.keyboard.press('Enter');
  await resumed();
  s = await seen();
  check('with reduced motion the game gets the screen at once, veiled', JSON.stringify(s) === '["veiled","resume veiled"]', JSON.stringify(s));
  await until(page, () => window.__seen.includes('bare'));
  s = await seen();
  check("a game that doesn't take the screen leaves the home screen as it was", JSON.stringify(s) === '["bare"]', JSON.stringify(s));
  await close(page);
}

// 37. The home screen keeps its first presses within a frame's work: the audio device starts in idle time after start,
// not inside the first sound; the accent colour comes from a small copy of the hero decoded off the main thread, not
// from drawing the hero; and the hero's drift holds still under a panel, whose blur over a moving hero is drawn again
// every frame.
{
  const watch = () => {
    window.__made = [];
    const Audio = window.AudioContext;
    window.AudioContext = class extends Audio {
      constructor(...args) {
        super(...args);
        window.__made.push('audio');
      }
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...rest) {
      if (source instanceof HTMLImageElement) window.__made.push(`drawn ${source.naturalWidth}x${source.naturalHeight}`);
      return draw.call(this, source, ...rest);
    };
  };
  const page = await open({ games: [game(1), game(2), game(3)], init: watch });
  await until(page, () => window.__made.includes('audio'));
  const ahead = await page.evaluate(() => [...window.__made]);
  check('the audio device starts after start, before the first press', JSON.stringify(ahead) === '["audio"]', JSON.stringify(ahead));
  // The next game's colour, worked out from its hero.
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  const made = await page.evaluate(() => [...window.__made]);
  check('the first sound starts no audio device, and no hero is drawn for its colour', JSON.stringify(made) === '["audio"]', JSON.stringify(made));
  const drift = () => page.evaluate(() => [...document.querySelectorAll('.hero')].map((h) => getComputedStyle(h).animationPlayState).join(' '));
  // Once the plate has grown or gone back: the drift holds only while it morphs (53).
  const morphed = () => until(page, () => !document.body.classList.contains('morphing'));
  await page.keyboard.press('c');
  await idle(page);
  await morphed();
  const settings = await drift();
  await page.keyboard.press('Escape');
  await idle(page);
  await morphed();
  const home = await drift();
  check('the hero keeps drifting under a panel, and after it closes', settings === 'running running' && home === 'running running', `${settings} / ${home}`);
  await close(page);
}

// 38. The screensaver's colours and art are read ahead, while nobody uses Lamplit for a moment, and kept: a second show
// reads no art file again.
{
  const page = await open({ games: [game(1), game(2)], clock: true });
  /** The art files the screensaver reads (the home screen's own images load as images, not with fetch). */
  const read = [];
  page.on('request', (r) => r.resourceType() === 'fetch' && r.url().startsWith(assetOrigin) && read.push(decodeURIComponent(r.url())));
  let reading = 0;
  const asset = (r) => r.resourceType() === 'fetch' && r.url().startsWith(assetOrigin);
  page.on('request', (r) => asset(r) && reading++);
  for (const done of ['requestfinished', 'requestfailed']) page.on(done, (r) => asset(r) && reading--);
  // The home screen reads the focused game's hero for its accent (library.js): that done, every read is the
  // screensaver's.
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--plate-light') !== '', null, { timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 300 && reading > 0; i++) await page.waitForTimeout(100);
  read.length = 0;
  const games = [game(1), game(2)];
  const files = games.flatMap((g) => [g.art.hero, g.art.portrait]).filter(Boolean);
  // What the warm-up reads: each art file the colours come from once, then each game's cover and hero image for the
  // show (saver.js makeArt), whatever has been read before.
  const reads = new Set(games.map((g) => g.art.hero || g.art.portrait)).size + games.filter((g) => g.art.portrait).length + Math.min(4, games.filter((g) => g.art.hero).length);
  await page.clock.fastForward('00:03');
  // Until it has read them all, however long a runner takes.
  for (let i = 0; i < 300 && !(read.length >= reads && reading === 0); i++) await page.waitForTimeout(100);
  let shown = await saverView(page);
  check(
    "two seconds without input, the next show's art and colours are read ahead, before it shows",
    !shown.on && read.length === reads && files.every((f) => read.some((u) => u.endsWith(f))),
    JSON.stringify({ files, reads, read: read.map((u) => u.split('/').slice(-2).join('/')) })
  );
  const before = read.length;
  await page.clock.fastForward('05:05');
  await saverOn(page);
  await page.keyboard.press('ArrowRight');
  await until(page, () => !document.querySelector('#saver.on'));
  await page.clock.fastForward('05:05');
  await saverOn(page);
  shown = await saverView(page);
  check('a second show reads no art again', shown.on && read.length === before, `${read.length - before} files read again`);
  await close(page);
}

// 39. Opening Settings > Screensaver gets the screensaver ready in idle time, a row before Show it now: its renderer,
// and its first frame drawn unseen, of the scene the show then opens on. A show and a warm-up close together make one
// renderer between them, and nothing is made while a game runs. The delay is Off here, so the warm-up after two quiet
// seconds stays out of it.
{
  const prefs = { ...ipc('prefs'), screensaver_minutes: 0 };
  /** A page whose WebGL renderers are counted. */
  const counted = async () => {
    const page = await open({ games: [game(1), game(2)], init: `window.__settings = ${JSON.stringify({ prefs_state: prefs })}` });
    await page.evaluate(() => {
      window.__renderers = 0;
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (type === 'webgl2') window.__renderers++;
        return get.call(this, type, ...rest);
      };
      // Draws, and those made while the screensaver isn't on yet but could be seen all the same: neither hidden nor
      // faint, as while it waits for its frames to come on time.
      window.__draws = 0;
      window.__seen = 0;
      for (const name of ['drawArrays', 'drawArraysInstanced']) {
        const draw = WebGL2RenderingContext.prototype[name];
        WebGL2RenderingContext.prototype[name] = function (...args) {
          window.__draws++;
          const root = document.getElementById('saver');
          const look = root && getComputedStyle(root);
          if (look && !root.classList.contains('on') && look.visibility !== 'hidden' && Number(look.opacity) > 0.004) window.__seen++;
          return draw.apply(this, args);
        };
      }
    });
    return page;
  };
  const renderers = (page) => page.evaluate(() => window.__renderers);
  const drawn = (page) =>
    page.evaluate(() => ({
      renderers: window.__renderers,
      draws: window.__draws,
      seen: window.__seen,
      shown: !!document.querySelector('#saver.on'),
      canvas: document.querySelector('#saver canvas')?.width ?? null,
    }));
  /** Opens Settings > Screensaver from the home screen or the list of sections. */
  const section = async (page) => {
    const focus = () => page.evaluate(() => document.querySelector('#settingsList .row.focus')?.textContent ?? '');
    if (!(await page.evaluate(() => document.getElementById('settings').classList.contains('on')))) await page.keyboard.press('c');
    for (let i = 0; i < 12 && !(await focus()).startsWith('Screensaver'); i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  };

  let page = await counted();
  await running(page, 'pc:1');
  await section(page);
  await page.waitForTimeout(500);
  let d = await drawn(page);
  check('Settings > Screensaver makes and draws nothing while a game runs', d.renderers === 0 && d.draws === 0, JSON.stringify(d));
  await emit(page, 'play', play('ended', 'pc:1'));
  await page.keyboard.press('Escape');
  await section(page);
  // Raymarched scenes compile slowly on a GPU that is emulated in software.
  await page.waitForFunction(() => window.__draws > 0, null, { timeout: 30000 }).catch(() => {});
  d = await drawn(page);
  check(
    'Settings > Screensaver makes the renderer and draws its first frame unseen, before Show it now, keeping no buffers',
    d.renderers === 1 && d.draws > 0 && d.seen === 0 && !d.shown && d.canvas === 1,
    JSON.stringify(d)
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await saverOn(page);
  const on = await page.evaluate(() => ({
    log: window.__logs.find((line) => line.includes('screensaver on')) ?? '',
    scene: document.getElementById('saver').dataset.scene,
  }));
  const opened = SCENES.find((x) => on.log.includes(`opening on ${x.name}, drawn ahead`));
  check(
    'Show it now then starts on that renderer, on the scene drawn ahead',
    (await renderers(page)) === 1 && opened?.id === on.scene,
    JSON.stringify({ ...on, renderers: await renderers(page) })
  );
  await close(page);

  // Show it now before the warm-up has had its idle time: the idle callbacks wait until the show is on.
  page = await counted();
  await page.evaluate(() => {
    const waiting = [];
    window.requestIdleCallback = (callback) => waiting.push(callback);
    window.__idle = () => waiting.splice(0).forEach((callback) => callback());
  });
  await section(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await saverOn(page);
  await page.evaluate(() => window.__idle());
  await page.waitForTimeout(300);
  d = await drawn(page);
  check('a show before the warm-up has run, and the warm-up after it, make one renderer', d.renderers === 1 && d.seen === 0, JSON.stringify(d));
  await close(page);
}

// 38. Find with every store fits the screen at 16:9 (1080p and 4K) and at 4:3: the keyboard, the line of field, chips
// and count, and the store list, which takes a second column past six stores, each store with its logo and the Amazon
// Games app with its name alone.
for (const [viewport, scale] of [[{ width: 1920, height: 1080 }, 1], [{ width: 2194, height: 1234 }, 1.75], [{ width: 1440, height: 1080 }, 1]]) {
  // In the order the list shows them (logic.js STORE_ORDER).
  const stores = ['steam', 'epic', 'ea', 'ubisoft', 'rockstar', 'battlenet', 'gog', 'amazon', 'itch', 'xbox', null];
  const games = stores.map((store, i) => game(i + 1, { store, requires: store ? [store] : [] }));
  const page = await open({ games, screen: viewport, scale }, viewport);
  await page.keyboard.press('f');
  await page.click('#findStore');
  await until(page, () => document.getElementById('findStores').classList.contains('on'));
  await settled(page);
  const f = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const inside = (el) => {
      const b = box(el);
      return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
    };
    const list = document.getElementById('findStores');
    const entries = [...list.querySelectorAll('.choice')];
    return {
      stores: entries.length,
      columns: new Set(entries.map((c) => Math.round(box(c).left))).size,
      fits: ['findPlate', 'findLine', 'findStores', 'findCount'].filter((id) => !inside(document.getElementById(id))),
      above: box(list).bottom <= box(document.getElementById('findStore')).top,
      logos: entries.map((c) => {
        const use = c.querySelector('svg.store-logo use');
        // A logo drawn from a symbol that isn't there would be an empty gap.
        return `${c.getAttribute('data-id')}=${use ? Boolean(document.querySelector(use.getAttribute('href') ?? '')) : 'none'}`;
      }),
    };
  });
  const at = `${viewport.width}x${viewport.height}`;
  check(
    `${at}: Find with every store fits the screen, the store list in two columns above its chip`,
    f.stores === 12 && f.columns === 2 && f.fits.length === 0 && f.above,
    JSON.stringify({ ...f, logos: undefined })
  );
  const expected = ['all=true', ...stores.map((s) => (s === 'amazon' || !s ? `${s ?? 'pc'}=none` : `${s}=true`))].map((s) => `store:${s}`);
  check(`${at}: each store has its logo, the Amazon Games app its name alone`, JSON.stringify(f.logos) === JSON.stringify(expected), JSON.stringify(f.logos));
  await page.screenshot({ path: path.join(shots, `find-stores-${at}.png`) });
  await close(page);
}

// 39. Add a game is a section pushed inside Settings' plate: one plate on screen the whole way, the two titles never
// shown at once, the plate widening from Settings' width to Add a game's, and Back popping to Settings on its row.
// From the empty home screen the plate grows out of the "No games found" line, and Back returns it there.
{
  const page = await open({ games: [game(1)] });
  await page.evaluate(() => (window.__settings = { library_programs: [] }));
  await page.keyboard.press('c');
  await idle(page);
  const k = await page.evaluate(() => [...document.querySelectorAll('#settingsList .row')].findIndex((r) => r.textContent.startsWith('Add a game')));
  for (let i = 0; i < k; i++) await page.keyboard.press('ArrowDown');
  await settled(page);
  /** Every frame for `ms` after `action` is pressed: the glass plates showing, and the titles' opacity on screen. */
  const watch = (action, ms) =>
    page.evaluate(
      async ([action, ms]) => {
        const seen = (el) => {
          let o = 1;
          for (let e = el; e && e !== document.body; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
          return o;
        };
        const frames = [];
        const t0 = performance.now();
        window.__emit('pad', action);
        while (performance.now() - t0 < ms) {
          await new Promise((r) => requestAnimationFrame(r));
          const plates = [...document.querySelectorAll('.panel')].filter((p) => parseFloat(getComputedStyle(p).opacity) > 0.01).length;
          const scrolled = document.getElementById('settings').scrollLeft;
          frames.push({ plates, scrolled, settings: seen(document.getElementById('settingsTitle')), add: seen(document.getElementById('addTitle')) });
        }
        return frames;
      },
      [action, ms]
    );
  const plate = () => page.evaluate(() => Math.round((document.getElementById('settings').getBoundingClientRect().width / innerWidth) * 100));
  let frames = await watch('ok', 500);
  await settled(page);
  let s = await state(page);
  check(
    'Add a game is pushed inside the Settings plate: one plate on screen, never both titles, the plate never scrolled',
    frames.every((f) => f.plates === 1 && f.scrolled === 0 && Math.min(f.settings, f.add) < 0.1) && (await page.evaluate(() => !!document.querySelector('#settings #add.on'))),
    JSON.stringify(frames.filter((f) => f.plates !== 1 || f.scrolled || Math.min(f.settings, f.add) >= 0.1).slice(0, 3))
  );
  check('... and the plate widens to Add a game\'s width', (await plate()) === 46, String(await plate()));
  frames = await watch('back', 500);
  await settled(page);
  s = await state(page);
  check(
    'Back pops to Settings in the same plate, narrowed, on Add a game',
    frames.every((f) => f.plates === 1 && Math.min(f.settings, f.add) < 0.1) && (await plate()) === 38 && s.hint.endsWith('Close') && (await page.evaluate(() => document.querySelector('#settingsList .row.focus')?.textContent.startsWith('Add a game'))),
    `${await plate()} ${s.hint} ${await page.evaluate(() => document.querySelector('#settingsList .row.focus')?.textContent)} ${JSON.stringify(frames.filter((f) => f.plates !== 1).slice(0, 2))}`
  );
  await close(page);
}
{
  const page = await open({ games: [] });
  await page.evaluate(() => (window.__settings = { library_programs: [] }));
  await until(page, () => document.getElementById('empty').textContent === 'No games found');
  /** The plate as it shows on screen: its box moved by its translate, cut by its clip. */
  const shown = () =>
    page.evaluate(() => {
      const plate = document.getElementById('settings');
      const box = plate.getBoundingClientRect();
      // inset() as written: one value for every side, two for top and bottom then the sides, and so on.
      const v = (getComputedStyle(plate).clipPath.match(/inset\(([^r)]*)/)?.[1] ?? '0px').trim().split(/\s+/).map(parseFloat);
      const inset = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
      const text = document.createRange();
      text.selectNodeContents(document.getElementById('empty'));
      const line = text.getBoundingClientRect();
      return {
        plate: [box.left + inset[3], box.top + inset[0], box.right - inset[1], box.bottom - inset[2]].map(Math.round),
        line: [line.left, line.top, line.right, line.bottom].map(Math.round),
        on: plate.classList.contains('on'),
      };
    });
  await page.evaluate(() => {
    window.__emit('pad', 'ok');
    for (const a of document.getAnimations()) if (a.effect?.target?.id === 'settings') a.pause();
  });
  let at = await shown();
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  check('from the empty home screen, the plate grows out of the "No games found" line', near(at.plate, at.line), JSON.stringify(at));
  await page.evaluate(() => document.getAnimations().forEach((a) => a.play()));
  await settled(page);
  const grown = await page.evaluate(() => Math.round((document.getElementById('settings').getBoundingClientRect().width / innerWidth) * 100));
  await emit(page, 'pad', 'back');
  await settled(page);
  at = await shown();
  check('... to Add a game\'s width, and Back returns it into the line', grown === 46 && near(at.plate, at.line) && !at.on, JSON.stringify({ grown, ...at }));
  await close(page);
}

// 40. Reduce Motion: Settings, Find, Add a game and the toast fade in place for 150 ms instead of sliding, Add a game
// takes its width at once with the faces fading where they are, the plate doesn't grow from the empty screen's line,
// and the covers move without overshoot and don't bump at the end of the row.
{
  const page = await open({ games: [game(1), game(2)] });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => (window.__settings = { library_programs: [] }));
  /** Every frame for `ms` after `run` (in the page): what moves on `selector`, and its transition. */
  const watch = (run, selector, ms = 300) =>
    page.evaluate(
      async ([run, selector, ms]) => {
        const frames = [];
        const t0 = performance.now();
        new Function(run)();
        while (performance.now() - t0 < ms) {
          await new Promise((r) => requestAnimationFrame(r));
          const els = [...document.querySelectorAll(selector)];
          frames.push(els.map((el) => {
            const st = getComputedStyle(el);
            const ms = (v) => parseFloat(v) * (v.endsWith('ms') ? 1 : 1000);
            return { el: el.id, place: `${st.transform} ${st.translate}`, clip: st.clipPath, fade: ms(st.transitionDuration.split(',')[0]) + ms(st.transitionDelay.split(',')[0]) };
          }));
        }
        return frames.flat();
      },
      [run, selector, ms]
    );
  /** Nothing moves: each element keeps one place on every frame, unclipped, and has faded within 150 ms. */
  const still = (frames) =>
    frames.every((f) => f.place === frames.find((g) => g.el === f.el).place && f.clip === 'none' && f.fade > 0 && f.fade <= 150);
  let f = await watch("window.__emit('pad', 'triangle')", '#settings');
  check('Reduce Motion: Settings fades in place for 150 ms', still(f), JSON.stringify(f.slice(0, 3)));
  await settled(page);
  const k = await page.evaluate(() => [...document.querySelectorAll('#settingsList .row')].findIndex((r) => r.textContent.startsWith('Add a game')));
  for (let i = 0; i < k; i++) await emit(page, 'pad', 'down');
  await settled(page);
  f = await watch("window.__emit('pad', 'ok')", '#settings, #settingsFace, #add');
  const wide = await page.evaluate(() => Math.round((document.getElementById('settings').getBoundingClientRect().width / innerWidth) * 100));
  check('... Add a game takes its width at once, its faces fading where they are', still(f) && wide === 46, `${wide} ${JSON.stringify(f.filter((x) => !still([x])).slice(0, 3))}`);
  await emit(page, 'pad', 'back');
  await settled(page);
  await emit(page, 'pad', 'back');
  await settled(page);
  f = await watch("window.__emit('pad', 'square')", '#findPlate, #findLine');
  check('... Find fades in place for 150 ms', still(f), JSON.stringify(f.slice(0, 3)));
  await emit(page, 'pad', 'back');
  await settled(page);
  f = await watch("window.__emit('notice', 'Hello')", '#toast');
  check('... a message fades in place for 150 ms', still(f), JSON.stringify(f.slice(0, 3)));
  f = await watch("import('./hints.js').then((m) => m.toast('About a game', { game: { id: 'pc:1', name: 'Game 001' } }))", '#gameNews');
  check("... and so does one about a game, on the line above the row", still(f), JSON.stringify(f.slice(0, 3)));
  const covers = await page.evaluate(() => {
    const ease = getComputedStyle(document.querySelector('.cover')).transitionTimingFunction;
    // A cubic-bezier with a y beyond 0 to 1 overshoots.
    return { ease, overshoot: [...ease.matchAll(/cubic-bezier\(([^)]*)\)/g)].some((m) => m[1].split(',').map(Number).some((v, i) => i % 2 === 1 && (v > 1 || v < 0))) };
  });
  await emit(page, 'pad', 'left');
  const bumps = await page.evaluate(() => document.querySelector('.cover.focus').getAnimations().filter((a) => !('transitionProperty' in a)).length);
  check('... the covers move without overshoot, and the end of the row doesn\'t bump', !covers.overshoot && bumps === 0, JSON.stringify({ ...covers, bumps }));
  await close(page);
}
{
  const page = await open({ games: [] });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => (window.__settings = { library_programs: [] }));
  await until(page, () => document.getElementById('empty').textContent === 'No games found');
  const grows = await page.evaluate(() => {
    window.__emit('pad', 'ok');
    return document.getAnimations().filter((a) => a.effect?.target?.id === 'settings' && !('transitionProperty' in a)).length;
  });
  await settled(page);
  const at = await page.evaluate(() => ({ translate: getComputedStyle(document.getElementById('settings')).translate, on: document.getElementById('settings').classList.contains('on') }));
  check('Reduce Motion: from the empty home screen the plate fades in at its place', grows === 0 && at.on && at.translate === 'none', JSON.stringify({ grows, ...at }));
  await close(page);
}

// 41. One set of named springs for both pages (springs.js): the page's CSS has each of them, a step along the row moves
// the covers on snap, which shows no overshoot, Change art's tiles too; Settings, Find and the toast open on tap and go
// on close; the card lifts on lift and lowers on close.
{
  const page = await open({ games: [game(1), game(2), game(3)] });
  await page.evaluate(() => (window.__settings = { library_programs: [] }));
  /** The timing function and duration `selector` has for `prop` now. */
  const curve = (selector, prop = 'transform') =>
    page.evaluate(
      ([selector, prop]) => {
        const st = getComputedStyle(document.querySelector(selector));
        const i = st.transitionProperty.split(', ').indexOf(prop);
        const fns = st.transitionTimingFunction.match(/(linear|cubic-bezier|steps)\([^)]*\)|ease(-in-out|-in|-out)?|linear|step-start|step-end/g);
        const ms = (v) => parseFloat(v) * (v.endsWith('ms') ? 1 : 1000);
        return { fn: fns[i] ?? null, ms: Math.round(ms(st.transitionDuration.split(', ')[i] ?? '0s')) };
      },
      [selector, prop]
    );
  /** Which named spring a timing function and duration are, or what they are. Tap and close share a shape, critically
   * damped both, and differ in how long they take. */
  const named = ({ fn, ms }) => {
    const stops = fn?.match(/^linear\((.*)\)$/)?.[1].split(',').map((v) => parseFloat(v));
    return Object.keys(SPRINGS).find((n) => JSON.stringify(stops) === JSON.stringify(SPRINGS[n].points) && ms === SPRINGS[n].ms) ?? `${fn} ${ms}ms`;
  };
  const vars = await page.evaluate(() => ['tap', 'lift', 'snap', 'close'].map((n) => getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim()));
  check('the page has the springs both pages share', vars.every((v, i) => v === SPRINGS[['tap', 'lift', 'snap', 'close'][i]].easing), vars.map((v) => v.slice(0, 30)).join(' | '));
  const seen = { step: named(await curve('.cover')), toastGoes: named(await curve('#toast', 'translate')), cardLowers: named(await curve('#card')) };
  // Settings grows out of the status capsule and goes back into it (morph.js): the springs of those.
  const morphed = (pad) =>
    page.evaluate((pad) => {
      window.__emit('pad', pad);
      const a = document.getElementById('settings').getAnimations().find((x) => !('transitionProperty' in x));
      return { fn: a?.effect.getTiming().easing ?? null, ms: a?.effect.getTiming().duration ?? 0 };
    }, pad);
  seen.settingsOpens = named(await morphed('triangle'));
  await settled(page);
  seen.settingsGoes = named(await morphed('back'));
  await settled(page);
  await page.evaluate(() => window.__emit('notice', 'Hello'));
  seen.toastOpens = named(await curve('#toast', 'translate'));
  await emit(page, 'pad', 'menu');
  await settled(page);
  seen.cardLifts = named(await curve('#lift.on #card'));
  const want = { step: 'snap', toastGoes: 'close', cardLowers: 'close', settingsOpens: 'tap', settingsGoes: 'close', toastOpens: 'tap', cardLifts: 'lift' };
  const wrong = Object.keys(want).filter((k) => seen[k] !== want[k]);
  check('... a step on snap, panels and the toast open on tap and go on close, the card lifts on lift and lowers on close', wrong.length === 0, JSON.stringify(Object.fromEntries(wrong.map((k) => [k, String(seen[k]).slice(0, 40)]))));
  const tiles = await page.evaluate(() => [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r.selectorText === '.tile .art').map((r) => r.style.transition));
  check('... Change art\'s tiles move on snap, nothing on the overshooting curve', tiles.length === 1 && tiles[0].includes('var(--snap)') && !(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--spring'))), JSON.stringify(tiles));
  await close(page);
}

// 42. One stroked icon file for both pages (icons.js): the home screen draws every icon from it, its hints, Find's
// field and Add a game's rows among them, and keeps only the store logos as its own.
{
  const page = await open({ games: [game(1), game(2)] });
  await page.evaluate(() => (window.__settings = { library_programs: [] }));
  /** Every <use> on the page now: where its symbol comes from, and how it is drawn. */
  const uses = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('use')].map((u) => {
        const id = u.getAttribute('href').slice(1);
        const symbol = document.getElementById(id);
        const from = symbol?.closest('svg')?.id === 'icons' ? 'shared' : id.startsWith('store-') && symbol ? 'store' : 'missing';
        return { id, from, stroke: symbol?.querySelector('g')?.getAttribute('stroke-width') ?? null };
      })
    );
  const seen = await uses();
  await emit(page, 'pad', 'square');
  await settled(page);
  seen.push(...(await uses()));
  await emit(page, 'pad', 'back');
  await settled(page);
  await emit(page, 'pad', 'triangle');
  await settled(page);
  const k = await page.evaluate(() => [...document.querySelectorAll('#settingsList .row')].findIndex((r) => r.textContent.startsWith('Add a game')));
  for (let i = 0; i < k; i++) await emit(page, 'pad', 'down');
  await emit(page, 'pad', 'ok');
  await settled(page);
  seen.push(...(await uses()));
  const ids = [...new Set(seen.map((u) => u.id))];
  const wrong = seen.filter((u) => u.from === 'missing' || (u.from === 'shared' && !u.stroke && !['i-play', 'i-star-on', 'i-quiet-on'].includes(u.id)));
  const own = await page.evaluate(() => [...document.querySelectorAll('symbol')].filter((s) => s.closest('svg').id !== 'icons').map((s) => s.id).filter((id) => !id.startsWith('store-')));
  check('the home screen draws its icons from the shared file, stroked', wrong.length === 0 && ['i-search', 'i-drive', 'btn-cross', 'btn-circle'].every((id) => ids.includes(id)), JSON.stringify({ wrong, ids }));
  check('... and keeps only the store logos as its own', own.length === 0 && (await page.evaluate(() => document.querySelectorAll('#icons').length)) === 1, own.join(', '));
  await close(page);
}

// 43. One glass for every plate (plate.css): Settings, Find, and the game menu with Change art have the same fill, rim,
// shadow and corners, and the fill is more opaque over brighter art. Messages are pills on the same glass.
{
  const page = await open({ games: [game(1), game(2, { noArt: true })] });
  const looks = () =>
    page.evaluate(() =>
      ['#settings', '#findPlate', '#sheet'].map((sel) => {
        const st = getComputedStyle(document.querySelector(sel));
        return { sel, fill: st.backgroundColor, shadow: st.boxShadow, round: st.borderTopLeftRadius, border: st.borderTopWidth };
      })
    );
  const light = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--plate-light').trim());
  // The first game's hero is sampled: its brightness is the plate's light.
  await until(page, () => document.documentElement.style.getPropertyValue('--plate-light') !== '');
  const lit = { light: await light(), looks: await looks() };
  const same = (l) => l.every((x) => ['fill', 'shadow', 'round'].every((k) => x[k] === l[0][k]) && x.border === '0px' && x.shadow.includes('inset'));
  check('every plate has one glass: fill, rim, shadow and corners', same(lit.looks), JSON.stringify(lit.looks.filter((x) => !same([lit.looks[0], x]))));
  await emit(page, 'pad', 'right');
  await until(page, () => document.documentElement.style.getPropertyValue('--plate-light') === '0');
  const dark = { light: await light(), looks: await looks() };
  const alpha = (c) => Number(c.match(/rgba?\([^)]*[,/]\s*([\d.]+)\)/)?.[1] ?? 1);
  const [a, b] = [alpha(lit.looks[0].fill), alpha(dark.looks[0].fill)];
  check(
    '... its fill more opaque over brighter art',
    Number(lit.light) > 0.2 && Math.abs(a - (0.7 + 0.22 * Number(lit.light))) < 0.01 && Math.abs(b - 0.7) < 0.01 && same(dark.looks),
    JSON.stringify({ lit: lit.light, dark: dark.light, a, b })
  );
  await close(page);
}

// 44. The focus ring, hold to confirm and the pill, generalised from the dock's for both pages (ring.js, hold.js,
// pill.js): the ring springs from one target to the next on snap and ends on the new one's box and corners, and with
// Reduce Motion is there at once; a hold fills its ring and acts once full, and let go early never acts; a pill is the
// plate's glass round its icon's badge and its text.
{
  const page = await open({ games: [game(1)] });
  const ring = (reduce) =>
    page.evaluate(async (reduce) => {
      const { focusRing } = await import('./ring.js');
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const layer = document.createElement('div');
      layer.style.cssText = 'position: fixed; left: 100px; top: 100px; width: 600px; height: 300px; z-index: 9';
      const a = document.createElement('div');
      a.style.cssText = 'position: absolute; left: 10px; top: 20px; width: 100px; height: 40px; border-radius: 8px';
      const b = document.createElement('div');
      b.style.cssText = 'position: absolute; left: 300px; top: 200px; width: 160px; height: 60px; border-radius: 20px';
      layer.append(a, b);
      document.body.append(layer);
      const r = focusRing(layer);
      const box = () => {
        const o = r.el.getBoundingClientRect();
        return { x: Math.round(o.x - 100), y: Math.round(o.y - 100), w: Math.round(o.width), h: Math.round(o.height) };
      };
      r.move(a);
      for (let i = 0; i < 4; i++) await frame();
      const atA = box();
      r.move(b);
      const way = [];
      for (let i = 0; i < 45; i++) {
        await frame();
        way.push(box());
      }
      const st = getComputedStyle(r.el);
      const out = { atA, between: way.filter((p) => p.x > 12 && p.x < 298).length, end: way.at(-1), round: st.borderTopLeftRadius, on: r.el.classList.contains('on'), ease: st.transitionTimingFunction.split(', linear(')[0], reduce };
      layer.remove();
      return out;
    }, reduce);
  let r = await ring(false);
  const snapStops = (fn) => fn.match(/^linear\((.*)/)?.[1].split(',').slice(0, 4).map((v) => parseFloat(v));
  check(
    'the focus ring springs from one target to the next on snap, and ends on its box and corners',
    JSON.stringify(r.atA) === JSON.stringify({ x: 10, y: 20, w: 100, h: 40 }) && r.between >= 3 && JSON.stringify(r.end) === JSON.stringify({ x: 300, y: 200, w: 160, h: 60 }) && r.round === '20px' && r.on && JSON.stringify(snapStops(r.ease)) === JSON.stringify(SPRINGS.snap.points.slice(0, 4)),
    JSON.stringify(r)
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  r = await ring(true);
  check('... with Reduce Motion it is on the next one at once', r.between === 0 && JSON.stringify(r.end) === JSON.stringify({ x: 300, y: 200, w: 160, h: 60 }), JSON.stringify(r));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const held = await page.evaluate(async () => {
    const { hold, holdRing } = await import('./hold.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const el = document.createElement('div');
    el.append(holdRing());
    document.body.append(el);
    // On screen a frame or two before the button goes down, as an action's row is.
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
    let acted = 0;
    const fill = () => parseFloat(getComputedStyle(el.querySelector('.fill')).strokeDashoffset);
    // Let go once the ring has started to fill, well before the second it takes, however slowly the frames come.
    const letGo = hold(el, () => acted++, 1000);
    let filling = fill();
    for (const end = performance.now() + 700; !(filling < 95) && performance.now() < end; filling = fill()) await wait(10);
    letGo();
    await wait(1200);
    const early = acted;
    const after = el.classList.contains('holding');
    hold(el, () => acted++, 300);
    for (const end = performance.now() + 3000; acted < 1 && performance.now() < end; ) await wait(20);
    el.remove();
    return { filling, early, after, full: acted, holding: el.classList.contains('holding') };
  });
  check('a hold fills its ring and acts once full; let go early, it never acts', held.filling > 5 && held.filling < 95 && held.early === 0 && !held.after && held.full === 1 && !held.holding, JSON.stringify(held));
  const pill = await page.evaluate(async () => {
    const { fillPill } = await import('./pill.js');
    const el = document.createElement('div');
    document.body.append(el);
    fillPill(el, { icon: 'i-warn', text: 'Controller battery low', warn: true });
    const st = getComputedStyle(el);
    const href = el.querySelector('.badge use').getAttribute('href');
    const out = {
      href,
      drawn: document.querySelector(href)?.closest('svg')?.id,
      text: el.querySelector('.text').textContent,
      warn: el.classList.contains('warn'),
      round: Math.abs(parseFloat(st.borderTopLeftRadius) - el.offsetHeight / 2) < 0.5,
      glass: st.backgroundColor === getComputedStyle(document.getElementById('settings')).backgroundColor && st.boxShadow.includes('inset'),
    };
    el.remove();
    return out;
  });
  check("a pill is the plate's glass round its icon's badge and its text", pill.drawn === 'icons' && pill.text === 'Controller battery low' && pill.warn && pill.round && pill.glass, JSON.stringify(pill));
  await close(page);
}

// 45. A game's menu is one plate that grows out of the card's edge: a sliver on the card's side, 8vh shorter than the
// card, that widens to the menu on the tap spring, its rows fading in from 45% of the way. One line under the name,
// the folder dim at the bottom, Play lit and focused first, every row with its icon from the shared set, Favourite one
// row that switches its star. Change art is the same plate: it grows from the menu's size to its own while the menu
// stays where it was, and the card cross-fades as focus moves through the covers. With Reduce Motion it all fades in
// place.
{
  const page = await open({ games: [game(1, { last_played: Math.floor(Date.now() / 1000) - 86400, play_minutes: 1860 }), game(2), game(3)] });
  await page.evaluate((files) => (window.__settings = { library_art_search: files.map((portrait, i) => ({ appid: i + 1, name: `Match ${i + 1}`, portrait })) }), [art[0].portrait, art[0].hero, null]);
  /** What shows of a plate: its box, less its clip, moved by its translate. */
  const shown = (sel) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const v = (st.clipPath.match(/inset\(([^)]*?)(?: round|\))/)?.[1] ?? '0px').split(' ').map(parseFloat);
      const [t, ri, b, l] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
      // The box has the translate in it already.
      return [r.left + l, r.top + t, r.right - ri, r.bottom - b].map(Math.round);
    }, sel);
  // The grow, stopped where it starts.
  const start = await page.evaluate(() => {
    window.__emit('pad', 'menu');
    const grow = document.getElementById('sheet').getAnimations().find((a) => !('transitionProperty' in a));
    grow.pause();
    grow.currentTime = grow.effect.getTiming().delay;
    const card = document.getElementById('card');
    const c = { left: card.offsetLeft, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight };
    const row = getComputedStyle(document.getElementById('details'));
    return { card: [c.left, c.top, c.left + c.width, c.top + c.height].map(Math.round), delay: grow.effect.getTiming().delay, ms: grow.effect.getTiming().duration, rowsAfter: parseFloat(row.transitionDelay) * (row.transitionDelay.endsWith('ms') ? 1 : 1000) };
  });
  const sliver = await shown('#sheet');
  const vh = 1080 / 100;
  check(
    'the menu grows out of a sliver on the card\'s edge, 8vh shorter than the card, once the card is most of the way up',
    Math.abs((sliver[0] + sliver[2]) / 2 - start.card[2]) <= 2 && Math.abs(sliver[2] - sliver[0] - 3 * vh) <= 2 && Math.abs(sliver[1] - (start.card[1] + 4 * vh)) <= 2 && Math.abs(sliver[3] - (start.card[3] - 4 * vh)) <= 2 && start.delay > 0,
    JSON.stringify({ sliver, ...start })
  );
  check('... on the tap spring, its rows fading in from 45% of the way', start.ms === SPRINGS.tap.ms && Math.abs(start.rowsAfter - (start.delay + 0.45 * SPRINGS.tap.ms)) <= 1, JSON.stringify(start));
  await page.evaluate(() => document.getElementById('sheet').getAnimations().forEach((a) => a.finish()));
  await settled(page);
  const menu = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#dChoices .row')];
    const box = (el) => el.getBoundingClientRect();
    return {
      plates: [...document.querySelectorAll('#lift aside, #lift section')].map((e) => e.id).join(),
      line: document.getElementById('dMeta').innerText.replace(/\s+/g, ' '),
      folderBelow: box(document.getElementById('dDir')).top >= box(rows.at(-1)).bottom,
      folderDim: getComputedStyle(document.getElementById('dDir')).color === getComputedStyle(document.documentElement).getPropertyValue('--ink-dim').trim().replace(/\s/g, '') || getComputedStyle(document.getElementById('dDir')).color !== getComputedStyle(document.getElementById('dName')).color,
      icons: rows.map((r) => r.querySelector('use')?.getAttribute('href')).join(),
      shared: rows.every((r) => document.querySelector(r.querySelector('use').getAttribute('href'))?.closest('svg')?.id === 'icons'),
      first: rows[0].classList.contains('primary') && rows[0].classList.contains('focus') && rows[0].textContent === 'Play',
      lit: getComputedStyle(rows[0]).backgroundImage.includes('gradient') && !getComputedStyle(rows[1]).backgroundImage.includes('gradient'),
    };
  });
  check('one plate holds the menu and Change art', menu.plates === 'sheet,details,artPick', menu.plates);
  check('... one line under the name, the folder dim at the bottom', /^[^·]+ · Played yesterday · 31 h$/.test(menu.line) && menu.folderBelow && menu.folderDim, JSON.stringify(menu));
  check('... Play lit and focused first, every row with its icon from the shared set', menu.first && menu.lit && menu.shared && menu.icons === '#i-play,#i-star,#i-photo,#i-eye-off', JSON.stringify(menu));
  await page.evaluate((list) => {
    window.__settings.library_set_favourite = ({ id, on }) => list.map((g) => (g.id === id ? { ...g, favourite: on } : g));
  }, await page.evaluate(() => window.__state?.games ?? null) ?? [game(1, { last_played: 0 }), game(2), game(3)]);
  await emit(page, 'pad', 'down');
  await emit(page, 'pad', 'ok');
  await idle(page);
  const star = await page.evaluate(() => {
    const row = document.querySelector('#dChoices .row.focus');
    return { label: row.textContent, star: row.querySelector('use').getAttribute('href'), pressed: row.getAttribute('aria-pressed') };
  });
  check('... Favourite is one row that fills its star', JSON.stringify(star) === JSON.stringify({ label: 'Favourite', star: '#i-star-on', pressed: 'true' }), JSON.stringify(star));
  // Change art: the plate's clip starts at the menu's box, the menu where it was.
  await emit(page, 'pad', 'down');
  await settled(page);
  const before = await page.evaluate(() => {
    const r = document.getElementById('sheet').getBoundingClientRect();
    const m = document.getElementById('details').getBoundingClientRect();
    return { plate: [r.left, r.top, r.right, r.bottom].map(Math.round), menu: [m.left, m.top, m.right, m.bottom].map(Math.round) };
  });
  const turn = await page.evaluate(() => {
    window.__emit('pad', 'ok');
    const grow = document.getElementById('sheet').getAnimations().find((a) => !('transitionProperty' in a));
    grow.pause();
    const m = document.getElementById('details').getBoundingClientRect();
    return { name: !!grow, menu: [m.left, m.top, m.right, m.bottom].map(Math.round), on: document.getElementById('artPick').classList.contains('on') };
  });
  const clipAt = await shown('#sheet');
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  check("Change art grows the same plate from the menu's size, the menu staying where it was", turn.on && near(clipAt, before.plate) && near(turn.menu, before.menu), JSON.stringify({ before, turn, clipAt }));
  await page.evaluate(() => document.getElementById('sheet').getAnimations().forEach((a) => a.finish()));
  await settled(page);
  const own = await page.evaluate(() => {
    const p = document.getElementById('sheet').getBoundingClientRect();
    const a = document.getElementById('artPick').getBoundingClientRect();
    return [Math.round(p.width - a.width), Math.round(p.height - a.height)];
  });
  check('... to its own size', own[0] === 0 && Math.abs(own[1]) <= 1, JSON.stringify(own));
  await until(page, () => document.querySelectorAll('#artTiles .tile').length === 3);
  const fade = await page.evaluate(() => {
    window.__emit('pad', 'right');
    const was = document.querySelector('#face .was');
    return { was: !!was, fading: was?.getAnimations().length === 1 };
  });
  check('... and the card cross-fades as focus moves through the covers', fade.was && fade.fading, JSON.stringify(fade));
  await close(page);
}
{
  const page = await open({ games: [game(1), game(2)] });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const moves = await page.evaluate(() => {
    window.__emit('pad', 'menu');
    return document.getElementById('sheet').getAnimations().filter((a) => !('transitionProperty' in a)).length;
  });
  await settled(page);
  const fades = await page.evaluate(() =>
    ['#sheet', '#details'].map((sel) => {
      const st = getComputedStyle(document.querySelector(sel));
      const ms = (v) => parseFloat(v) * (v.endsWith('ms') ? 1 : 1000);
      return ms(st.transitionDuration.split(',')[0]) + ms(st.transitionDelay.split(',')[0]);
    })
  );
  check('Reduce Motion: the menu fades in beside the card, no grow', moves === 0 && fades.every((f) => f > 0 && f <= 150), JSON.stringify({ moves, fades }));
  await close(page);
}

// 46. The dock's hold for every action on the home screen that can't be taken back: Close game in the menu of the
// running game (when Lamplit knows its programs) says what it closes and asks the game once Cross has been held, then
// hands it the screen to answer; let go early, nothing. With the mouse a hold runs from button down to button up.
{
  const page = await open({ games: [game(1), game(2)], running: 'pc:1' });
  const reading = like(ipc('dock-game'), { id: 'pc:1', name: 'Game 001', closable: true, force_close: false, responding: true, session: 7 });
  await page.evaluate((reading) => (window.__settings = { dock_state: reading }), reading);
  const menu = () =>
    page.evaluate(() => ({
      rows: [...document.querySelectorAll('#dChoices .row')].map((r) => [r.querySelector('.label').firstChild.textContent, r.querySelector('.note')?.textContent ?? '', r.querySelector('use').getAttribute('href'), !!r.querySelector('.hold')]),
      focus: document.querySelector('#dChoices .row.focus .label')?.firstChild.textContent,
      holding: !!document.querySelector('#dChoices .row.holding'),
      hint: document.getElementById('hint').textContent,
      calls: window.__calls.map((c) => JSON.stringify(c)),
    }));
  await emit(page, 'pad', 'menu');
  await until(page, () => [...document.querySelectorAll('#dChoices .row')].some((r) => r.textContent.startsWith('Close game')));
  let m = await menu();
  check(
    'the running game\'s menu offers Close game, held, saying what it closes, with its own icon',
    JSON.stringify(m.rows.at(-1)) === JSON.stringify(['Close game', 'Closes Game 001', '#i-close-game', true]) && m.rows.filter((r) => r[3]).length === 1,
    JSON.stringify(m.rows)
  );
  for (let i = 0; i < 4; i++) await emit(page, 'pad', 'down');
  m = await menu();
  check('... its hint says to hold', m.focus === 'Close game' && m.hint.includes('Hold to close game'), m.hint);
  const before = m.calls.length;
  await emit(page, 'pad', 'ok');
  await page.waitForTimeout(300);
  m = await menu();
  const filling = m.holding;
  await emit(page, 'pad', 'ok-up');
  await page.waitForTimeout(900);
  m = await menu();
  check('... Cross let go before the ring is full closes nothing', filling && !m.holding && !m.calls.slice(before).some((c) => c.includes('dock_close_game')), JSON.stringify(m.calls.slice(before)));
  await emit(page, 'pad', 'ok');
  await until(page, () => window.__calls.some((c) => c[0] === 'dock_close_game') && window.__calls.some((c) => c[0] === 'launch_resume'));
  m = await menu();
  const asked = m.calls.slice(before).filter((c) => c.includes('dock_close_game'));
  check('... held, it asks the game Lamplit read to close, and gives it the screen to answer', JSON.stringify(asked) === JSON.stringify([JSON.stringify(['dock_close_game', { force: false, id: 'pc:1', session: 7 }])]), JSON.stringify(m.calls.slice(before)));
  await close(page);
}
{
  // A game whose programs Lamplit can't tell has no Close game.
  const page = await open({ games: [game(1)], running: 'pc:1' });
  await page.evaluate((reading) => (window.__settings = { dock_state: reading }), like(ipc('dock-game'), { id: 'pc:1', closable: false, force_close: false }));
  await emit(page, 'pad', 'menu');
  await idle(page);
  await page.waitForTimeout(200);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#dChoices .row')].map((r) => r.querySelector('.label').firstChild.textContent));
  check("... not when Lamplit can't tell which programs are the game's", !rows.includes('Close game') && rows[0] === 'Back to game', JSON.stringify(rows));
  await close(page);
}
{
  const page = await open({ games: [game(1, { manual: true })] });
  await page.evaluate(() => (window.__settings = { library_remove_game: () => [] }));
  await emit(page, 'pad', 'menu');
  await until(page, () => document.getElementById('details').classList.contains('on'));
  await settled(page);
  const at = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#dChoices .row')].at(-1).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const removes = () => page.evaluate(() => window.__calls.filter((c) => c[0] === 'library_remove_game').length);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(900);
  const early = await removes();
  await page.mouse.down();
  await until(page, () => window.__calls.some((c) => c[0] === 'library_remove_game'));
  await page.mouse.up();
  await idle(page);
  check('with the mouse, Remove is held from button down to button up', early === 0 && (await removes()) === 1, `${early}`);
  await close(page);
}

// 47. The status capsule replaces the bare clock: the batteries, the volume, quiet mode and the time, as the dock's
// chips, on the plate's glass. Settings grows down out of it, which stays as its header, and goes back into it; the
// plate's height follows what it holds, sections push inside it with their icons, and with Reduce Motion it all
// fades in place.
{
  const page = await open({ games: [game(1), game(2)] });
  await page.evaluate(
    ([accessories, sound, quiet]) => (window.__settings = { accessories_state: accessories, sound_state: sound, quiet_state: quiet }),
    [ipc('accessories'), like(ipc('sound'), { volume: 45, muted: false }), like(ipc('quiet'), { active: true })]
  );
  // Read again as Rust says the accessories changed.
  await emit(page, 'accessories', null);
  await until(page, () => document.querySelectorAll('#chips .chip').length === 5);
  const capsule = await page.evaluate(() => {
    const st = getComputedStyle(document.getElementById('status'));
    return {
      chips: [...document.querySelectorAll('#chips .chip')].map((c) => [c.querySelector('use')?.getAttribute('href'), c.textContent]),
      clock: /^\d\d:\d\d$/.test(document.getElementById('clock').textContent),
      glass: st.backgroundColor === getComputedStyle(document.getElementById('settings')).backgroundColor && st.boxShadow.includes('inset'),
      oldClock: !!document.querySelector('body > #clock'),
    };
  });
  check(
    'the status capsule shows the batteries, the volume, quiet mode and the time, on the plate\'s glass',
    JSON.stringify(capsule.chips) === JSON.stringify([['#i-controller', '60%'], ['#i-controller', 'Medium'], ['#i-headset', '80%'], ['#i-volume', '45%'], ['#i-quiet-on', '']]) && capsule.clock && capsule.glass && !capsule.oldClock,
    JSON.stringify(capsule)
  );
  /** What shows of the plate: its box, less its clip. */
  const shown = () =>
    page.evaluate(() => {
      const el = document.getElementById('settings');
      const r = el.getBoundingClientRect();
      const v = (getComputedStyle(el).clipPath.match(/inset\(([^)]*?)(?: round|\))/)?.[1] ?? '0px').split(' ').map(parseFloat);
      const [t, ri, b, l] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
      return [r.left + l, r.top + t, r.right - ri, r.bottom - b].map(Math.round);
    });
  const box = (sel) =>
    page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return [r.left, r.top, r.right, r.bottom].map(Math.round);
    }, sel);
  const at = await box('#status');
  await page.evaluate(() => {
    window.__emit('pad', 'triangle');
    const grow = document.getElementById('settings').getAnimations().find((a) => !('transitionProperty' in a));
    grow.pause();
  });
  const start = await shown();
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  check('Settings grows down out of the capsule', near(start, at), JSON.stringify({ start, at }));
  await page.evaluate(() => document.getElementById('settings').getAnimations().forEach((a) => a.finish()));
  await settled(page);
  const open1 = await page.evaluate(() => {
    const plate = document.getElementById('settings').getBoundingClientRect();
    const face = document.getElementById('settingsFace').getBoundingClientRect();
    const status = document.getElementById('status');
    const c = status.getBoundingClientRect();
    const title = document.getElementById('settingsTitle').getBoundingClientRect();
    return {
      header: c.top >= plate.top && c.right <= plate.right && c.bottom < title.top && getComputedStyle(status).backgroundColor === 'rgba(0, 0, 0, 0)' && Number(getComputedStyle(status).zIndex) > Number(getComputedStyle(document.getElementById('settings')).zIndex),
      fits: Math.abs(plate.height - face.height) <= 1,
      height: plate.height,
      icons: [...document.querySelectorAll('#settingsList .row')].map((r) => r.querySelector('.glyph use')?.getAttribute('href') ?? null),
    };
  });
  check('... which stays as its header, over the plate, without glass of its own', open1.header, JSON.stringify(open1));
  await emit(page, 'notice', 'Sound: TV');
  await settled(page);
  const beside = await page.evaluate(() => {
    const t = document.getElementById('toast').getBoundingClientRect();
    const p = document.getElementById('settings').getBoundingClientRect();
    return { right: Math.round(t.right), plate: Math.round(p.left), on: document.getElementById('toast').classList.contains('on') };
  });
  check('... a message meanwhile stands beside the plate, not over its rows', beside.on && beside.right <= beside.plate, JSON.stringify(beside));
  check('... each section with its icon', open1.icons.length >= 8 && open1.icons.every((h) => h && h.startsWith('#i-')) && open1.icons.at(-1) === '#i-power', JSON.stringify(open1.icons));
  // Into Power, the last section: the plate turns to its height, the rows come in from the right.
  const k = await page.evaluate(() => document.querySelectorAll('#settingsList .row').length - 1);
  for (let i = 0; i < k; i++) await emit(page, 'pad', 'down');
  await settled(page);
  const pushed = await page.evaluate(() => {
    window.__emit('pad', 'ok');
    const turn = document.getElementById('settings').getAnimations().find((a) => !('transitionProperty' in a));
    const slide = document.getElementById('settingsList').getAnimations()[0];
    return { turn: !!turn, from: slide?.effect.getKeyframes()[0].translate ?? null };
  });
  await settled(page);
  const power = await page.evaluate(() => ({
    plate: document.getElementById('settings').getBoundingClientRect().height,
    face: document.getElementById('settingsFace').getBoundingClientRect().height,
  }));
  check('... the plate\'s height follows what it holds', open1.fits && Math.abs(power.plate - power.face) <= 1 && power.plate < open1.height - 100, JSON.stringify({ open1: open1.height, power }));
  check('... and a section is pushed inside it, its rows coming in from the right', pushed.turn && /^6vw( 0px)?$/.test(pushed.from), JSON.stringify(pushed));
  const popped = await page.evaluate(() => {
    window.__emit('pad', 'back');
    return document.getElementById('settingsList').getAnimations()[0]?.effect.getKeyframes()[0].translate ?? null;
  });
  check('... and back out from the left', /^-6vw( 0px)?$/.test(popped), String(popped));
  await settled(page);
  await page.evaluate(() => window.__emit('pad', 'back'));
  await page.evaluate(() => document.getElementById('settings').getAnimations().forEach((a) => a.pause() || (a.currentTime = a.effect.getComputedTiming().endTime)));
  const back = await shown();
  check('Back closes Settings up into the capsule', near(back, at), JSON.stringify({ back, at }));
  await page.evaluate(() => document.getElementById('settings').getAnimations().forEach((a) => a.finish()));
  await settled(page);
  // Into Add a game: the clip ends on the face where it is laid out, not where it still comes in from the right.
  await emit(page, 'pad', 'triangle');
  await settled(page);
  const add = await page.evaluate(() => [...document.querySelectorAll('#settingsList .row')].findIndex((r) => r.textContent.startsWith('Add a game')));
  for (let i = 0; i < add; i++) await emit(page, 'pad', 'down');
  await settled(page);
  await page.evaluate(() => {
    window.__emit('pad', 'ok');
    const turn = document.getElementById('settings').getAnimations().find((a) => !('transitionProperty' in a));
    turn.pause();
    turn.currentTime = turn.effect.getTiming().duration;
  });
  const end = await shown();
  const face = await page.evaluate(() => {
    const p = document.getElementById('settings').getBoundingClientRect();
    const f = document.getElementById('add');
    return [p.right - f.offsetWidth, p.top, p.right, p.top + f.offsetHeight].map(Math.round);
  });
  check("... and turning to Add a game ends on its face's box", near(end, face), JSON.stringify({ end, face }));
  await close(page);
}
{
  const page = await open({ games: [game(1), game(2)] });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => (window.__settings = {}));
  const moves = await page.evaluate(() => {
    window.__emit('pad', 'triangle');
    return document.getElementById('settings').getAnimations().filter((a) => !('transitionProperty' in a)).length;
  });
  await settled(page);
  const slide = await page.evaluate(() => {
    window.__emit('pad', 'ok');
    const a = document.getElementById('settingsList').getAnimations()[0];
    return { turns: document.getElementById('settings').getAnimations().filter((x) => !('transitionProperty' in x)).length, keys: a?.effect.getKeyframes().map((k) => k.translate ?? null), ms: a?.effect.getTiming().duration };
  });
  check('Reduce Motion: Settings fades in at its place, and a section fades in where it is', moves === 0 && slide.turns === 0 && slide.keys?.every((t) => t === null) && slide.ms <= 150, JSON.stringify({ moves, slide }));
  await close(page);
}

// 48. Find on the filter line (the menu audit's first finding). With a search set, its pill above the row widens into
// the field, and the keyboard rises out of the field's bottom-left corner; the store chip's list grows up out of the
// chip. They open on the tap spring and go back on the close spring. The row stays sharp below them, with nothing over
// it; the game's info fades while Find is open, and the hero keeps drifting. One focus ring moves across keys and chips.
{
  const page = await open({ games: [game(1, { name: 'Portal 2' }), game(2, { name: 'Red Dead Redemption 2' }), game(3, { name: 'Celeste' })] });
  /** The box each named element shows on the first or last frame of its morph (morph.js), its spring, and its own box. */
  const morphs = (ids, which) =>
    page.evaluate(
      ([ids, which]) =>
        Object.fromEntries(
          ids.map((id) => {
            const el = document.getElementById(id);
            const a = el.getAnimations().find((x) => !('transitionProperty' in x) && !('animationName' in x));
            if (!a) return [id, null];
            const frames = a.effect.getKeyframes();
            const k = which === 'first' ? frames[0] : frames.at(-1);
            // Its own box: where it is laid out, less the translate it has now, part of the way.
            const rect = el.getBoundingClientRect();
            const [nx, ny = 0] = getComputedStyle(el).translate.split(' ').map(parseFloat);
            const own = { left: rect.left - (nx || 0), top: rect.top - ny, width: rect.width, height: rect.height };
            const [tx, ty = 0] = k.translate.split(' ').map(parseFloat);
            const v = k.clipPath.match(/inset\(([^)]*?)\s*round/)[1].trim().split(/\s+/).map(parseFloat);
            const [top, right, bottom, left] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
            const t = a.effect.getTiming();
            const r = (n) => Math.round(n);
            return [
              id,
              {
                box: [r(own.left + left + tx), r(own.top + top + ty), r(own.width - left - right), r(own.height - top - bottom)],
                own: [r(own.left), r(own.top), r(own.width), r(own.height)],
                // Which part of it shows there: its bottom-left corner when nothing is cut off below or on the left.
                corner: bottom === 0 && left === 0,
                leftEnd: left === 0,
                easing: t.easing,
                ms: t.duration,
              },
            ];
          })
        ),
      [ids, which]
    );
  const boxOf = (sel) =>
    page.evaluate((sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
    }, sel);
  const near = (a, b) => a && b && a.every((n, i) => Math.abs(n - b[i]) <= 2);
  /** Whether a morph ran on spring `name`: its stops (the browser writes each with its place along the way) and length. */
  const spring = (m, name) =>
    m &&
    m.ms === SPRINGS[name].ms &&
    JSON.stringify(m.easing.match(/^linear\((.*)\)$/)?.[1].split(',').map((v) => parseFloat(v))) === JSON.stringify(SPRINGS[name].points);

  // No search yet: the field grows out of its own glass, at its left end.
  await page.keyboard.press('f');
  let m = await morphs(['findField'], 'first');
  const glass = m.findField && [m.findField.own[0], m.findField.own[1], m.findField.own[3], m.findField.own[3]];
  check('with no search, the field grows out of its glass at its left end', near(m.findField?.box, glass), JSON.stringify({ m, glass }));
  await page.keyboard.type('po');
  await page.keyboard.press('Enter');
  // Find has closed, and the search's pill is back above the row.
  await until(page, () => !!document.querySelector('#filters .pill.query') && getComputedStyle(document.getElementById('filters')).opacity === '1');
  await settled(page);
  const pill = await boxOf('#filters .pill.query');
  await page.keyboard.press('f');
  m = await morphs(['findField', 'findPlate'], 'first');
  check(
    "the search's pill widens into the field from its left end, and the keyboard rises out of it, bottom row first, on the tap spring",
    near(m.findField?.box, pill) && m.findField.leftEnd && near(m.findPlate?.box, pill) && m.findPlate.corner && spring(m.findField, 'tap') && spring(m.findPlate, 'tap'),
    JSON.stringify({ pill, m })
  );
  const plate = m.findPlate.own;
  const field = m.findField.own;
  check('the keyboard stands on the field, from its left end up', plate[0] === field[0] && plate[1] + plate[3] <= field[1], JSON.stringify({ plate, field }));
  await until(page, () => getComputedStyle(document.getElementById('info')).opacity === '0');
  await settled(page);
  const open1 = await page.evaluate(() => {
    const covers = [...document.querySelectorAll('#track .cover')].map((c) => c.getBoundingClientRect().top);
    const bottoms = ['findPlate', 'findLine', 'findStores'].map((id) => document.getElementById(id).getBoundingClientRect().bottom);
    return {
      info: getComputedStyle(document.getElementById('info')).opacity,
      drift: [...document.querySelectorAll('.hero')].map((h) => getComputedStyle(h).animationPlayState),
      over: Math.max(...bottoms) - Math.min(...covers),
      blurred: [...document.querySelectorAll('#row, #track, .cover')].some((el) => getComputedStyle(el).filter !== 'none'),
    };
  });
  check(
    "while Find is open the game's info fades, the hero keeps drifting, and nothing of Find covers or blurs the row",
    open1.info === '0' && open1.drift.every((d) => d === 'running') && open1.over <= 0 && !open1.blurred,
    JSON.stringify(open1)
  );
  /** Whether the ring comes to rest on `sel`'s box, however slowly the frames come. */
  const ringOn = async (sel) => {
    await until(
      page,
      (s) => {
        const [a, b] = [document.querySelector('#find .ring'), document.querySelector(s)].map((el) => el.getBoundingClientRect());
        return ['left', 'top', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 2);
      },
      sel
    );
    return near(await boxOf('#find .ring'), await boxOf(sel));
  };
  const onKey = await ringOn('#findKeys .key.focus');
  for (let i = 0; i < 6 && (await page.evaluate(() => document.querySelector('#find .focus')?.dataset.id)) !== 'store'; i++) await page.keyboard.press('ArrowDown');
  const onChip = await ringOn('#findStore');
  await page.keyboard.press('ArrowRight');
  const onSort = await ringOn('#findSort');
  check('one focus ring moves across the keys and the chips', onKey && onChip && onSort, JSON.stringify({ onKey, onChip, onSort }));
  await page.keyboard.press('ArrowLeft');
  const chip = await boxOf('#findStore');
  await page.keyboard.press('Enter');
  m = await morphs(['findStores'], 'first');
  const list = m.findStores?.own;
  check(
    "the store chip's list grows up out of the chip on the tap spring, and stands above it",
    near(m.findStores?.box, chip) && m.findStores.corner && spring(m.findStores, 'tap') && list[0] === chip[0] && list[1] + list[3] <= chip[1],
    JSON.stringify({ chip, m })
  );
  await settled(page);
  await page.keyboard.press('Escape');
  m = await morphs(['findStores'], 'last');
  check('... and goes back into it on the close spring', near(m.findStores?.box, chip) && spring(m.findStores, 'close'), JSON.stringify({ chip, m }));
  await settled(page);
  await page.keyboard.press('Escape');
  m = await morphs(['findField', 'findPlate'], 'last');
  check(
    'closing, the field and the keyboard go back into the pill on the close spring',
    near(m.findField?.box, pill) && near(m.findPlate?.box, pill) && spring(m.findField, 'close') && spring(m.findPlate, 'close'),
    JSON.stringify({ pill, m })
  );
  await until(
    page,
    () => ['info', 'filters'].every((id) => getComputedStyle(document.getElementById(id)).opacity === '1') && getComputedStyle(document.getElementById('findLine')).opacity === '0'
  );
  const closed = await page.evaluate(() => ({
    info: getComputedStyle(document.getElementById('info')).opacity,
    filters: getComputedStyle(document.getElementById('filters')).opacity,
    find: getComputedStyle(document.getElementById('findLine')).opacity,
    pill: document.querySelector('#filters .pill.query')?.textContent,
  }));
  check("... then the pill is back above the row, and the game's info", closed.info === '1' && closed.filters === '1' && closed.find === '0' && closed.pill === 'po', JSON.stringify(closed));
  await close(page);
}

// 49. Messages are pills, the dock's (pill.js; the menu audit's eighth finding). One about a game stands on the line
// above the row, after what narrows it, with its icon, and names the game; any other at the top right, under the
// status capsule. Neither is ever over the covers. Each is the plate's glass round its icon's badge, comes in on the tap spring
// and goes on the close spring.
{
  const games = [game(1), game(2), game(3)];
  const page = await open({ games });
  await page.evaluate((games) => {
    window.__settings = { library_set_hidden: ({ id, on }) => games.map((g) => (g.id === id ? { ...g, hidden: on } : g)) };
  }, games);
  /** Where each pill shows now, what it says and with which icon, and the covers' top. */
  const pills = () =>
    page.evaluate(() => {
      const one = (id) => {
        const el = document.getElementById(id);
        const b = el.getBoundingClientRect();
        return {
          on: el.classList.contains('on'),
          text: el.textContent,
          icon: el.querySelector('.badge use')?.getAttribute('href') ?? null,
          warn: el.classList.contains('warn'),
          game: el.dataset.game ?? null,
          inLine: el.parentElement?.id === 'filters',
          box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
          fill: getComputedStyle(el).backgroundColor,
          shadow: getComputedStyle(el).boxShadow,
        };
      };
      const covers = Math.min(...[...document.querySelectorAll('#track .cover')].map((c) => c.getBoundingClientRect().top));
      // Under the status capsule, which holds the clock.
      const clock = document.getElementById('status').getBoundingClientRect();
      const plate = getComputedStyle(document.getElementById('settings'));
      return { game: one('gameNews'), system: one('toast'), covers, clock: { bottom: clock.bottom, right: clock.right }, plate: { fill: plate.backgroundColor }, width: innerWidth };
    });
  // A game hidden from its menu: the message about it.
  await emit(page, 'pad', 'menu');
  await settled(page);
  const k = await page.evaluate(() => [...document.querySelectorAll('#dChoices .row')].findIndex((r) => r.textContent.startsWith('Hide')));
  for (let i = 0; i < k; i++) await emit(page, 'pad', 'down');
  await emit(page, 'pad', 'ok');
  await until(page, () => document.getElementById('gameNews').classList.contains('on'));
  await settled(page);
  let p = await pills();
  check(
    'a message about a game stands on the line above the row, with its icon, naming the game, clear of the covers',
    p.game.on && p.game.inLine && p.game.icon === '#i-eye-off' && p.game.game === 'pc:1' && p.game.text.startsWith('Game 001 is hidden') && p.game.box.bottom <= p.covers && !p.system.on,
    JSON.stringify(p.game)
  );
  // A launch that fails: the message names its game, on the same line, as a warning.
  await page.evaluate(() => (window.__settings.launch_start = () => Promise.reject({ message: "Steam couldn't start it." })));
  await emit(page, 'pad', 'ok');
  await until(page, () => document.getElementById('gameNews').textContent.includes("couldn't"));
  await settled(page);
  p = await pills();
  check(
    "a launch that fails says so on that line, after the game's name, as a warning",
    p.game.on && p.game.text === "Game 002: Steam couldn't start it." && p.game.warn && p.game.icon === '#i-warn' && p.game.game === 'pc:2' && !p.system.on,
    JSON.stringify(p.game)
  );
  // Anything else: at the top right, under the status capsule.
  await emit(page, 'notice', 'Sound: TV');
  await settled(page);
  p = await pills();
  check(
    'any other message stands at the top right, under the status capsule, clear of the covers, with its icon',
    p.system.on && p.system.text === 'Sound: TV' && p.system.icon === '#i-info' && p.system.box.top >= p.clock.bottom && Math.abs(p.system.box.right - p.clock.right) <= 2 && p.system.box.bottom <= p.covers && !p.system.inLine,
    JSON.stringify({ system: p.system, clock: p.clock })
  );
  check('both are pills on the plate\'s glass round their icon\'s badge', [p.game, p.system].every((x) => x.fill === p.plate.fill && x.shadow.includes('inset') && x.icon), JSON.stringify([p.game.fill, p.system.fill, p.plate.fill]));
  /** The stops and length of each pill's translate transition now. */
  const curves = () =>
    page.evaluate(() =>
      ['gameNews', 'toast'].map((id) => {
        const st = getComputedStyle(document.getElementById(id));
        const i = st.transitionProperty.split(', ').indexOf('translate');
        const fn = st.transitionTimingFunction.match(/linear\([^)]*\)|ease|cubic-bezier\([^)]*\)/g)?.[i] ?? '';
        const v = st.transitionDuration.split(', ')[i] ?? '0s';
        return { stops: fn.match(/^linear\((.*)\)$/)?.[1].split(',').map((x) => parseFloat(x)), ms: Math.round(parseFloat(v) * (v.endsWith('ms') ? 1 : 1000)) };
      })
    );
  const on = (c, name) => JSON.stringify(c.stops) === JSON.stringify(SPRINGS[name].points) && c.ms === SPRINGS[name].ms;
  const coming = await curves();
  await page.evaluate(() => document.querySelectorAll('#toast, #gameNews').forEach((el) => el.classList.remove('on')));
  const going = await curves();
  check('... they come in on the tap spring and go on the close spring', coming.every((c) => on(c, 'tap')) && going.every((c) => on(c, 'close')), JSON.stringify({ coming, going }).slice(0, 300));
  await close(page);
}

// 50. The starting screen: the step the player can act on carries its action as a chip on its line, ✕ and what it
// does, as well as in the hints, and a click on it does it; only the newest such step has one. Every step's icon is
// one of the icons both pages share, not a text character.
{
  const page = await open({ games: [game(1), game(2)] });
  await emit(page, 'stores', ipc('stores'));
  await page.evaluate(() => (window.__settings = { launch_start: () => new Promise(() => {}) }));
  await page.keyboard.press('Enter');
  await idle(page);
  /** Each line: its state, its icon, and its chip's text if it has one. */
  const lines = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#steps li')].map((li) => ({
        state: li.className,
        icon: li.querySelector('.icon use')?.getAttribute('href') ?? null,
        text: li.querySelector('.icon').textContent,
        chip: li.querySelector('.chip')?.textContent ?? null,
        glyph: li.querySelector('.chip b')?.className ?? null,
      }))
    );
  for (const st of values.step_state) {
    await emit(page, 'launch-step', step({ id: 'pc:1', key: st, state: st, label: st, store: null }));
  }
  let l = await lines();
  const want = { ok: '#i-check', warn: '#i-warn', block: '#i-next', error: '#i-error', busy: null };
  check(
    "every step's icon is a shared one, not a text character, and a busy step spins",
    l.every((x) => x.icon === want[x.state] && x.text === '') && values.step_state.every((st) => l.some((x) => x.state === st)),
    JSON.stringify(l)
  );
  check('steps the player can do nothing about have no chip', l.every((x) => x.chip === null), JSON.stringify(l));
  await emit(page, 'launch-step', step({ id: 'pc:1', key: 'store:ea', state: 'block', label: 'Sign in to EA app', store: 'ea' }));
  await emit(page, 'launch-step', step({ id: 'pc:1', key: 'window', state: 'warn', label: 'A window opened. It may need you.', store: null }));
  l = await lines();
  const hint = await page.evaluate(() => document.getElementById('hint').textContent);
  const chips = l.filter((x) => x.chip !== null);
  check(
    'the newest step the player can act on carries ✕ Show the window on its line, as the hints say',
    chips.length === 1 && l.at(-1).chip === '✕Show the window' && l.at(-1).glyph === 'cross' && hint.startsWith('✕Show the window'),
    JSON.stringify({ chips, hint })
  );
  await page.click('#steps .chip');
  await idle(page);
  const call = await page.evaluate(() => window.__calls.at(-1));
  check('a click on the chip shows the window', JSON.stringify(call) === '["launch_show",{"store":null}]', JSON.stringify(call));
  // The window closes: the store app's sign-in has the chip again.
  await emit(page, 'launch-step', step({ id: 'pc:1', key: 'window', state: 'ok', label: 'The window closed', store: null }));
  l = await lines();
  check('then the store sign-in carries ✕ Open EA app', l.filter((x) => x.chip).map((x) => x.chip).join() === '✕Open EA app', JSON.stringify(l));
  await page.click('#steps .chip');
  await idle(page);
  const open2 = await page.evaluate(() => window.__calls.at(-1));
  check('... and a click on it opens the store app', JSON.stringify(open2) === '["launch_show",{"store":"ea"}]', JSON.stringify(open2));
  await close(page);
}

// 51. A hold finishes only in the place it began: Lamplit losing the keyboard to another window, going behind a game,
// or the menu or Settings closing, ends it, and a hold acts on the game it began on. A running game that ends with
// its menu's Close game in focus takes that choice away, and the menu keeps a choice in focus.
{
  const page = await open({ games: [game(1, { name: 'Racer' }), game(2, { name: 'Rally' })], running: 'pc:1' });
  await page.evaluate(() => (window.__settings = {}));
  const calls = (name) => page.evaluate((name) => window.__calls.filter((c) => c[0] === name).map((c) => JSON.stringify(c[1] ?? null)), name);
  const restartRow = async () => {
    await emit(page, 'pad', 'triangle');
    await settled(page);
    const k = await page.evaluate(() => document.querySelectorAll('#settingsList .row').length - 1);
    for (let i = 0; i < k; i++) await emit(page, 'pad', 'down');
    await emit(page, 'pad', 'ok');
    await settled(page);
    await emit(page, 'pad', 'down');
    await settled(page);
  };
  // Cross held on Restart, then another window comes in front: Cross let go there never comes here (Rust sends it to
  // Lamplit only while Lamplit is in front), as an Enter's keyup wouldn't.
  await restartRow();
  await emit(page, 'pad', 'ok');
  await page.waitForTimeout(250);
  const filling = await page.evaluate(() => !!document.querySelector('#settingsList .row.holding'));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(1000);
  check('a hold ends when another window comes in front of Lamplit', filling && (await calls('power_restart')).length === 0 && !(await page.evaluate(() => !!document.querySelector('.holding'))), JSON.stringify({ filling, calls: await calls('power_restart') }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // Held, then Settings closes under it.
  await emit(page, 'pad', 'ok');
  await page.waitForTimeout(250);
  await emit(page, 'pad', 'triangle');
  await page.waitForTimeout(1000);
  await emit(page, 'pad', 'ok-up');
  check('... and when Settings closes under it', (await calls('power_restart')).length === 0 && !(await page.evaluate(() => document.getElementById('settings').classList.contains('on'))), JSON.stringify(await calls('power_restart')));
  await close(page);
}
{
  // Two games added by hand: Remove held on the first, then its menu closes and focus moves to the second.
  const games = [game(1, { name: 'Racer', manual: true }), game(2, { name: 'Rally', manual: true }), game(3, { name: 'Rover', manual: true })];
  const page = await open({ games });
  // Rust's answer: the games left.
  await page.evaluate((list) => {
    const s = (window.__settings = { list });
    s.library_remove_game = ({ id }) => (s.list = s.list.filter((g) => g.id !== id));
  }, games);
  const removes = () => page.evaluate(() => window.__calls.filter((c) => c[0] === 'library_remove_game').map((c) => c[1].id));
  const removeRow = async () => {
    await emit(page, 'pad', 'menu');
    await settled(page);
    for (let i = 0; i < 4; i++) await emit(page, 'pad', 'down');
    await settled(page);
  };
  const focusName = () => page.evaluate(() => document.querySelector('.cover.focus .name')?.textContent);
  await removeRow();
  const first = await focusName();
  await emit(page, 'pad', 'ok');
  await page.waitForTimeout(250);
  await emit(page, 'pad', 'back');
  await emit(page, 'pad', 'right');
  await page.waitForTimeout(1000);
  await emit(page, 'pad', 'ok-up');
  const second = await focusName();
  check('a hold ends when its menu closes, and moving to another game removes nothing', first !== second && (await removes()).length === 0, JSON.stringify({ first, second, removed: await removes() }));
  // Held to the end on the game now in focus: that game goes, and only it.
  await removeRow();
  await emit(page, 'pad', 'ok');
  await until(page, () => window.__calls.some((c) => c[0] === 'library_remove_game'));
  await emit(page, 'pad', 'ok-up');
  await idle(page);
  check('... and a hold held to the end removes the game it began on', JSON.stringify(await removes()) === JSON.stringify(['pc:2']), JSON.stringify(await removes()));
  // Behind a game, a hold ends too.
  await removeRow();
  await emit(page, 'pad', 'ok');
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1000);
  const behind = await page.evaluate(() => document.getElementById('lift').classList.contains('on'));
  check('... and when Lamplit goes behind a game', behind && JSON.stringify(await removes()) === JSON.stringify(['pc:2']), JSON.stringify({ behind, removed: await removes() }));
  await close(page);
}
{
  // The running game ends while its menu's Close game is in focus.
  const page = await open({ games: [game(1), game(2)], running: 'pc:1' });
  await page.evaluate((reading) => (window.__settings = { dock_state: reading }), like(ipc('dock-game'), { id: 'pc:1', name: 'Game 001', closable: true, force_close: false, responding: true, session: 7 }));
  await emit(page, 'pad', 'menu');
  await until(page, () => [...document.querySelectorAll('#dChoices .row')].some((r) => r.textContent.startsWith('Close game')));
  for (let i = 0; i < 4; i++) await emit(page, 'pad', 'down');
  const thrown = await page.evaluate((ended) => {
    try {
      window.__emit('play', ended);
      return null;
    } catch (e) {
      return e.message;
    }
  }, play('ended', 'pc:1'));
  await idle(page);
  const after = await page.evaluate(() => ({
    errors: window.__errors.length,
    hint: document.getElementById('hint').textContent,
    rows: [...document.querySelectorAll('#dChoices .row')].map((r) => r.querySelector('.label').firstChild.textContent),
    mode: document.getElementById('lift').classList.contains('on'),
  }));
  check('a game that ends with Close game in focus closes its menu without an error', thrown === null && after.errors === 0 && !after.mode && after.hint.length > 0, JSON.stringify({ thrown, ...after }));
  await close(page);
}

// 52. A morph that another replaces, or rest, is cancelled, and what was to run once it ended never runs (morph.js):
// so Find closed while it still opens leaves no focus ring over the home screen, nor does Find closed while its store
// list still grows; the list closed while it grows leaves the ring on its chip.
{
  const page = await open({ games: [game(1), game(2), game(3)] });
  const after = await page.evaluate(async () => {
    const { grow, morph, rest } = await import('./morph.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    /** Until `what` has run, or 3 s have gone: what a replaced morph was to run would have run before it. */
    const ranOnce = async (what) => {
      for (const end = performance.now() + 3000; !ran.includes(what) && performance.now() < end; ) await wait(20);
    };
    const plate = document.createElement('div');
    plate.style.cssText = 'position: fixed; left: 100px; top: 100px; width: 400px; height: 200px';
    document.body.append(plate);
    const ran = [];
    const box = new DOMRect(120, 300, 80, 30);
    grow(plate, box, { done: () => ran.push('opened') });
    await wait(60);
    grow(plate, box, { back: true, done: () => ran.push('went back') });
    await ranOnce('went back');
    grow(plate, box, { done: () => ran.push('opened again') });
    await wait(60);
    rest(plate);
    morph(plate, { name: 'test', from: null, to: { box }, hold: true, done: () => ran.push('held') });
    await ranOnce('held');
    plate.remove();
    return ran;
  });
  check('a morph another replaces, or rest, never runs what was to run once it ended', JSON.stringify(after) === '["went back","held"]', JSON.stringify(after));
  /**
   * The ring, Find and its list once everything has had time to end: once `ready` holds and nothing moves, and then a
   * while for what a cancelled morph was to run.
   */
  const ended = async (ready) => {
    await until(page, ready);
    await settled(page);
    await page.waitForTimeout(700);
    return page.evaluate(() => {
      const ring = document.querySelector('#find .ring');
      return {
        ring: ring.classList.contains('on'),
        ringSeen: getComputedStyle(ring).opacity !== '0',
        find: document.getElementById('find').classList.contains('on'),
        list: document.getElementById('findStores').classList.contains('on'),
        focus: document.querySelector('#find .focus')?.dataset.id ?? null,
      };
    });
  };
  await page.keyboard.press('f');
  await page.waitForTimeout(80);
  await page.keyboard.press('Escape');
  let e = await ended(() => !document.getElementById('find').classList.contains('on'));
  check('Find closed while it still opens leaves no focus ring behind', !e.ring && !e.ringSeen && !e.find, JSON.stringify(e));
  // The store list closed while it grows: the ring is on the chip, the list gone.
  /** Whether the ring is on the store chip. */
  const ringOnChip = () => {
    const ring = document.querySelector('#find .ring');
    const [r, c] = [ring, document.querySelector('#findStore')].map((el) => el.getBoundingClientRect());
    return ring.classList.contains('on') && Math.abs(r.left - c.left) <= 2 && Math.abs(r.top - c.top) <= 2 && Math.abs(r.width - c.width) <= 2;
  };
  await page.keyboard.press('f');
  await until(page, () => document.querySelector('#find .ring').classList.contains('on'));
  await settled(page);
  for (let i = 0; i < 6 && (await page.evaluate(() => document.querySelector('#find .focus')?.dataset.id)) !== 'store'; i++) await page.keyboard.press('ArrowDown');
  await until(page, ringOnChip);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  await page.keyboard.press('Escape');
  e = await ended(ringOnChip);
  const onChip = await page.evaluate(() => {
    const [r, c] = ['#find .ring', '#findStore'].map((sel) => document.querySelector(sel).getBoundingClientRect());
    return Math.abs(r.left - c.left) <= 2 && Math.abs(r.top - c.top) <= 2 && Math.abs(r.width - c.width) <= 2;
  });
  check('the store list closed while it grows leaves the ring on its chip', e.ring && onChip && !e.list && e.find && e.focus === 'store', JSON.stringify({ ...e, onChip }));
  // Find closed (holding PS brings Lamplit forward) while the list still grows.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  await emit(page, 'summoned', null);
  // The list's opening stops with Find, and what it was to do once it ended with it.
  const growing = await page.evaluate(() => document.getElementById('findStores').getAnimations().filter((a) => !('transitionProperty' in a)).length);
  e = await ended(() => !document.getElementById('find').classList.contains('on'));
  check('Find closed while its store list still grows stops the list and leaves no focus ring behind', growing === 0 && !e.ring && !e.ringSeen && !e.find && !e.list, JSON.stringify({ ...e, growing }));
  await close(page);
}

// 53. The GPU's work at 120 Hz. The hero's drift holds while a plate morphs, for as long as the last morph to end, and
// runs again after; the game menu's veil is drawn once as the menu opens, an opaque blurred copy of what was behind
// it, rather than a backdrop-filter that blurs the whole screen again on every frame.
{
  const page = await open({ games: [game(1), game(2), game(3)] });
  await page.evaluate(() => (window.__settings = { library_programs: [] }));
  const drift = await page.evaluate(async (tap) => {
    const wait = (until) => new Promise((r) => setTimeout(r, Math.max(0, until - performance.now())));
    const state = () => getComputedStyle(document.querySelector('.hero')).animationPlayState;
    const before = state();
    const t0 = performance.now();
    window.__emit('pad', 'triangle');
    const opening = state();
    const k = [...document.querySelectorAll('#settingsList .row')].findIndex((r) => r.textContent.startsWith('Add a game'));
    for (let i = 0; i < k; i++) window.__emit('pad', 'down');
    // Add a game while Settings still grows: its turn ends later than the opening.
    await wait(t0 + 250);
    window.__emit('pad', 'ok');
    await wait(t0 + tap + 80);
    const between = state();
    await wait(t0 + 250 + tap + 150);
    for (const end = performance.now() + 3000; state() !== 'running' && performance.now() < end; ) await wait(performance.now() + 20);
    return { before, opening, between, after: state(), tap };
  }, SPRINGS.tap.ms);
  check(
    "the hero's drift holds while a plate morphs, until the last morph has ended, and runs again after",
    drift.before === 'running' && drift.opening === 'paused' && drift.between === 'paused' && drift.after === 'running',
    JSON.stringify(drift)
  );
  await emit(page, 'pad', 'back');
  await emit(page, 'pad', 'back');
  await settled(page);
  await emit(page, 'pad', 'menu');
  await until(page, () => document.querySelector('#lift .veil').classList.contains('drawn'));
  await settled(page);
  const pixels = () =>
    page.evaluate(() => {
      const veil = document.querySelector('#lift .veil');
      const ctx = veil.getContext('2d');
      const d = ctx.getImageData(0, 0, veil.width, veil.height).data;
      let alpha = 255;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        alpha = Math.min(alpha, d[i + 3]);
        sum += d[i] + d[i + 1] + d[i + 2];
      }
      return { alpha, sum, w: veil.width, h: veil.height, filter: getComputedStyle(veil).backdropFilter, tag: veil.tagName, opacity: getComputedStyle(veil).opacity };
    });
  const first = await pixels();
  await page.waitForTimeout(600);
  const later = await pixels();
  check(
    'the game menu\'s veil is drawn once: an opaque copy of the screen, small and scaled up, with no backdrop-filter, still while the hero drifts',
    first.tag === 'CANVAS' && first.filter === 'none' && first.alpha === 255 && first.sum > 0 && first.w <= Math.ceil(1920 / 8) + 1 && first.opacity === '1' && later.sum === first.sum,
    JSON.stringify({ first, later: later.sum })
  );
  // Change art keeps it, and back in the menu it is the same.
  await emit(page, 'pad', 'down');
  await emit(page, 'pad', 'down');
  await emit(page, 'pad', 'ok');
  await settled(page);
  const art = await pixels();
  await emit(page, 'pad', 'back');
  await settled(page);
  check('... Change art keeps it as it was', art.sum === first.sum && art.opacity === '1' && (await pixels()).sum === first.sum, JSON.stringify(art));
  await close(page);
}
{
  const page = await open({ games: [game(1), game(2)] });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await emit(page, 'pad', 'menu');
  await until(page, () => document.querySelector('#lift .veil').classList.contains('drawn'));
  await settled(page);
  const v = await page.evaluate(() => ({ opacity: getComputedStyle(document.querySelector('#lift .veil')).opacity, morphing: document.body.classList.contains('morphing') }));
  check('Reduce Motion: the veil is drawn and comes in, and nothing holds the drift (it has none)', v.opacity === '1' && !v.morphing, JSON.stringify(v));
  await close(page);
}
{
  // The veil keeps only the images of the screen it last drew (veil.js bitmaps).
  const page = await open({ games: [game(1), game(2)] });
  await page.evaluate(() => {
    window.__images = [];
    const real = window.fetch;
    window.fetch = function (...a) {
      // Only the veil's: the accent is read from the same hero elsewhere (library.js sampleAccent).
      if (new Error().stack.includes('/veil.js')) window.__images.push({ src: String(a[0]) });
      return real.apply(this, a);
    };
  });
  /** Opens and closes the game menu once its veil is drawn; returns the images loaded meanwhile, by address. */
  const menu = async () => {
    const from = await page.evaluate(() => window.__images.length);
    await emit(page, 'pad', 'menu');
    await until(page, () => document.querySelector('#lift .veil').classList.contains('drawn'));
    await emit(page, 'pad', 'back');
    await settled(page);
    return page.evaluate((n) => window.__images.slice(n).map((i) => i.src), from);
  };
  const first = await menu();
  const again = await menu();
  await emit(page, 'games', [game(1, { noArt: true }), game(2, { noArt: true })]);
  await settled(page);
  await menu();
  await emit(page, 'games', [game(1), game(2)]);
  await settled(page);
  const after = await menu();
  check(
    "the veil loads a screen's images once, and lets go of those the screen no longer shows",
    first.length > 0 && !again.some((u) => first.includes(u)) && first.every((u) => after.includes(u)),
    JSON.stringify({ first, again, after })
  );
  await close(page);
}

// 54. The game menu's two stutters on TOASTER. Opening it, the veil draws its art scaled down off the page's thread,
// and only once the press's frame has gone out, so that frame has only the lift's own work. Once it has come to rest,
// the hero and its shade under the veil are held still as one opaque copy, which the veil fades out over as the menu
// closes; the live stage comes back, unchanged, as the card lands.
{
  // A hero as large as Steam's (3840 wide), drawn in a page and saved.
  const maker = await browser.newPage();
  const big = await maker.evaluate(() => {
    const c = Object.assign(document.createElement('canvas'), { width: 3840, height: 1240 });
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 3840, 1240);
    g.addColorStop(0, '#3a6ea5');
    g.addColorStop(1, '#c0503a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 3840, 1240);
    for (let x = 0; x < 3840; x += 64) {
      ctx.fillStyle = `hsl(${x % 360} 60% 50%)`;
      ctx.fillRect(x, 400 + (x % 300), 32, 200);
    }
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  await maker.close();
  const dir = mkdtempSync(path.join(tmpdir(), 'lamplit-big-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const hero = path.join(dir, 'hero.jpg');
  writeFileSync(hero, Buffer.from(big, 'base64'));
  const games = [1, 2, 3].map((i) => game(i, { art: { ...art[0], hero } }));
  const page = await open({ games });
  await until(page, () => document.querySelector('.hero.on')?.style.backgroundImage.includes('hero.jpg'));
  await settled(page);
  await page.evaluate(() => {
    window.__drawn = [];
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...rest) {
      if (new Error().stack.includes('/veil.js')) window.__drawn.push({ kind: source.constructor.name, width: source.width, at: performance.now() });
      return draw.call(this, source, ...rest);
    };
  });
  /** Opens the menu; what the veil drew within the press's own task, and in all. */
  const openMenu = () =>
    page.evaluate(async () => {
      window.__drawn = [];
      window.__emit('pad', 'menu');
      for (let i = 0; i < 20; i++) await Promise.resolve();
      return window.__drawn.length;
    });
  let inPress = await openMenu();
  await until(page, () => document.querySelector('#lift .veil').classList.contains('drawn'));
  const drawn = await page.evaluate(() => window.__drawn.filter((d) => d.kind !== 'HTMLCanvasElement'));
  check(
    "opening the menu, the veil draws its art scaled down off the page's thread, never at the art's full size",
    inPress === 0 && drawn.length > 0 && drawn.every((d) => d.kind === 'ImageBitmap' && d.width <= Math.ceil((1920 * 1.25) / 8 / 16) * 32),
    JSON.stringify({ inPress, drawn: drawn.map((d) => `${d.kind} ${d.width}`) })
  );
  await emit(page, 'pad', 'back');
  await settled(page);
  // Again, its art already decoded: still nothing drawn in the press's task.
  inPress = await openMenu();
  check('... and draws nothing in the press\'s own frame, also with its art at hand', inPress === 0, String(inPress));
  await until(page, () => document.querySelector('#lift .veil').classList.contains('drawn'));
  // Once it has come to rest, the stage under the veil is one opaque copy, and the drift holds.
  await until(
    page,
    () =>
      document.getElementById('stage').dataset.stage === 'staged' &&
      getComputedStyle(document.getElementById('stageCopy')).visibility === 'visible' &&
      [...document.querySelectorAll('.hero')].every((h) => getComputedStyle(h).animationPlayState === 'paused')
  );
  const staged = await page.evaluate(() => {
    const copy = document.getElementById('stageCopy');
    const d = copy.getContext('2d').getImageData(0, 0, copy.width, copy.height).data;
    let alpha = 255;
    for (let i = 3; i < d.length; i += 4 * 97) alpha = Math.min(alpha, d[i]);
    const vis = (el) => getComputedStyle(el).visibility;
    return {
      stage: document.getElementById('stage').dataset.stage,
      copy: vis(copy),
      size: [copy.width, copy.height].join('x'),
      alpha,
      live: [...document.querySelectorAll('.hero, .shade')].map(vis).join(' '),
      drift: [...document.querySelectorAll('.hero')].map((h) => getComputedStyle(h).animationPlayState).join(' '),
    };
  });
  check(
    'once the menu has come to rest, the hero and its shade under the veil are one opaque copy at full size, and the drift holds',
    staged.copy === 'visible' && staged.size === '1920x1080' && staged.alpha === 255 && !staged.live.includes('visible') && staged.drift === 'paused paused',
    JSON.stringify(staged)
  );
  // The copy shows what the live stage shows: compared with the veil and the menu out of the way.
  await page.evaluate(() => (document.getElementById('lift').style.display = 'none'));
  const shot = (name) => page.screenshot({ path: path.join(shots, name), clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  const copyShot = await shot('stage-copy.png');
  await page.evaluate(() => (document.getElementById('stage').dataset.stage = 'held'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const liveShot = await shot('stage-live.png');
  const diff = await page.evaluate(
    async ([a, b]) => {
      const load = (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const [x, y] = await Promise.all([load(a), load(b)]);
      const c = new OffscreenCanvas(x.width, x.height).getContext('2d');
      c.drawImage(x, 0, 0);
      const p = c.getImageData(0, 0, x.width, x.height).data;
      c.drawImage(y, 0, 0);
      const q = c.getImageData(0, 0, x.width, x.height).data;
      let sum = 0;
      let worst = 0;
      for (let i = 0; i < p.length; i += 4 * 7) {
        for (let k = 0; k < 3; k++) {
          const e = Math.abs(p[i + k] - q[i + k]);
          sum += e;
          worst = Math.max(worst, e);
        }
      }
      return { mean: sum / ((p.length / (4 * 7)) * 3), worst };
    },
    [copyShot.toString('base64'), liveShot.toString('base64')]
  );
  check('... which looks as the live stage does', diff.mean < 2, JSON.stringify(diff));
  await page.evaluate(() => (document.getElementById('stage').dataset.stage = 'staged'));
  await page.evaluate(() => (document.getElementById('lift').style.display = ''));
  // Closing, the veil fades out over the copy; as the card lands the live stage is back, and drifts on.
  const closing = await page.evaluate(async () => {
    window.__emit('pad', 'back');
    await new Promise((r) => setTimeout(r, 120));
    return document.getElementById('stage').dataset.stage;
  });
  await settled(page);
  await until(page, () => !document.body.classList.contains('morphing') && document.getElementById('stage').dataset.stage === undefined);
  const after = await page.evaluate(() => ({
    stage: document.getElementById('stage').dataset.stage ?? null,
    copy: [document.getElementById('stageCopy').width, getComputedStyle(document.getElementById('stageCopy')).visibility].join(' '),
    live: getComputedStyle(document.querySelector('.hero.on')).visibility + ' ' + getComputedStyle(document.querySelector('.shade')).visibility,
    drift: getComputedStyle(document.querySelector('.hero.on')).animationPlayState,
  }));
  check(
    'closing, the veil fades out over the copy, and as the card lands the live stage is back and drifts on',
    closing === 'staged' && after.stage === null && after.copy === '0 hidden' && after.live === 'visible visible' && after.drift === 'running',
    JSON.stringify({ closing, after })
  );
  await close(page);
}

// 55. The stage copy under the game menu (54) never shows what isn't there. New art saved through Change art drops
// the copy, which shows the old art, and a new one is made once the new hero has faded in; and a display change while
// a copy is being made drops that copy for good, rather than hiding the live stage over an empty one.
{
  const page = await open({ games: [game(1), game(2)] });
  await until(page, () => !!document.querySelector('.hero.on')?.style.backgroundImage.includes('hero'));
  await settled(page);
  const staged = () => page.evaluate(() => document.getElementById('stage').dataset.stage ?? null);
  await emit(page, 'pad', 'menu');
  await until(page, () => document.getElementById('stage').dataset.stage === 'staged');
  // Change art saves other art for the game: its hero is now what was its cover.
  await emit(page, 'art', like(ipc('art'), { id: 'pc:1', art: { ...art[0], hero: art[0].portrait } }));
  await until(page, () => document.querySelector('.hero.on')?.style.backgroundImage.includes('portrait'));
  const dropped = await staged();
  await until(page, () => document.getElementById('stage').dataset.stage === 'staged');
  const again = await page.evaluate(() => ({ stage: document.getElementById('stage').dataset.stage, width: document.getElementById('stageCopy').width }));
  // The new copy shows the new hero: compared with the live stage, the menu out of the way.
  await page.evaluate(() => (document.getElementById('lift').style.display = 'none'));
  const copyShot = await page.screenshot();
  await page.evaluate(() => (document.getElementById('stage').dataset.stage = 'held'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const liveShot = await page.screenshot();
  const diff = await page.evaluate(
    async ([a, b]) => {
      const load = (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const [x, y] = await Promise.all([load(a), load(b)]);
      const c = new OffscreenCanvas(x.width, x.height).getContext('2d');
      c.drawImage(x, 0, 0);
      const p = c.getImageData(0, 0, x.width, x.height).data;
      c.drawImage(y, 0, 0);
      const q = c.getImageData(0, 0, x.width, x.height).data;
      let sum = 0;
      for (let i = 0; i < p.length; i += 4 * 7) for (let k = 0; k < 3; k++) sum += Math.abs(p[i + k] - q[i + k]);
      return sum / ((p.length / (4 * 7)) * 3);
    },
    [copyShot.toString('base64'), liveShot.toString('base64')]
  );
  check(
    'new art saved under the menu drops the stage copy, and the next copy shows the new hero',
    dropped === null && again.stage === 'staged' && again.width > 0 && diff < 2,
    JSON.stringify({ dropped, again, diff })
  );
  await page.evaluate(() => {
    document.getElementById('stage').dataset.stage = 'staged';
    document.getElementById('lift').style.display = '';
  });
  await emit(page, 'pad', 'back');
  await settled(page);
  await until(page, () => !document.getElementById('lift').classList.contains('shown'));
  // Open again; the display changes just as the copy has been drawn, before it shows.
  await page.evaluate(() => {
    const copy = document.getElementById('stageCopy');
    new MutationObserver((list, seen) => {
      if (!copy.width) return;
      seen.disconnect();
      window.dispatchEvent(new Event('resize'));
    }).observe(copy, { attributes: true, attributeFilter: ['width', 'height'] });
  });
  await emit(page, 'pad', 'menu');
  await until(page, () => document.querySelector('#lift .veil').classList.contains('drawn'));
  await page.waitForTimeout(2200);
  const resized = await page.evaluate(() => ({
    stage: document.getElementById('stage').dataset.stage ?? null,
    copy: document.getElementById('stageCopy').width,
    live: getComputedStyle(document.querySelector('.hero.on')).visibility,
  }));
  check('a display change as the copy is drawn drops it, and the live stage stays', resized.stage === null && resized.copy === 0 && resized.live === 'visible', JSON.stringify(resized));
  await close(page);
}

check('no page errors or CSP violations on any page', pageErrors.length === 0, JSON.stringify(pageErrors));
const untested = Object.keys(commands).filter((cmd) => !called.has(cmd));
check('every command Rust registers is called by a test', untested.length === 0, untested.join(', '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
