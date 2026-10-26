// The README's screenshots: Lamplit's page at 1920 × 1080 with a library of real games, through the fake Tauri of
// page.mjs. Game art isn't part of the repo, so the script reads it from a folder laid out like
// %LOCALAPPDATA%\lamplit\art (<Steam app id>\portrait.jpg, hero.jpg and logo.png), copied from a Windows PC where
// Lamplit has found art for these games.
// Run: `node tests/screenshots.mjs [art folder]` (tests/art by default). It writes docs/images/{home,launch,settings,
// sound,controllers}.jpg.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipc, known, like } from './fixtures.mjs';
import { emit, idle, open, settled } from './page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, '..', 'ui');
const out = path.join(here, '..', 'docs', 'images');
const artDir = path.resolve(process.argv[2] ?? path.join(here, 'art'));

// A Saturday evening: the clock in the corner and "Played yesterday" are worked out from it.
const now = new Date(2026, 9, 24, 20, 40);
const daysAgo = (days) => (days == null ? 0 : Math.floor(now.getTime() / 1000) - days * 86400);

/** [Steam app id of the art, game id, name, store, store apps it needs, days since last played, hours played] */
const library = [
  [1091500, 'epic:Ginger', 'Cyberpunk 2077', 'epic', ['epic'], 1, 86],
  [1237970, 'steam:1237970', 'Titanfall 2', 'steam', ['steam', 'ea'], 2, 31],
  [1174180, 'rockstar:Red Dead Redemption 2', 'Red Dead Redemption 2', 'rockstar', ['rockstar'], 4, 112],
  [3405690, 'ea:16425677', 'EA SPORTS FC 26', 'ea', ['ea'], 6, 54],
  [2369390, 'ubisoft:5266', 'Far Cry 6', 'ubisoft', ['ubisoft'], 12, 23],
  [949230, 'xbox:ParadoxInteractive.CitiesSkylinesII-PCEdition_zfnrdv2de78ny', 'Cities: Skylines II', 'xbox', ['xbox'], 20, 140],
  [3354750, 'ea:1184493', 'skate.', 'ea', ['ea'], null, 0],
  [460930, 'ubisoft:1771', "Tom Clancy's Ghost Recon Wildlands", 'ubisoft', ['ubisoft'], null, 0],
  [203160, 'xbox:39C668CD.TombRaiderDefinitiveEdition_r7bfsmp40f67j', 'Tomb Raider: Definitive Edition', 'xbox', ['xbox'], null, 0],
];

const missing = [];
const games = library.map(([app, id, name, store, requires, played, hours]) => {
  const file = (f) => path.join(artDir, String(app), f);
  for (const need of ['portrait.jpg', 'hero.jpg']) if (!existsSync(file(need))) missing.push(file(need));
  return like(ipc('games')[0], {
    id,
    name,
    store,
    dir: `D:\\Games\\${name.replace(/[:.]/g, '')}`,
    note: null,
    last_played: daysAgo(played),
    play_minutes: hours * 60,
    favourite: false,
    hidden: false,
    art: { portrait: file('portrait.jpg'), hero: file('hero.jpg'), logo: existsSync(file('logo.png')) ? file('logo.png') : null },
    requires,
  });
});
if (missing.length) {
  console.error(`No art for every game in ${artDir}; missing:\n${missing.join('\n')}`);
  process.exit(1);
}

const [steamStore] = ipc('stores');
/** @param {string} store @param {string} name @param {boolean} installed @param {boolean} running @param {string} account */
const storeApp = (store, name, installed, running, account) =>
  like(steamStore, { store, name, installed, running, account: known('account', account) });
// Every store, as Rust lists them: Ubisoft Connect needs a sign-in, GOG Galaxy isn't installed.
const stores = [
  storeApp('steam', 'Steam', true, true, 'signed-in'),
  storeApp('epic', 'Epic Games Launcher', true, false, 'remembered'),
  storeApp('ea', 'EA app', true, true, 'signed-in'),
  storeApp('ubisoft', 'Ubisoft Connect', true, false, 'signed-out'),
  storeApp('rockstar', 'Rockstar Games Launcher', true, false, 'remembered'),
  storeApp('gog', 'GOG Galaxy', false, false, 'unknown'),
  storeApp('xbox', 'Xbox app', true, false, 'unknown'),
];

const sound = ipc('sound');
const device = (id, windowsName, name, kind, isDefault) =>
  like(sound.outputs[0], { id, windows_name: windowsName, name, kind, default: isDefault });
