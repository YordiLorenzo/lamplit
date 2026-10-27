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
import { commands, emit, idle, open as openPage, settled, until } from './page.mjs';

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
    toast: document.getElementById('toast').classList.contains('on') ? document.getElementById('toast').textContent : '',
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
  await emit(page, 'play', play('running', 'pc:1'));
  s = await state(page);
  check('running hides the overlay', !s.overlay);
  check('focused running game offers Back to game', s.hint.includes('Back to game'), s.hint);
  await page.keyboard.press('Enter');
  s = await state(page);
  check('Enter on the running game resumes it', s.lastCall?.[0] === 'launch_resume');
  await emit(page, 'play', play('ended', 'pc:1'));
  s = await state(page);
  check('ended returns to browsing', !s.overlay && s.hint.includes('Play') && !s.hint.includes('Back to game'), s.hint);
  await page.keyboard.press('i');
  s = await state(page);
  check('a game that ran counts as played', s.dPlayed === 'today', s.dPlayed);
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
  check("Tauri's own refusal reaches the player as its text", s.toast === 'invalid args `id` for command `launch_start`' && !s.overlay, s.toast);
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
  check("a cancelled launch doesn't count as played", s.dPlayed === 'Not yet', s.dPlayed);
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
  await emit(page, 'play', play('running', 'pc:1'));
  await emit(page, 'play', play('starting', 'pc:1'));
  let s = await state(page);
  check('restarting shows the waiting overlay', s.overlay && s.overlaySub.startsWith('Waiting'), s.overlaySub);
  await page.keyboard.press('Escape');
  // Game 1 runs; summon Lamplit, start game 2, then game 1 closes while 2 is starting.
  await emit(page, 'play', play('running', 'pc:1'));
  await emit(page, 'summoned', 'pc:1');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await emit(page, 'play', play('ended', 'pc:1'));
  s = await state(page);
  check("another game's end keeps the starting overlay", s.overlay && s.overlayTitle.includes('Game 002'), s.overlayTitle);
  await emit(page, 'play', play('starting', 'pc:1'));
  s = await state(page);
  check("another game's restart keeps the starting overlay", s.overlay && s.overlayTitle.includes('Game 002'), s.overlayTitle);
  await emit(page, 'play', play('running', 'pc:2'));
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
  await emit(page, 'play', play('running', 'pc:1'));
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
  await emit(page, 'play', play('running', 'pc:3'));
  await emit(page, 'play', play('ended', 'pc:3'));
  let s = await state(page);
  check('ended game moves to the front and keeps focus', s.focusIndex === 0, `focus ${s.focusIndex}`);
  // Click the cover that is now second (game 1).
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
      toast: document.getElementById('toast').classList.contains('on') ? document.getElementById('toast').textContent : '',
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
  await page.waitForTimeout(50);
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
  check('✕ opens the store app that waits', s.lastCall?.[0] === 'stores_open' && s.lastCall[1].store === 'ea', JSON.stringify(s.lastCall));
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
  await emit(page, 'play', play('running', 'pc:1'));
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
  check('coming forward looks for new installs', s.lastCall?.[0] === 'library_rescan', JSON.stringify(s.lastCall));
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
      toast: document.getElementById('toast').classList.contains('on') ? document.getElementById('toast').textContent : '',
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
      find: document.getElementById('find').classList.contains('on'),
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
      time: document.getElementById('dTime').textContent,
      meta: document.getElementById('meta').innerText.replace(/\s+/g, ' '),
    }));
  await page.keyboard.press('i');
  let d = await details();
  check('a game Lamplit never saw run has no play time', d.time === 'Not counted yet' && !d.meta.includes('played'), JSON.stringify(d));
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  d = await details();
  check('the home screen shows whole hours played', d.meta.endsWith('12 h played'), d.meta);
  await page.keyboard.press('i');
  d = await details();
  let s = await state(page);
  check('Details show hours and minutes played', d.time === '12 h 34 min', d.time);
  check('Details open on Play, with the other choices below', d.focus === 'Play' && JSON.stringify(d.choices) === '["Play","Add to favourites","Change art","Hide this game"]' && s.hint.includes('✕Play'), `${JSON.stringify(d)} ${s.hint}`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await idle(page);
  d = await details();
  s = await state(page);
  check('✕ on Add to favourites asks Rust', JSON.stringify(s.lastCall) === '["library_set_favourite",{"id":"pc:3","on":true}]', JSON.stringify(s.lastCall));
  check('a favourite moves to the front and keeps focus, Details open', s.details && s.focusIndex === 0 && s.focusName === 'Game 003' && d.focus === 'Remove from favourites', `${s.focusIndex} ${s.focusName} ${d.focus}`);
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

// 21. Settings > Power: ✕ asks once, ✕ again sleeps, restarts or shuts down; a running game that will close is named.
{
  const page = await open({ games: [game(1), game(2, { name: 'Racer' })], running: 'pc:2' });
  await page.evaluate(() => (window.__settings = {}));
  const view = () =>
    page.evaluate(() => ({
      open: document.getElementById('settings').classList.contains('on'),
      rows: [...document.querySelectorAll('#settingsList .row')].map((r) => r.textContent),
      focus: document.querySelector('#settingsList .row.focus')?.textContent ?? null,
      toast: document.getElementById('toast').classList.contains('on') ? document.getElementById('toast').textContent : '',
      calls: window.__calls.map((c) => c[0]),
    }));
  const powerSection = async () => {
    await page.keyboard.press('c');
    await idle(page);
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  };
  await powerSection();
  let v = await view();
  check('Power offers sleep, restart and shut down', JSON.stringify(v.rows) === '["Sleep","Restart","Shut down"]' && v.focus === 'Sleep', JSON.stringify(v.rows));
  await page.keyboard.press('Enter');
  v = await view();
  check('✕ once asks to confirm, and sends nothing', v.focus === 'SleepPress again to confirm' && !v.calls.some((c) => c.startsWith('power_')), `${v.focus} ${JSON.stringify(v.calls)}`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  v = await view();
  check('moving on cancels the question, and restart names the game that will close', v.rows[0] === 'Sleep' && v.focus === 'RestartPress again to confirm' && v.rows.includes('Racer is running and will close'), JSON.stringify(v.rows));
  await page.keyboard.press('Enter');
  await idle(page);
  v = await view();
  check('✕ again restarts, from the home screen', v.calls.at(-1) === 'power_restart' && !v.open, `${v.calls.at(-1)} ${v.open}`);
  await page.evaluate((error) => {
    window.__settings.power_shut_down = () => {
      throw error;
    };
  }, like(ipc('error'), { message: "Windows didn't shut down. Another Windows account is signed in on this PC: sign it out first." }));
  await powerSection();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await idle(page);
  v = await view();
  check('a shutdown Windows refuses says why', v.calls.at(-1) === 'power_shut_down' && v.toast.startsWith("Windows didn't shut down."), `${v.calls.at(-1)} ${v.toast}`);
  await powerSection();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await idle(page);
  v = await view();
  check('✕ twice on Sleep puts the PC to sleep', v.calls.at(-1) === 'power_sleep' && !v.open, `${v.calls.at(-1)} ${v.open}`);
  // A held Enter repeats; the repeat mustn't answer the question its first press asked.
  await powerSection();
  await page.keyboard.press('ArrowDown');
  const before = (await view()).calls.length;
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await idle(page);
  v = await view();
  check('a held Enter asks, and its repeat doesn\'t confirm', v.focus === 'RestartPress again to confirm' && !v.calls.slice(before).includes('power_restart'), `${v.focus} ${JSON.stringify(v.calls.slice(before))}`);
  // Steam mirrors ✕ as Enter, and the key can come before the pad's own press: one press mustn't ask and answer.
  // Moving off Restart and back clears the question the held Enter asked.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  const fresh = (await view()).calls.length;
  await page.keyboard.press('Enter');
  await emit(page, 'pad', 'ok');
  await idle(page);
  v = await view();
  check('a mirrored Enter before the pad\'s ✕ asks once and doesn\'t confirm', v.focus === 'RestartPress again to confirm' && !v.calls.slice(fresh).includes('power_restart'), `${v.focus} ${JSON.stringify(v.calls.slice(fresh))}`);
  // The focused cover still shows beside Settings: a click on it mustn't answer the question either.
  await page.click('#track .cover.focus');
  await idle(page);
  v = await view();
  check('a click on the focused cover doesn\'t confirm a power action', v.open && !v.calls.slice(before).includes('power_restart'), `${v.open} ${JSON.stringify(v.calls.slice(before))}`);
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
  await idle(page);
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
  await emit(page, 'play', play('running', 'pc:3'));
  await emit(page, 'play', play('ended', 'pc:3'));
  const order = await page.evaluate(() => [...document.querySelectorAll('#track .cover')].map((c) => c.textContent));
  const s = await state(page);
  check('the favourite stays first when another game ends', JSON.stringify(order) === '["Game 001Playing","Game 003Playing","Game 002Playing"]' && s.focusName === 'Game 003', `${JSON.stringify(order)} ${s.focusName}`);
  await close(page);
}

// 24. Find a game: the on-screen keyboard narrows the row as it types, the store and sort choices order it, and ○
// brings every game back. With a controller, the mouse and the keyboard.
const findView = (page) =>
  page.evaluate(() => ({
    open: document.getElementById('find').classList.contains('on'),
    query: document.getElementById('findQuery').textContent,
    focus: /** @type {HTMLElement} */ (document.querySelector('#find .focus'))?.dataset.id ?? null,
    row: [...document.querySelectorAll('#track .cover .name')].map((n) => n.textContent),
    focused: document.querySelector('#track .cover.focus .name')?.textContent ?? null,
    filters: document.getElementById('filters').textContent,
    stores: [...document.querySelectorAll('#findStores .choice')].map((c) => c.textContent),
    chosen: [...document.querySelectorAll('#find .choice.on')].map((c) => /** @type {HTMLElement} */ (c).dataset.id),
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
  /** Moves focus with the d-pad to the key or choice `id`, a row at a time, then presses ✕ on it. */
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
  await pick('store:steam');
  v = await seen();
  check('the store choices: All, then the stores with games, games outside any store last', JSON.stringify(v.stores) === '["All","steam","epic","ubisoft","rockstar","pc"]', JSON.stringify(v.stores));
  check('a store keeps its own games', JSON.stringify(v.row) === '["Titanfall 2","Portal 2"]' && v.chosen.includes('store:steam') && v.focus === 'store:steam', `${JSON.stringify(v.row)} ${v.chosen}`);
  await pick('sort:name');
  v = await seen();
  check('A to Z sorts the row by name', JSON.stringify(v.row) === '["Portal 2","Titanfall 2"]' && v.chosen.includes('sort:name'), JSON.stringify(v.row));
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
  await pick('sort:played');
  await pick('store:steam');
  await pad('back');
  await emit(page, 'play', play('running', 'pc:2'));
  await emit(page, 'play', play('ended', 'pc:2'));
  v = await seen();
  check('a game the store filter hides gets focus when it ends, with every game back', v.focused === 'Cyberpunk 2077' && v.row.length === 6 && v.filters === '', `${v.focused} ${v.filters}`);
  await emit(page, 'play', play('running', 'pc:1'));
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
  await page.click('#find [data-id="store:all"]');
  v = await findView(page);
  check('a click on the choice already made still moves focus there', v.focus === 'store:all' && v.chosen.includes('store:all'), v.focus);
  await page.keyboard.press('Backspace');
  v = await findView(page);
  check('Backspace on an empty search moves focus to Done too', v.open && v.focus === 'done' && v.query === '', `${v.focus} ${v.query}`);
  await close(page);
}
{
  // A 4:3 screen and a game from every store: the store choices take several lines and the panel scrolls, and the
  // focused choice stays in view.
  const stores = ['steam', 'epic', 'ea', 'ubisoft', 'rockstar', 'battlenet', 'gog', 'amazon', 'itch', 'xbox', null];
  const page = await open({ games: stores.map((store, i) => game(i + 1, { store, requires: store ? [store] : [] })) }, { width: 1440, height: 1080 });
  await emit(page, 'pad', 'square');
  for (let i = 0; i < 12; i++) await emit(page, 'pad', 'down');
  await settled(page);
  const seen = await page.evaluate(() => {
    const panel = document.getElementById('find');
    const focus = document.querySelector('#find .focus');
    const [p, f] = [panel.getBoundingClientRect(), focus.getBoundingClientRect()];
    // Inside the panel's padding, not pressed against its rounded edge.
    const pad = parseFloat(getComputedStyle(panel).paddingBottom);
    return { id: /** @type {HTMLElement} */ (focus).dataset.id, scrolls: panel.scrollHeight > panel.clientHeight, inside: f.top >= p.top + pad && f.bottom <= p.bottom - pad + 1, pageX: scrollX };
  });
  check('4:3: the panel scrolls to keep the focused choice in view, clear of its edge', seen.id.startsWith('sort:') && seen.scrolls && seen.inside && seen.pageX === 0, JSON.stringify(seen));
  const logos = await page.evaluate(() =>
    [...document.querySelectorAll('#find [data-id^="store:"]')].map((c) => {
      const use = c.querySelector('svg.store-logo use');
      // A logo drawn from a symbol that isn't there would be an empty gap.
      return `${c.getAttribute('data-id')}=${use ? Boolean(document.querySelector(use.getAttribute('href') ?? '')) : 'none'}`;
    })
  );
  const expected = ['all=none', ...stores.map((s) => (s === 'amazon' || !s ? `${s ?? 'pc'}=none` : `${s}=true`))].map((s) => `store:${s}`);
  check('each store choice has its logo, the Amazon Games app its name alone', JSON.stringify(logos) === JSON.stringify(expected), JSON.stringify(logos));
  await page.screenshot({ path: path.join(shots, 'find-4x3.png') });
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
const saverOn = (page) => until(page, () => document.querySelector('#saver.on'));

// 28. The screensaver: after five minutes without input it covers the screen, and the first press only ends it. The
// key, the pad's own press of the same button (Steam mirrors one as the other), a held direction's repeats and a click
// do nothing else. It stays away while a game runs or another window is in front.
{
  const page = await open({ games: [game(1), game(2), game(3), game(4)], clock: true });
  await page.clock.fastForward('04:50');
  await page.waitForTimeout(200);
  let v = await saverView(page);
  check('no screensaver before five minutes without input', !v.on, JSON.stringify(v));
  await page.clock.fastForward('00:15');
  await saverOn(page);
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
  await saverOn(page);
  await emit(page, 'pad', 'ok');
  v = await saverView(page);
  check('✕ ends the screensaver without starting the game', !v.on && !v.starting && !v.calls.includes('launch_start'), JSON.stringify(v));

  await page.clock.runFor(600);
  await page.clock.fastForward('05:05');
  await saverOn(page);
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
  await saverOn(page);
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
  await saverOn(page);
  await page.mouse.move(x + 3, y + 2);
  v = await saverView(page);
  check('a twitch of the pointer leaves the screensaver on', v.on, JSON.stringify(v));
  await page.mouse.click(x + 3, y + 2);
  v = await saverView(page);
  check('a click ends the screensaver, and the cover under it starts nothing', !v.on && !v.starting && !v.calls.includes('launch_start'), JSON.stringify(v));

  await page.clock.runFor(600);
  await emit(page, 'play', play('running', 'pc:2'));
  await page.clock.fastForward('10:00');
  await page.waitForTimeout(200);
  v = await saverView(page);
  check('no screensaver while a game runs', !v.on, JSON.stringify(v));
  await emit(page, 'play', play('ended', 'pc:2'));
  await page.clock.fastForward('05:05');
  await saverOn(page);
  await emit(page, 'play', play('running', 'pc:2'));
  await until(page, () => !document.querySelector('#saver.on'));
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

// 29. Settings > Screensaver: ← and → step the delay (Off among them) and the scenes, saved through Rust; Off keeps it
// away; Show it now shows it, in the scenes chosen, and the ✕ that asked for it doesn't end it.
{
  const page = await open({ games: [game(1), game(2)], clock: true });
  await page.evaluate((prefs) => {
    const s = (window.__settings = { prefs });
    s.prefs_state = () => s.prefs;
    s.prefs_set_screensaver_minutes = ({ minutes }) => ((s.prefs.screensaver_minutes = minutes), s.prefs);
    s.prefs_set_screensaver_style = ({ style }) => ((s.prefs.screensaver_style = style), s.prefs);
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
  check('Settings lists the screensaver with its delay and scenes', v.focus === 'ScreensaverAfter 5 min · 2D and 3D', v.focus);
  await page.keyboard.press('Enter');
  await idle(page);
  v = await view();
  check(
    'the Screensaver section: the delay, the scenes and Show it now',
    JSON.stringify(v.rows.slice(0, 3)) === '["Starts after5 min","Scenes2D and 3D","Show it now"]' && v.focus === 'Starts after5 min',
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
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await idle(page);
  v = await view();
  check('→ steps the scenes to 2D only', JSON.stringify(v.sent.at(-1)) === '["prefs_set_screensaver_style",{"style":"2d"}]' && v.focus === 'Scenes2D', JSON.stringify(v));
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
  await page.keyboard.press('Enter');
  // The pad's own press of the ✕ that Steam mirrored as Enter.
  await emit(page, 'pad', 'ok');
  await saverOn(page);
  s = await saverView(page);
  check("Show it now shows the screensaver in the scenes chosen, and the ✕ that asked doesn't end it", s.on && ['silk', 'waves', 'ink'].includes(s.scene), JSON.stringify(s));
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
        veil: { opacity: veil.opacity, filter: veil.backdropFilter },
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
  await settled(page);
  let l = await lifted();
  const at = `${vp.width}x${vp.height}`;
  check(`${at}: the menu lifts the focused cover over a blurred, dimmed screen`, l.on && l.veil.opacity === '1' && l.veil.filter.includes('blur') && l.coverHidden, JSON.stringify(l));
  check(`${at}: the lifted cover is larger than in the row, and higher`, l.card.h > rest.cover.h * 1.4 && l.card.y + l.card.h / 2 < rest.cover.y + rest.cover.h / 2 - l.h * 0.1, JSON.stringify([rest.cover, l.card]));
  check(`${at}: the menu opens beside the cover, inside the screen`, l.menuOn && l.menu.x >= l.card.x + l.card.w && l.menu.x + l.menu.w <= l.w * 0.95 + 1 && l.menu.y >= 0 && l.menu.y + l.menu.h <= l.h, JSON.stringify([l.card, l.menu]));
  check(`${at}: the art behind holds still while the menu is up`, l.drift === 'paused', l.drift);
  await page.screenshot({ path: path.join(shots, `menu-${vp.width}x${vp.height}.png`) });
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('lift').classList.contains('shown'));
  l = await lifted();
  check(`${at}: Back lowers the cover into the row, which shows it again`, !l.shown && l.visibility === 'hidden' && !l.coverHidden && l.drift === 'running', JSON.stringify(l));
  if (vp.width === 1920) {
    // Back while the card still rises: it turns round from where it is, rather than jumping.
    await page.keyboard.press('i');
    await page.waitForTimeout(150);
    const rising = (await lifted()).card;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
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
  // Its menu offers Remove; ✕ once asks, ✕ again removes it.
  await page.keyboard.press('Escape');
  const choices = await page.evaluate(() => [...document.querySelectorAll('#dChoices .row')].map((r) => r.textContent));
  check('the menu of a game added by hand offers Remove from Lamplit', choices.at(-1) === 'Remove from Lamplit' && (await page.evaluate(() => document.getElementById('dStore').textContent)) === 'Added by hand', JSON.stringify(choices));
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  s = await state(page);
  check('✕ on Remove asks first', s.lastCall?.[0] !== 'library_remove_game' && (await page.evaluate(() => document.querySelector('#dChoices .row.focus').textContent)) === 'Press again to remove', JSON.stringify(s.lastCall));
  await page.keyboard.press('Enter');
  await idle(page);
  s = await state(page);
  check('✕ again removes it from the row', s.lastCall?.[0] === 'library_remove_game' && s.covers === 1 && s.toast === 'Old Racer is no longer in Lamplit.', `${JSON.stringify(s.lastCall)} ${s.covers} ${s.toast}`);
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
  check('a game Rust refuses stays on naming, and says why', a.naming && s.toast.startsWith('That folder belongs to Game 001'), `${a.naming} ${s.toast}`);
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

check('no page errors or CSP violations on any page', pageErrors.length === 0, JSON.stringify(pageErrors));
const untested = Object.keys(commands).filter((cmd) => !called.has(cmd));
check('every command Rust registers is called by a test', untested.length === 0, untested.join(', '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