const accessories = ipc('accessories');
const settings = {
  stores_status: stores,
  overlay_state: like(ipc('overlays'), { nvidia_overlay: true, nvidia_stats: false }),
  quiet_state: like(ipc('quiet'), { state: known('quiet_state', 'on'), active: true, notes: [] }),
  setup_state: like(ipc('setup'), { needed: false }),
  sound_state: like(sound, {
    outputs: [
      device('{0.0.0.00000000}.{6f1c2b0e-tv}', 'LG TV SSCR2 (NVIDIA High Definition Audio)', 'TV (LG TV SSCR2)', 'tv', false),
      device('{0.0.0.00000000}.{a83d51c4-headset}', 'Speakers (PRO X 2 LIGHTSPEED)', 'PRO X 2 headset', 'headset', true),
    ],
    inputs: [device('{0.0.1.00000000}.{c27e90d1-headset}', 'Microphone (PRO X 2 LIGHTSPEED)', 'PRO X 2 headset', 'headset', true)],
    volume: 45,
    muted: false,
    mic_muted: false,
  }),
  accessories_state: like(accessories, {
    headset: like(accessories.headset, { receiver: true, on: true, battery: 80, charge: known('charge', 'battery'), sidetone: 30, auto_off: 30 }),
    controllers: [like(accessories.controllers[0], { bluetooth: true, status: { battery: 70, charge: known('charge', 'battery'), headphones: false } })],
  }),
  prefs_state: like(ipc('prefs'), { sound_follows: true, touchpad_mouse: true, steam_devtools: false, online_art: true }),
  display_mode: '3840 × 2160 at 120 Hz',
};

/** Waits until the focused game's hero is on screen and every cover's art has loaded, then for the motion to end. */
async function artLoaded(page) {
  const hero = () => [...document.querySelectorAll('.hero.on')].some((h) => h.style.backgroundImage.includes('hero.jpg'));
  await page.waitForFunction(hero, null, { timeout: 5000 });
  await page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll('.cover, .hero.on, #logo')].map((el) => {
        const src = el instanceof HTMLImageElement ? el.src : getComputedStyle(el).backgroundImage.match(/url\("(.+)"\)/)?.[1];
        if (!src) return null;
        const img = new Image();
        img.src = src;
        return img.decode().catch(() => {});
      })
    )
  );
  await settled(page);
}

/** @param {string} name */
const shoot = async (page, name) => {
  await idle(page);
  await settled(page);
  // The rows scroll their focus into view on the next frame.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const errors = await page.evaluate(() => [...window.__errors, ...window.__logs.filter((l) => !l.startsWith('info '))]);
  if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
  await page.screenshot({ path: path.join(out, `${name}.jpg`), type: 'jpeg', quality: 88 });
  console.log(`wrote docs/images/${name}.jpg`);
};

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: 'chromium' });

// The library with the most recently played game focused; then Titanfall 2 starting, which needs both Steam and the
// EA app: every check passed and the game is opening.
{
  const page = await open(browser, uiDir, { games, now });
  await emit(page, 'stores', stores);
  await artLoaded(page);
  await shoot(page, 'home');
  await emit(page, 'pad', 'right');
  await artLoaded(page);
  await emit(page, 'pad', 'ok');
  const step = (key, state, label, store) => emit(page, 'launch-step', like(ipc('launch-step'), { id: 'steam:1237970', key, state, label, store }));
  await step('store:steam', 'ok', 'Steam: signed in', 'steam');
  await step('update', 'ok', 'Up to date', null);
  await step('store:ea', 'ok', 'EA app: signed in', 'ea');
  await step('game', 'busy', 'Starting Titanfall 2', null);
  await shoot(page, 'launch');
  await page.close();
}

// Settings over Cities: Skylines II: the list of sections, then Sound with Volume focused, then Controllers.
{
  const page = await open(browser, uiDir, { games, now });
  await page.evaluate((s) => (window.__settings = s), settings);
  await emit(page, 'stores', stores);
  for (let i = 0; i < 5; i++) await emit(page, 'pad', 'right');
  await artLoaded(page);
  await emit(page, 'pad', 'triangle');
  await shoot(page, 'settings');
  await emit(page, 'pad', 'ok');
  await emit(page, 'pad', 'down');
  await emit(page, 'pad', 'down');
  await shoot(page, 'sound');
  await emit(page, 'pad', 'back');
  await emit(page, 'pad', 'down');
  await emit(page, 'pad', 'down');
  await emit(page, 'pad', 'ok');
  await shoot(page, 'controllers');
  await page.close();
}

await browser.close();
