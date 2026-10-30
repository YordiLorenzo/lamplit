// The in-game dock's page (ui/dock.html) in Chromium with the fake Tauri, run by ui.test.mjs: opening and folding,
// every tile, holding Cross to close a game, the controller, keyboard and mouse, the game's art and play time, news,
// and its size in the window Rust gives it. And the switch in Settings that turns the dock off.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ICONS } from '../ui/icons.js';
import { SPRINGS } from '../ui/springs.js';
import { ipc, known, like } from './fixtures.mjs';
import { emit, idle, settled, until } from './page.mjs';

/** The dock's window while open: a 1080p screen (src-tauri/src/dock/window.rs). */
const OPEN = { width: 1920, height: 1080 };
const SCREEN = { width: 1920, height: 1080 };
/** Longer than Close game's hold (ui/hold.js HOLD_MS), and well shorter. */
const HELD_MS = 1150;
const TAPPED_MS = 300;

const [opened, closed, status] = ipc('dock');
/** Started 72 minutes ago, and answering. */
const game = like(ipc('dock-game'), { responding: true, force_close: false, started: Math.floor(Date.now() / 1000) - 72 * 60 });
const hung = like(ipc('dock-game'), { started: game.started });
const headsetOut = like(ipc('sound').outputs[0], {
  id: '{0.0.0.00000000}.{headset}',
  windows_name: 'Speakers (PRO X 2 LIGHTSPEED)',
  name: 'PRO X 2 headset',
  kind: 'headset',
  default: false,
});
const sound = like(ipc('sound'), { outputs: [ipc('sound').outputs[0], headsetOut] });

/** Answers for the dock's commands, which change what they hold as Rust would. */
async function answers(page, data) {
  await page.evaluate((d) => {
    const s = (window.__settings = { ...d });
    s.dock_state = () => s.game;
    s.sound_state = () => s.sound;
    s.accessories_state = () => s.accessories;
    s.quiet_state = () => s.quiet;
    s.overlay_state = () => s.overlays;
    s.sound_change_volume = ({ delta }) => (s.sound.volume = Math.max(0, Math.min(100, s.sound.volume + delta)));
    s.sound_set_mute = ({ muted }) => {
      s.sound.muted = muted;
    };
    s.sound_set_default = ({ id }) => {
      s.sound.outputs.forEach((o) => (o.default = o.id === id));
      return s.sound;
    };
    s.quiet_set = ({ on }) => (s.quiet = { state: on ? 'on' : 'off', active: on, notes: on ? ['Close Ubisoft Connect so Lamplit can quiet it.'] : [] });
    s.overlay_toggle_stats = () => new Promise((resolve) => setTimeout(() => resolve((s.overlays.nvidia_stats = !s.overlays.nvidia_stats)), 150));
  }, data);
}

/** A tile as the test reads it: its label, then on, warn and holding when they apply. */
const view = (page) =>
  page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const tiles = [...document.querySelectorAll('.tile')];
    const focus = document.querySelector('.slot.focus');
    const flags = (t) => ['on', 'warn', 'holding'].filter((f) => t.classList.contains(f)).map((f) => `|${f}`).join('');
    return {
      mode: $('island').dataset.mode,
      tiles: tiles.map((t) => t.dataset.key),
      values: Object.fromEntries(tiles.map((t) => [t.dataset.key, `${t.querySelector('.label').textContent}${flags(t)}`])),
      focus: focus ? focus.dataset.key || focus.id || focus.textContent : null,
      outputs: $('outputs').hidden ? null : [...document.querySelectorAll('.output')].map((o) => o.textContent),
      game: $('game').textContent,
      session: `${$('session').textContent}${$('session').classList.contains('warn') ? '|warn' : ''}`,
      cover: /** @type {HTMLImageElement} */ ($('cover')).hidden ? '' : $('cover').getAttribute('src'),
      chips: $('chips').textContent,
      volume: $('volumeText').textContent,
      hint: $('hint').textContent,
      message: $('message').textContent,
      news: document.querySelector('#news .text')?.textContent ?? '',
      calls: window.__calls,
    };
  });

/** The commands sent since `from` calls. */
const since = async (page, from) => (await view(page)).calls.slice(from).map(([cmd, args]) => (args ? `${cmd} ${JSON.stringify(args)}` : cmd));
const closes = async (page, from) => (await since(page, from)).filter((c) => c.startsWith('dock_close_game'));
/** A close as the page sends it: for the game `g` the dock shows, in its session. */
const closing = (force, g) => `dock_close_game ${JSON.stringify({ force, id: g.id, session: g.session })}`;

/** Cross held on the focused tile until its ring is full (or the hold is let go), then let go. */
async function hold(page) {
  await emit(page, 'dock-pad', 'ok');
  await until(page, () => !document.querySelector('.holding'));
  await emit(page, 'dock-pad', known('dock_release', 'ok-up'));
  await idle(page);
}

/** Where the focus ring is, and where the focused tile is, both inside the dock, in whole pixels. */
const ringOn = (page) =>
  page.evaluate(async () => {
    const ring = document.querySelector('#dock .ring');
    // Where each is on the screen.
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map(Math.round).join();
    };
    const now = () => {
      const tile = document.querySelector('.tile.focus');
      return { ring: box(ring), tile: tile ? box(tile) : null, on: ring.classList.contains('on') };
    };
    // Once it has sprung there, however slowly the frames come; after 3 s, wherever it is.
    for (const end = performance.now() + 3000; performance.now() < end; await new Promise((r) => setTimeout(r, 20))) {
      const at = now();
      if (at.on && at.ring === at.tile) break;
    }
    return now();
  });

/**
 * @param {object} t
 * @param {(opts: object, viewport?: object) => Promise<import('playwright-core').Page>} t.open
 * @param {(page: import('playwright-core').Page) => Promise<void>} t.close
 * @param {(name: string, ok: boolean, detail?: string) => void} t.check
 * @param {string} t.shots
 */
export async function dockTests({ open, close, check, shots }) {
  const openDock = async (data = {}, viewport = OPEN, screen = SCREEN) => {
    const page = await open({ games: [], file: 'dock.html', screen }, viewport);
    // The session started 72 minutes before this dock opens, however long the suite has run by now.
    const playing = { ...game, started: Math.floor(Date.now() / 1000) - 72 * 60 };
    await answers(page, { game: playing, sound, accessories: ipc('accessories'), quiet: ipc('quiet'), overlays: ipc('overlays'), ...data });
    await emit(page, 'dock', opened);
    await idle(page);
    // The spring starts once the dock's first frames come on time (dock/main.js open).
    await until(page, () => document.getElementById('island').dataset.mode === 'open');
    await settled(page);
    return page;
  };

  // D1. The dock springs open on Resume with a tile for everything it does, shows the game with its cover and how long
  // it has been played, every battery and the volume, and fits in its window; Circle goes back to the game, and
  // Rust's word folds it.
  {
    const page = await openDock();
    let v = await view(page);
    check('the dock opens on Resume', v.mode === 'open' && v.focus === 'resume' && v.hint.includes('Resume'), `${v.mode} ${v.focus} ${v.hint}`);
    check('the dock has Resume, output, quiet mode, stats, Home and Close game', JSON.stringify(v.tiles) === '["resume","output","quiet","stats","home","close"]', JSON.stringify(v.tiles));
    check('the dock reads what it shows when it opens', ['dock_state', 'sound_state', 'accessories_state', 'quiet_state', 'overlay_state'].every((c) => v.calls.some(([cmd]) => cmd === c)), JSON.stringify(v.calls));
    check('the top line names the game, how long it has been played, every battery and the volume', v.game === 'Half-Life' && v.session === 'Playing for 1 h 12 min' && v.chips === '60%Medium80%' && v.volume === '45%', `${v.game} ${v.session} ${v.chips} ${v.volume}`);
    check("the top line shows the game's cover", v.cover.includes(encodeURIComponent(game.art.portrait)), v.cover);
    check('a tile shows its state by its icon and has one label', v.values.output === 'TV' && v.values.quiet === 'Partly quiet|on|warn' && v.values.stats === 'Stats', JSON.stringify(v.values));
    const ring = await ringOn(page);
    check('the focus ring sits on Resume', ring.on && ring.ring === ring.tile, JSON.stringify(ring));
    const fit = await page.evaluate(() => {
      const island = document.getElementById('island').getBoundingClientRect();
      const dock = document.getElementById('dock').getBoundingClientRect();
      return { island: [island.left, island.top, island.right, island.bottom].map(Math.round), dock: [dock.width, dock.height].map(Math.round), size: [island.width, island.height].map(Math.round), vw: innerWidth, vh: innerHeight };
    });
    const [left, top, right, bottom] = fit.island;
    check(
      'the open dock fits its window, at the bottom centre, as big as what it shows',
      left > 0 && top > 0 && right < fit.vw && bottom < fit.vh && Math.abs(left + right - fit.vw) <= 2 && fit.size.join() === fit.dock.join(),
      JSON.stringify(fit)
    );
    await page.screenshot({ path: path.join(shots, 'dock-open.png'), omitBackground: true });
    const from = v.calls.length;
    await emit(page, 'dock-pad', known('pad', 'back'));
    check('Circle goes back to the game', (await since(page, from)).includes('dock_resume'), JSON.stringify(await since(page, from)));
    await emit(page, 'dock', closed);
    await settled(page);
    v = await view(page);
    const gone = await page.evaluate(() => getComputedStyle(document.getElementById('island')).opacity);
    check('the dock folds away when Rust says so', v.mode === 'gone' && gone === '0', `${v.mode} ${gone}`);
    await close(page);
  }

  // D2. The controller around the dock: the tiles left and right with the ring following, the volume above them,
  // the outputs in a list.
  {
    const page = await openDock();
    await emit(page, 'dock-pad', 'left');
    let v = await view(page);
    check('left of Resume is the edge', v.focus === 'resume', v.focus);
    await emit(page, 'dock-pad', 'right');
    await emit(page, 'dock-pad', 'right');
    const ring = await ringOn(page);
    check('the focus ring moves to the tile that has the focus', ring.on && ring.ring === ring.tile, JSON.stringify(ring));
    await emit(page, 'dock-pad', 'left');
    await emit(page, 'dock-pad', 'ok');
    await settled(page);
    v = await view(page);
    await page.screenshot({ path: path.join(shots, 'dock-output.png'), omitBackground: true });
    check('Cross on the output lists the outputs, on the one in use', v.focus?.startsWith('TV') && JSON.stringify(v.outputs) === '["TVIn use","PRO X 2 headset"]', `${v.focus} ${JSON.stringify(v.outputs)}`);
    const island = await page.evaluate(() => document.getElementById('island').offsetWidth);
    const marks = () => page.evaluate(() => [...document.querySelectorAll('.output')].map((o) => `${o.className.replace('output slot', '').trim()}|${o.querySelector('.check') ? 'check' : ''}`));
    check('the output in use has the check and its own look, apart from the focus', JSON.stringify(await marks()) === '["focus current|check","|"]', JSON.stringify(await marks()));
    let from = v.calls.length;
    await emit(page, 'dock-pad', 'down');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    v = await view(page);
    check('Cross on another output moves the check to it at once, and the list stays a moment to show it', JSON.stringify(v.outputs) === '["TV","PRO X 2 headsetIn use"]' && JSON.stringify(await marks()) === '["|","focus current picked|check"]', `${JSON.stringify(v.outputs)} ${JSON.stringify(await marks())}`);
    await until(page, () => document.getElementById('outputs').hidden);
    v = await view(page);
    check('then that output is the default, and the list closes', (await since(page, from)).includes(`sound_set_default {"id":"${headsetOut.id}"}`) && v.outputs === null && v.values.output === 'Headset', `${await since(page, from)} ${v.values.output}`);
    check('the island keeps its width while the list shows', island === (await page.evaluate(() => document.getElementById('island').offsetWidth)), String(island));
    await emit(page, 'dock-pad', 'up');
    from = v.calls.length;
    await emit(page, 'dock-pad', 'right');
    await emit(page, 'dock-pad', 'right');
    await idle(page);
    v = await view(page);
    check('up is the volume, where left and right change it', v.focus === 'volume' && v.volume === '55%' && (await since(page, from)).filter((c) => c === 'sound_change_volume {"delta":5}').length === 2 && v.hint.includes('Volume'), `${v.focus} ${v.volume} ${v.hint}`);
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    v = await view(page);
    check('Cross on the volume mutes', v.volume === 'Muted' && v.hint.includes('Unmute'), `${v.volume} ${v.hint}`);
    await emit(page, 'dock-pad', 'down');
    v = await view(page);
    check('down goes back to the tile it came from', v.focus === 'output', v.focus);
    await close(page);
  }

  // D3. Quiet mode, NVIDIA's stats and Home.
  {
    const page = await openDock({ quiet: like(ipc('quiet'), { state: known('quiet_state', 'off'), active: false, notes: [] }) });
    for (let i = 0; i < 2; i++) await emit(page, 'dock-pad', 'right');
    let v = await view(page);
    check('quiet mode off: its icon is dark', v.values.quiet === 'Quiet', v.values.quiet);
    let from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    v = await view(page);
    check('Cross on quiet mode switches it, lights its icon, and says what had to wait', (await since(page, from)).includes('quiet_set {"on":true}') && v.values.quiet === 'Quiet|on' && v.message.includes('Ubisoft'), `${v.values.quiet} ${v.message}`);
    // Windows' own settings were quiet before quiet mode went on, so switching it off leaves them quiet.
    await page.evaluate(() => {
      const s = window.__settings;
      s.quiet_set = ({ on }) => (s.quiet = { state: 'on', active: on, notes: [] });
    });
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    v = await view(page);
    check("Cross again switches quiet mode off, though Windows stays quiet, and says why", v.values.quiet === 'Quiet' && v.hint.includes('Turn on') && v.message.includes('already quiet'), `${v.values.quiet} ${v.hint} ${v.message}`);
    await emit(page, 'dock-pad', 'right');
    from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    v = await view(page);
    const toggles = (await since(page, from)).filter((c) => c === 'overlay_toggle_stats').length;
    check('the stats switch once, however often Cross is pressed while NVIDIA answers', toggles === 1 && v.values.stats === 'Stats|on', `${toggles} ${v.values.stats}`);
    await emit(page, 'dock-pad', 'right');
    from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    check('Home brings the home screen', (await since(page, from)).includes('dock_home'), JSON.stringify(await since(page, from)));
    await close(page);
  }

  // D4. Closing the game takes Cross held until the ring around its icon is full: let go early, or move on, and
  // nothing closes. A game that hangs is force closed the same way.
  {
    const page = await openDock();
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    let v = await view(page);
    check('Close game says to hold Cross', v.focus === 'close' && v.hint.includes('Hold to close game'), v.hint);
    let from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    v = await view(page);
    check('holding Cross fills the ring, and closes nothing yet', v.values.close === 'Close game|holding' && (await closes(page, from)).length === 0, v.values.close);
    await page.waitForTimeout(TAPPED_MS);
    await emit(page, 'dock-pad', known('dock_release', 'ok-up'));
    await page.waitForTimeout(HELD_MS);
    v = await view(page);
    check('let go early, the ring drains and the game stays', v.values.close === 'Close game' && (await closes(page, from)).length === 0, `${v.values.close} ${await closes(page, from)}`);
    await emit(page, 'dock-pad', 'ok');
    await emit(page, 'dock-pad', 'left');
    await page.waitForTimeout(HELD_MS);
    check('moving on lets go too', (await closes(page, from)).length === 0, JSON.stringify(await closes(page, from)));
    await emit(page, 'dock-pad', 'right');
    await hold(page);
    check('held until the ring is full, the game is asked to close', JSON.stringify(await closes(page, from)) === JSON.stringify([closing(false, game)]), JSON.stringify(await closes(page, from)));
    await page.evaluate((g) => (window.__settings.game = g), hung);
    await emit(page, 'dock', closed);
    await emit(page, 'dock', opened);
    await idle(page);
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    v = await view(page);
    check('a game that isn\'t responding offers Force close, and says so under its name', v.values.close === 'Force close|warn' && v.session === 'Not responding|warn' && v.hint.includes('Hold to force close'), `${v.values.close} ${v.session}`);
    from = v.calls.length;
    await page.screenshot({ path: path.join(shots, 'dock-force-close.png'), omitBackground: true });
    await hold(page);
    check('held, it ends the game', (await closes(page, from)).includes(closing(true, hung)), JSON.stringify(await closes(page, from)));
    // Rust refuses (a game run as administrator): the dock says so.
    await page.evaluate((error) => {
      window.__settings.dock_close_game = () => {
        throw error;
      };
    }, like(ipc('error'), { message: "Windows didn't let Lamplit end Half-Life." }));
    await hold(page);
    v = await view(page);
    check('a refused close says so under the tiles', v.message.includes("didn't let Lamplit end"), v.message);
    // Once the game has gone, its tile goes, and the focus with it.
    await page.evaluate(() => (window.__settings.game = null));
    await emit(page, 'dock', closed);
    await emit(page, 'dock', opened);
    await idle(page);
    v = await view(page);
    check('without a game there is nothing to close', !v.tiles.includes('close') && v.focus === 'resume', JSON.stringify(v.tiles));
    await close(page);
  }

  // D5. News: the folded pill shows it for a moment without the dock, and the dock opening takes over.
  {
    const page = await open({ games: [], file: 'dock.html', screen: SCREEN }, { width: 777, height: 172 });
    await emit(page, 'dock', status);
    await settled(page);
    let v = await view(page);
    const fit = await page.evaluate(() => {
      const r = document.getElementById('island').getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
    });
    check('news shows in the pill, warning in colour', v.mode === 'news' && v.news === status.text && (await page.evaluate(() => document.getElementById('news').classList.contains('warn'))), `${v.mode} ${v.news}`);
    check('the pill fits the small window news gets', fit.left > 0 && fit.right < fit.vw && fit.top > 0 && fit.bottom < fit.vh, JSON.stringify(fit));
    await page.screenshot({ path: path.join(shots, 'dock-news.png'), omitBackground: true });
    await until(page, () => document.getElementById('island').dataset.mode === 'gone');
    v = await view(page);
    check('news folds away by itself', v.mode === 'gone', v.mode);
    await emit(page, 'dock', like(status, { text: 'Headset on · 80%', icon: known('dock_icon', 'headset'), warn: false }));
    await emit(page, 'dock', opened);
    await emit(page, 'dock', status);
    // The island springs open once the dock's first frames have come on time (dock/main.js open).
    await until(page, () => document.getElementById('island').dataset.mode === 'open');
    v = await view(page);
    check('news waits while the dock is open', v.mode === 'open', v.mode);
    await close(page);
  }

  // D6. The keyboard (and Steam's mirror of the controller as keys), Xbox buttons in the hints, and the mouse.
  {
    const page = await openDock();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    let v = await view(page);
    check('the arrows move along the tiles', v.focus === 'quiet', v.focus);
    await emit(page, 'dock-pad', 'left');
    await page.keyboard.press('ArrowLeft');
    v = await view(page);
    check('a key right after a pad press is its mirror', v.focus === 'output', v.focus);
    await emit(page, 'pad-kind', known('pad_kind', 'xbox'));
    v = await view(page);
    check('the hints name Xbox buttons after an Xbox controller was used', v.hint.startsWith('AChoose') && v.hint.includes('BBack to game'), v.hint);
    let from = v.calls.length;
    await page.click('.tile[data-key="home"]');
    check('a click on a tile does what Cross would', (await since(page, from)).includes('dock_home'), JSON.stringify(await since(page, from)));
    from = (await view(page)).calls.length;
    await page.mouse.click(20, 20);
    check('a click beside the dock goes back to the game', (await since(page, from)).includes('dock_resume'), JSON.stringify(await since(page, from)));
    await close(page);
  }

  // D12. Holding Close game with Enter, and with the mouse button.
  {
    const page = await openDock();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    let from = (await view(page)).calls.length;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(HELD_MS);
    check('a tap of Enter closes nothing', (await closes(page, from)).length === 0, JSON.stringify(await closes(page, from)));
    await page.keyboard.down('Enter');
    await until(page, () => !document.querySelector('.holding'));
    await page.keyboard.up('Enter');
    await idle(page);
    check('Enter held closes the game', (await closes(page, from)).length === 1, JSON.stringify(await closes(page, from)));
    const box = await page.locator('.tile[data-key="close"]').boundingBox();
    from = (await view(page)).calls.length;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(TAPPED_MS);
    await page.mouse.up();
    await page.waitForTimeout(HELD_MS);
    check('a click on Close game closes nothing', (await closes(page, from)).length === 0, JSON.stringify(await closes(page, from)));
    await page.mouse.down();
    await until(page, () => !document.querySelector('.holding'));
    await page.mouse.up();
    await idle(page);
    check('the mouse button held on Close game closes the game', (await closes(page, from)).length === 1, JSON.stringify(await closes(page, from)));
    await close(page);
  }

  // D7. On a 4K TV the dock keeps its proportions in its window.
  {
    const page = await openDock({}, { width: 3840, height: 1296 }, { width: 3840, height: 2160 });
    const fit = await page.evaluate(() => {
      const r = document.getElementById('island').getBoundingClientRect();
      return { width: r.width / innerWidth, top: r.top / innerHeight, bottom: r.bottom / innerHeight, scroll: document.documentElement.scrollWidth - innerWidth };
    });
    check('4K: the dock is as big a share of the screen as at 1080p', fit.width > 0.5 && fit.width < 0.7 && fit.top > 0.1 && fit.bottom < 0.95 && fit.scroll === 0, JSON.stringify(fit));
    await close(page);
  }

  // D10. The open dock reads the game again: a game that stops responding turns Close game into Force close without
  // the dock opening again, and the folded dock stops asking.
  {
    const page = await openDock();
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    let v = await view(page);
    check('Close game, for a game that answers', v.values.close === 'Close game', v.values.close);
    await page.evaluate((g) => (window.__settings.game = g), hung);
    await until(page, () => document.querySelector('.tile[data-key="close"] .label')?.textContent === 'Force close');
    v = await view(page);
    check('the open dock offers Force close once the game stops responding', v.values.close === 'Force close|warn', v.values.close);
    const from = v.calls.length;
    await hold(page);
    check('held, it then ends the game', (await closes(page, from)).includes(closing(true, hung)), JSON.stringify(await closes(page, from)));
    await emit(page, 'dock', closed);
    const reads = async () => (await view(page)).calls.filter(([cmd]) => cmd === 'dock_state').length;
    const folded = await reads();
    await page.waitForTimeout(2500);
    check('the folded dock stops reading the game', (await reads()) === folded, `${folded} then ${await reads()}`);
    await close(page);
  }

  // D13. The dock opens on what it knew of the game. A close held before Rust answers names that game and session,
  // so Rust, which closes only the game that runs now, refuses it when another took its place.
  {
    const page = await openDock();
    await emit(page, 'dock', closed);
    const other = like(game, { id: 'steam:80', name: 'Other game', session: game.session + 1 });
    await page.evaluate((now) => {
      const s = window.__settings;
      // Rust answers when the test says so.
      window.__answers = [];
      s.dock_state = () => new Promise((resolve) => window.__answers.push(() => resolve(now)));
      // As Rust does: a close for a game or session that doesn't run now is refused.
      s.dock_close_game = ({ id, session }) => {
        if (id !== now.id || session !== now.session) throw { kind: 'player', message: 'The game has already closed.' };
      };
    }, other);
    await emit(page, 'dock', opened);
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    const from = (await view(page)).calls.length;
    await hold(page);
    const sent = await closes(page, from);
    check('a close held before Rust answers names the game and session the dock showed', JSON.stringify(sent) === JSON.stringify([closing(false, game)]), JSON.stringify(sent));
    const v = await view(page);
    check('Rust refuses it, and the dock says so', v.message.includes('already closed'), v.message);
    await page.evaluate(() => window.__answers.splice(0).forEach((a) => a()));
    await close(page);
  }

  // D14. The same game started again: a reading during a hold that names its new session lets go of the hold, and a
  // hold sends the session it began on.
  {
    const page = await openDock();
    await emit(page, 'dock', closed);
    const restarted = like(game, { session: game.session + 1 });
    const later = () =>
      page.evaluate((now) => {
        window.__answers = [];
        window.__settings.dock_state = () => new Promise((resolve) => window.__answers.push(() => resolve(now)));
      }, restarted);
    const answer = () => page.evaluate(() => window.__answers.splice(0).forEach((a) => a()));
    await later();
    await emit(page, 'dock', opened);
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    let from = (await view(page)).calls.length;
    await emit(page, 'dock-pad', 'ok');
    await answer();
    await page.waitForTimeout(HELD_MS);
    let v = await view(page);
    check('a reading that names a new session of the game lets go of the hold', v.values.close === 'Close game' && (await closes(page, from)).length === 0, `${v.values.close} ${await closes(page, from)}`);
    // Held again, on the new session: that is the session the close names.
    from = v.calls.length;
    await hold(page);
    check('a hold sends the session it began on', JSON.stringify(await closes(page, from)) === JSON.stringify([closing(false, restarted)]), JSON.stringify(await closes(page, from)));
    await close(page);
  }

  // D15. News of the accessories while the dock's first reading is on its way: the sound and the accessories are read
  // again, and the rest of the first reading, quiet mode and NVIDIA's stats, still shows when it comes.
  {
    const page = await open({ games: [], file: 'dock.html', screen: SCREEN }, OPEN);
    await answers(page, { game, sound, accessories: ipc('accessories'), quiet: ipc('quiet'), overlays: ipc('overlays') });
    // Quiet mode and the overlays answer when the test says so.
    await page.evaluate(() => {
      const s = window.__settings;
      window.__answers = [];
      const later = (value) => () => new Promise((resolve) => window.__answers.push(() => resolve(value)));
      s.quiet_state = later({ state: 'on', active: true, notes: [] });
      s.overlay_state = later({ nvidia_overlay: true, nvidia_stats: true });
    });
    await emit(page, 'dock', opened);
    await emit(page, 'accessories', null);
    await until(page, () => window.__calls.filter(([cmd]) => cmd === 'accessories_state').length >= 2);
    await page.evaluate(() => window.__answers.splice(0).forEach((a) => a()));
    await idle(page);
    const v = await view(page);
    check('quiet mode and the stats from the first reading show, after news of the accessories', v.values.quiet === 'Quiet|on' && v.values.stats === 'Stats|on', JSON.stringify(v.values));
    await close(page);
  }

  // D11. A hold of Close game was for the offer and the game the player saw: when an answer from Rust turns it into
  // Force close, or names another game, the hold is let go and nothing closes.
  {
    const page = await openDock();
    await emit(page, 'dock', closed);
    // Rust answers when the test says so.
    const later = (g) =>
      page.evaluate((answer) => {
        window.__answers = [];
        window.__settings.dock_state = () => new Promise((resolve) => window.__answers.push(() => resolve(answer)));
      }, g);
    const answer = () => page.evaluate(() => window.__answers.splice(0).forEach((a) => a()));
    await later(hung);
    await emit(page, 'dock', opened);
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    let from = (await view(page)).calls.length;
    await emit(page, 'dock-pad', 'ok');
    let v = await view(page);
    check('before Rust answers, the dock holds for the game it knew', v.values.close === 'Close game|holding', v.values.close);
    await answer();
    await page.waitForTimeout(HELD_MS);
    v = await view(page);
    check('an answer that turns Close game into Force close lets go of the hold', v.values.close === 'Force close|warn' && (await closes(page, from)).length === 0, `${v.values.close} ${await closes(page, from)}`);
    // Another game with the same offer: the next reading names it while Cross is held.
    await later(like(hung, { id: 'steam:90', name: 'Third game' }));
    // The open dock's next reading of the game, which Rust answers when the test says so.
    await until(page, () => window.__answers.length > 0);
    from = (await view(page)).calls.length;
    await emit(page, 'dock-pad', 'ok');
    await answer();
    await page.waitForTimeout(HELD_MS);
    v = await view(page);
    check('a hold for one game is no hold for the next', v.game === 'Third game' && v.values.close === 'Force close|warn' && (await closes(page, from)).length === 0, `${v.game} ${v.values.close} ${await closes(page, from)}`);
    await close(page);
  }

  // D16. Home: a veil in the game's colours comes over the game and the island grows into it, while only Circle still
  // counts; once Rust has the home screen behind the veil it folds the dock, which lifts the veil. Circle on the way
  // goes back to the game instead, and the next opening starts without the veil.
  {
    const page = await openDock();
    const veil = () => page.evaluate(() => ['home', 'lift'].filter((c) => document.body.classList.contains(c)).join(' ') || 'none');
    const docks = async (from) => (await since(page, from)).filter((c) => c === 'dock_home' || c === 'dock_resume');
    for (let i = 0; i < 4; i++) await emit(page, 'dock-pad', 'right');
    let v = await view(page);
    let from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    await emit(page, 'dock-pad', 'left');
    v = await view(page);
    check('Home brings the veil and asks Rust for the home screen, and the controller no longer moves the dock', (await veil()) === 'home' && (await docks(from)).join() === 'dock_home' && v.focus === 'home', `${await veil()} ${await docks(from)} ${v.focus}`);
    await emit(page, 'dock', closed);
    await settled(page);
    v = await view(page);
    check('folded behind the home screen, the dock lifts its veil', (await veil()) === 'home lift' && v.mode === 'gone', `${await veil()} ${v.mode}`);
    await emit(page, 'dock', opened);
    await idle(page);
    check('the next opening starts without the veil', (await veil()) === 'none', await veil());
    for (let i = 0; i < 4; i++) await emit(page, 'dock-pad', 'right');
    from = (await view(page)).calls.length;
    await emit(page, 'dock-pad', 'ok');
    await emit(page, 'dock-pad', 'back');
    check('Circle on the way home goes back to the game', (await docks(from)).join() === 'dock_home,dock_resume', JSON.stringify(await docks(from)));
    await close(page);
  }

  // D17. Real glass: once the island rests open the page asks Rust for glass where the island is, and where Rust has
  // it, the island's own glass fades away over it. Before the island moves again (the list of outputs, folding), its
  // own glass is back first, and the real glass goes after.
  {
    const page = await openDock();
    await page.evaluate(() => (window.__settings.dock_glass = ({ island }) => island !== null));
    const glass = () => page.evaluate(() => document.getElementById('island').classList.contains('glass'));
    const asks = async (from) => (await since(page, from)).filter((c) => c.startsWith('dock_glass {')).map((c) => (c.endsWith('null}') ? 'none' : 'island'));
    let from = (await view(page)).calls.length;
    await emit(page, 'dock', closed);
    await emit(page, 'dock', opened);
    await until(page, () => document.getElementById('island').classList.contains('glass'));
    const island = await page.evaluate(() => {
      const b = document.getElementById('island').getBoundingClientRect();
      return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, radius: parseFloat(getComputedStyle(document.getElementById('island')).borderTopLeftRadius) });
    });
    const asked = (await since(page, from)).find((c) => c.startsWith('dock_glass {"island":{'));
    check('resting open, the island asks for real glass where it is, and takes it', (await glass()) && asked === `dock_glass {"island":${island}}`, `${await glass()} ${asked} ${island}`);
    from = (await view(page)).calls.length;
    await emit(page, 'dock-pad', 'right');
    await emit(page, 'dock-pad', 'ok');
    const during = await glass();
    await until(page, () => document.getElementById('island').classList.contains('glass'));
    check('the list of outputs grows the island: its own glass is back first, and the real glass comes again once it rests', !during && (await glass()) && (await asks(from)).join() === 'none,island', `${during} ${await glass()} ${await asks(from)}`);
    from = (await view(page)).calls.length;
    await emit(page, 'dock', closed);
    await page.waitForTimeout(150);
    const folding = await glass();
    const pill = await page.evaluate(() => {
      const u = screen.height / 100;
      const b = document.getElementById('island').getBoundingClientRect();
      return JSON.stringify({ x: b.x + (b.width - 18 * u) / 2, y: b.y + (b.height - 5.2 * u), width: 18 * u, height: 5.2 * u, radius: 2.6 * u });
    });
    const squeezed = (await since(page, from)).find((c) => c.startsWith('dock_glass_fold'));
    const to = squeezed ? JSON.parse(squeezed.slice('dock_glass_fold '.length)).fold.to : {};
    const same = Object.entries(JSON.parse(pill)).every(([k, v]) => Math.abs(to[k] - v) < 0.01);
    await until(page, () => document.getElementById('island').classList.contains('rested'));
    check('folding, the island is squeezed on the real glass, which Rust squeezes into the same pill, and is on its own glass once out of sight', folding && !(await glass()) && same && (await asks(from)).length === 0, `${folding} ${await glass()} ${JSON.stringify(to)} ${pill}`);
    await close(page);
  }

  // D18. Folding moves nothing the page must lay out or paint again: the island keeps its size, frame by frame, and a
  // clip squeezes it into the pill, on the compositor. Out of sight it is the pill again, and the log has a line with
  // the fold's frames.
  {
    const page = await openDock();
    await until(page, () => window.__calls.some(([cmd]) => cmd === 'dock_glass'));
    await idle(page);
    const frames = page.evaluate(
      () =>
        new Promise((resolve) => {
          const island = document.getElementById('island');
          const seen = [];
          const step = () => {
            const s = getComputedStyle(island);
            seen.push(`${island.offsetWidth}x${island.offsetHeight}|${s.clipPath}|${Number(s.opacity) > 0 ? 'shows' : 'gone'}`);
            // Until the window hides (dock/mod.rs FOLD), before the island is the pill again.
            if (performance.now() - start < 540) requestAnimationFrame(step);
            else resolve(seen);
          };
          const start = performance.now();
          requestAnimationFrame(step);
        })
    );
    const before = await page.evaluate(() => `${document.getElementById('island').offsetWidth}x${document.getElementById('island').offsetHeight}`);
    await emit(page, 'dock', closed);
    const seen = await frames;
    const sizes = new Set(seen.map((f) => f.split('|')[0]));
    const clips = new Set(seen.map((f) => f.split('|')[1]));
    const moves = await page.evaluate(() => getComputedStyle(document.getElementById('island')).transitionProperty);
    check('folding keeps the island its size, frame by frame, and squeezes it with a clip, a drop and a fade', sizes.size === 1 && sizes.has(before) && clips.size > 5 && seen.some((f) => f.endsWith('gone')) && moves === 'clip-path, opacity, translate', `${[...sizes]} ${clips.size} ${moves} ${seen.at(-1)}`);
    await until(page, () => document.getElementById('island').classList.contains('rested') && window.__logs.some((l) => l.includes('dock: fold')));
    const rested = await page.evaluate(() => {
      const island = document.getElementById('island');
      return { pill: island.style.width === '' && island.classList.contains('rested'), logs: window.__logs.filter((l) => l.includes('dock: fold')) };
    });
    check('out of sight it is the pill again, and the log says how the fold ran', rested.pill && rested.logs.length === 1 && /^info dock: fold \d+ frames, worst \d+ ms, 95% \d+ ms$/.test(rested.logs[0]), JSON.stringify(rested));
    await close(page);
  }

  // D20. Folding, what the dock shows goes with its face as that fades: the tiles, the top line and the hints stay on it
  // to the end, rather than leaving the focus ring alone on an empty island, and only then take their places for the
  // next opening, out of sight.
  {
    const page = await openDock();
    await until(page, () => window.__calls.some(([cmd]) => cmd === 'dock_glass'));
    await idle(page);
    const frames = page.evaluate(
      () =>
        new Promise((resolve) => {
          const opacity = (el) => Number(getComputedStyle(el).opacity);
          const [face, parts] = [document.getElementById('dock'), [...document.querySelectorAll('#top, .tile, #hint')]];
          const seen = [];
          const start = performance.now();
          const step = () => {
            seen.push({ face: opacity(face), parts: Math.min(...parts.map(opacity)), ring: opacity(document.querySelector('#dock .ring')) });
            // On until the face and what it shows have gone, however slowly the frames come (3 s at most).
            const gone = seen.at(-1).face === 0 && seen.at(-1).parts === 0;
            if (performance.now() - start < 250 || (!gone && performance.now() - start < 3000)) requestAnimationFrame(step);
            else resolve(seen);
          };
          requestAnimationFrame(step);
        })
    );
    await emit(page, 'dock', closed);
    const seen = await frames;
    const showing = seen.filter((f) => f.face > 0.05);
    const fades = new Set(showing.map((f) => f.face.toFixed(2))).size;
    check('folding, the tiles, top line and hints fade with the face, and take their places once it has gone', showing.length > 1 && fades > 1 && showing.every((f) => f.parts === 1) && seen.at(-1).face === 0 && seen.at(-1).parts === 0, JSON.stringify(seen.map((f) => `${f.face.toFixed(2)}/${f.parts.toFixed(2)}`)));
    await close(page);
  }

  // D21. With reduced motion the island fades in place in 150 ms rather than springing: opening, in its open shape from
  // its first frame, with what it shows; folding, keeping that shape until it has gone, on real glass that Rust fades
  // where it is. Home's veil fades the same way, and the island fades into it without growing, its real glass gone
  // before Rust is asked for the home screen.
  {
    const page = await openDock();
    await page.evaluate(() => (window.__settings.dock_glass = ({ island }) => island !== null));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await emit(page, 'dock', closed);
    await until(page, () => document.getElementById('island').classList.contains('rested'));
    /** The island frame by frame for `ms`, or `opening` until it shows in full: how much shows, its shape, and how much of its tiles. */
    const frames = (ms, opening = false) =>
      page.evaluate(
        ([ms, opening]) =>
          new Promise((resolve) => {
            const [island, dock, tile] = [document.getElementById('island'), document.getElementById('dock'), document.querySelector('.tile')];
            const seen = [];
            const start = performance.now();
            const step = () => {
              const s = getComputedStyle(island);
              const tiles = Number(getComputedStyle(dock).opacity) * Number(getComputedStyle(tile).opacity);
              // Resting open, the island's rounded corners clip it rather than a clip-path (D27), the same shape on
              // the screen as inset(0 round its radius).
              const clip = s.clipPath === 'none' && s.overflow === 'hidden' ? `inset(0px round ${s.borderTopLeftRadius})` : s.clipPath;
              seen.push({ shows: Number(s.opacity), shape: `${clip}|${s.scale}|${s.translate}|${s.borderRadius}`, tiles });
              // Opening, on until it shows in full, however slowly the frames come (3 s at most).
              const shown = !opening || seen.at(-1).shows === 1;
              if (performance.now() - start < ms || (!shown && performance.now() - start < 3000)) requestAnimationFrame(step);
              else resolve(seen);
            };
            requestAnimationFrame(step);
          }),
        [ms, opening]
      );
    const fades = (seen) => seen.filter((f) => f.shows > 0.02 && f.shows < 0.98).length;
    const opening = frames(400, true);
    await emit(page, 'dock', opened);
    let seen = (await opening).filter((f) => f.shows > 0);
    const open = seen.at(-1);
    check('reduced motion: the dock fades open in place, in its open shape and with its tiles from the first frame', fades(seen) >= 2 && open.shows === 1 && seen.every((f) => f.shape === open.shape && f.tiles === 1), JSON.stringify(seen.map((f) => `${f.shows.toFixed(2)} ${f.tiles.toFixed(2)} ${f.shape}`)));
    await until(page, () => document.getElementById('island').classList.contains('glass'));
    const glass = () => page.evaluate(() => document.getElementById('island').classList.contains('glass'));
    const onGlass = await glass();
    const shape = await page.evaluate(() => {
      const b = document.getElementById('island').getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, radius: parseFloat(getComputedStyle(document.getElementById('island')).borderTopLeftRadius) };
    });
    let from = (await view(page)).calls.length;
    const folding = frames(300);
    await emit(page, 'dock', closed);
    seen = (await folding).filter((f) => f.shows > 0);
    const asked = (await since(page, from)).find((c) => c.startsWith('dock_glass_fold'));
    const fold = asked ? JSON.parse(asked.slice('dock_glass_fold '.length)).fold : {};
    const inPlace = fold.ms === 1 && fold.after === 0 && fold.fade === 150 && fold.drop === 0 && Object.entries(shape).every(([k, v]) => Math.abs(fold.to[k] - v) < 0.01);
    check('reduced motion: folding, it fades where it is, keeping its shape and tiles, and the real glass fades there too', onGlass && fades(seen) >= 2 && seen.every((f) => f.shape === open.shape && f.tiles === 1) && inPlace, `${onGlass} ${JSON.stringify(fold)} ${JSON.stringify(seen.map((f) => `${f.shows.toFixed(2)} ${f.tiles.toFixed(2)} ${f.shape}`))}`);
    await until(page, () => document.getElementById('island').classList.contains('rested'));
    await emit(page, 'dock', opened);
    await until(page, () => document.getElementById('island').classList.contains('glass'));
    for (let i = 0; i < 4; i++) await emit(page, 'dock-pad', 'right');
    from = (await view(page)).calls.length;
    const home = page.evaluate(
      () =>
        new Promise((resolve) => {
          const [island, veil] = [document.getElementById('island'), document.getElementById('veil')];
          const seen = [];
          const start = performance.now();
          const step = () => {
            seen.push({ veil: Number(getComputedStyle(veil).opacity), scale: getComputedStyle(island).scale });
            if (performance.now() - start < 300) requestAnimationFrame(step);
            else resolve(seen);
          };
          requestAnimationFrame(step);
        })
    );
    await emit(page, 'dock-pad', 'ok');
    seen = await home;
    const calls = (await since(page, from)).filter((c) => c.startsWith('dock_glass') || c === 'dock_home');
    check('reduced motion: Home fades the veil in, and the island into it without growing, off its real glass first', seen.filter((f) => f.veil > 0.02 && f.veil < 0.98).length >= 2 && seen.every((f) => f.scale === 'none' || f.scale === '1') && calls.join() === 'dock_glass {"island":null},dock_home', `${calls} ${JSON.stringify(seen.map((f) => `${f.veil.toFixed(2)} ${f.scale}`))}`);
    await close(page);
  }

  // D22. The focus ring: opening, it comes on Resume with Resume itself, rather than ahead of it on a bare island; a
  // step moves it on a spring that settles on the next tile without going past it.
  {
    const page = await openDock();
    await emit(page, 'dock', closed);
    await until(page, () => document.getElementById('island').classList.contains('rested'));
    const opening = page.evaluate(
      () =>
        new Promise((resolve) => {
          const shows = (el) => Number(getComputedStyle(el).opacity);
          const [dock, ring] = [document.getElementById('dock'), document.querySelector('#dock .ring')];
          const seen = [];
          const start = performance.now();
          const step = () => {
            const resume = document.querySelector('.tile.primary');
            seen.push([shows(dock) * shows(ring), shows(dock) * shows(resume)]);
            // On until the ring shows in full, however slowly the frames come (3 s at most).
            if (performance.now() - start < 700 || (seen.at(-1)[0] !== 1 && performance.now() - start < 3000)) requestAnimationFrame(step);
            else resolve(seen);
          };
          requestAnimationFrame(step);
        })
    );
    await emit(page, 'dock', opened);
    let seen = await opening;
    const ahead = Math.max(...seen.map(([ring, resume]) => ring - resume));
    check('opening, the focus ring comes on Resume with Resume, not ahead of it', ahead < 0.15 && seen.at(-1)[0] === 1, `${ahead.toFixed(2)} ${JSON.stringify(seen.map(([a, b]) => `${a.toFixed(2)}/${b.toFixed(2)}`))}`);
    await settled(page);
    const stepping = page.evaluate(
      () =>
        new Promise((resolve) => {
          const ring = document.querySelector('#dock .ring');
          const xs = [];
          const start = performance.now();
          const step = () => {
            xs.push(parseFloat(getComputedStyle(ring).translate));
            // On until the ring has come to rest, however slowly the frames come (3 s at most).
            const moving = ring.getAnimations().length > 0;
            if (performance.now() - start < 600 || (moving && performance.now() - start < 3000)) requestAnimationFrame(step);
            else resolve(xs);
          };
          requestAnimationFrame(step);
        })
    );
    await emit(page, 'dock-pad', 'right');
    const xs = await stepping;
    const to = xs.at(-1);
    check('a step moves the ring onto the next tile without going past it', xs[0] < to && Math.max(...xs) <= to + 0.5, `${to} ${JSON.stringify(xs.map((x) => Math.round(x * 10) / 10))}`);
    await close(page);
  }

  // D23. The list of outputs grows out of its tile: clipped to the tile at first, with the focus ring still on the
  // tile where it was on the screen, and its rows yet to fade in; then open all round.
  {
    const page = await openDock();
    await emit(page, 'dock-pad', 'right');
    await settled(page);
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, right: b.right, bottom: b.bottom, left: b.left };
    };
    const tile = await page.evaluate((box) => new Function(`return ${box}`)()(document.querySelector('.tile[data-key="output"]')), box.toString());
    const growing = page.evaluate(
      (box) =>
        new Promise((resolve) => {
          const at = new Function(`return ${box}`)();
          const [outputs, list, ring] = [document.getElementById('outputs'), document.getElementById('outputList'), document.querySelector('#dock .ring')];
          const seen = [];
          const start = performance.now();
          const step = () => {
            if (!outputs.hidden) seen.push({ clip: getComputedStyle(outputs).clipPath, rows: Number(getComputedStyle(list).opacity), ring: at(ring), list: at(outputs) });
            // On until the list has opened, however slowly the frames come (3 s at most).
            const open = seen.length > 0 && outputs.getAnimations().length === 0 && seen.at(-1).rows === 1;
            if (performance.now() - start < 700 || (!open && performance.now() - start < 3000)) requestAnimationFrame(step);
            else resolve(seen);
          };
          requestAnimationFrame(step);
        }),
      box.toString()
    );
    await emit(page, 'dock-pad', 'ok');
    const seen = await growing;
    /** A clip's insets, as top, right, bottom and left. */
    const insets = (clip) => {
      const [t, r = t, b = t, l = r] = (clip.split(' round')[0].match(/-?[\d.]+px/g) ?? []).map(parseFloat);
      return [t, r, b, l];
    };
    const [first, last] = [seen[0], seen.at(-1)];
    const from = [tile.top - first.list.top, first.list.right - tile.right, first.list.bottom - tile.bottom, tile.left - first.list.left];
    const near = (a, b) => a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) < 1);
    const ringOnTile = near(Object.values(first.ring), Object.values(tile));
    check('the list of outputs grows out of its tile: clipped to it first, the ring still on it, the rows yet to come', near(insets(first.clip), from) && ringOnTile && first.rows < 0.1, `${first.clip} ${JSON.stringify(from)} ${JSON.stringify(first.ring)} ${JSON.stringify(tile)} ${first.rows}`);
    check('... and then it is open all round, its rows shown', insets(last.clip).every((n) => n < 0) && last.rows === 1, `${last.clip} ${last.rows}`);
    await close(page);
  }

  // D24. The island's own glass, where Windows has no real glass: the game's art blurred into soft colour, shown at
  // half strength with no colour boost, so art with a hard edge between bright yellow and black reads as a calm
  // gradient rather than shapes.
  {
    const page = await openDock();
    const dir = mkdtempSync(path.join(tmpdir(), 'lamplit-dock-art-'));
    const file = path.join(dir, 'hero.png');
    const png = await page.evaluate(() => {
      const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#f5e600';
      g.fillRect(0, 0, 320, 360);
      return c.toDataURL('image/png').split(',')[1];
    });
    writeFileSync(file, Buffer.from(png, 'base64'));
    await emit(page, 'dock', closed);
    await page.evaluate((art) => (window.__settings.game = { ...window.__settings.game, id: 'steam:edge', art }), { portrait: file, hero: file, logo: null });
    await emit(page, 'dock', opened);
    await until(page, () => document.getElementById('island').classList.contains('art'));
    await settled(page);
    const glass = await page.evaluate(() => {
      const canvas = document.getElementById('backdrop');
      const row = canvas.getContext('2d').getImageData(0, canvas.height >> 1, canvas.width, 1).data;
      const light = [];
      for (let i = 0; i < row.length; i += 4) light.push(0.2126 * row[i] + 0.7152 * row[i + 1] + 0.0722 * row[i + 2]);
      const steepest = Math.max(...light.slice(1).map((l, i) => Math.abs(l - light[i])));
      const s = getComputedStyle(canvas);
      const boost = Math.max(1, ...[...s.filter.matchAll(/saturate\(([\d.]+)\)/g)].map((m) => Number(m[1])));
      return { steepest, spread: Math.max(...light) - Math.min(...light), opacity: Number(s.opacity), boost };
    });
    rmSync(dir, { recursive: true, force: true });
    check('the art glass softens a hard edge into a gradient, at half strength and with no colour boost', glass.spread > 60 && glass.steepest < 12 && glass.opacity <= 0.5 && glass.boost === 1, JSON.stringify(glass));
    await close(page);
  }

  // D25. The dock moves on the springs both pages share (ui/springs.js): the island opens on lift and folds on close,
  // the real glass folding on the same curve, and the focus ring steps on snap.
  {
    const page = await openDock();
    await page.evaluate(() => (window.__settings.dock_glass = ({ island }) => island !== null));
    /** How long `el`'s transition of `property` runs, and on what curve. */
    const timing = (sel, property) =>
      page.evaluate(
        ([sel, property]) => {
          const s = getComputedStyle(document.querySelector(sel));
          const i = s.transitionProperty.split(', ').indexOf(property);
          return { ms: Math.round(parseFloat(s.transitionDuration.split(', ')[i]) * 1000), curve: s.transitionTimingFunction.split(/, (?=linear|cubic|ease)/)[i] };
        },
        [sel, property]
      );
    /** A spring's points, from its curve as the page computes it: linear(0 0%, 0.0184 2.5%, ...). */
    const points = (curve) => JSON.stringify(curve.slice('linear('.length, -1).split(', ').map((stop) => Number(stop.split(' ')[0])));
    const on = (timed, name) => timed.ms === SPRINGS[name].ms && points(timed.curve) === JSON.stringify(SPRINGS[name].points);
    await emit(page, 'dock', closed);
    await until(page, () => document.getElementById('island').classList.contains('rested'));
    await emit(page, 'dock', opened);
    await until(page, () => document.getElementById('island').dataset.mode === 'open');
    const opening = await timing('#island', 'clip-path');
    // At rest on its real glass, which then folds with it (dock/main.js takeGlass); the ring steps on its spring by then.
    await until(page, () => document.getElementById('island').classList.contains('glass'));
    const step = await timing('#dock .ring', 'translate');
    const from = (await view(page)).calls.length;
    await emit(page, 'dock', closed);
    const folding = await timing('#island', 'clip-path');
    const asked = (await since(page, from)).find((c) => c.startsWith('dock_glass_fold'));
    const fold = asked ? JSON.parse(asked.slice('dock_glass_fold '.length)).fold : {};
    const ok =
      on(opening, 'lift') && on(folding, 'close') && on(step, 'snap') &&
      fold.ms === SPRINGS.close.ms && JSON.stringify(fold.curve) === JSON.stringify(SPRINGS.close.points);
    check('the island opens on the lift spring and folds on close, its glass too, and the ring steps on snap', ok, JSON.stringify({ opening: opening.ms, folding: folding.ms, step: step.ms, fold: fold.ms }));
    await close(page);
  }

  // D27. Over a game every dock frame is drawn at the GPU's low clocks, so a step paints nothing again: the focus
  // moves as opacity (icon, label, the tile's light) and the ring as translate, which the compositor draws. Resting
  // open, the island's corners clip it rather than a clip-path, which costs a pass of its own every frame; folding
  // still squeezes it from its full shape (D18).
  {
    const page = await openDock();
    // At rest, once it has asked for its real glass (dock/main.js takeGlass).
    await until(page, () => document.getElementById('island').classList.contains('still'));
    const rest = await page.evaluate(() => {
      const s = getComputedStyle(document.getElementById('island'));
      return { clip: s.clipPath, radius: parseFloat(s.borderTopLeftRadius), overflow: s.overflow };
    });
    await emit(page, 'dock-pad', 'right');
    await settled(page);
    await emit(page, 'dock-pad', 'right');
    const moving = await page.evaluate(() => [...new Set(document.getAnimations().map((a) => a.transitionProperty ?? a.animationName))].sort());
    const look = await page.evaluate(() => {
      const opacity = (sel) => Number(getComputedStyle(document.querySelector(sel)).opacity);
      return { focused: opacity('.tile.focus .label'), other: opacity('.tile[data-key="home"] .label') };
    });
    check('a step moves the focus as opacity and the ring as translate, and nothing is painted again', moving.length > 0 && moving.every((p) => ['opacity', 'scale', 'translate'].includes(p)), JSON.stringify(moving));
    check('resting open, the island is clipped by its corners, not a clip-path', rest.clip === 'none' && rest.radius > 0 && rest.overflow === 'hidden', JSON.stringify(rest));
    await settled(page);
    const after = await page.evaluate(() => ({ focused: Number(getComputedStyle(document.querySelector('.tile.focus .label')).opacity), other: Number(getComputedStyle(document.querySelector('.tile[data-key="home"] .label')).opacity) }));
    check('the focused tile is lit and the others dimmed, by opacity', after.focused === 1 && after.other === 0.7, JSON.stringify({ during: look, after }));
    await close(page);
  }

  // D19. A game starting gets the hidden dock ready: it reads what it shows and draws it then. Its first opening then
  // springs open on a clip at its own size, with nothing laid out frame by frame.
  {
    const page = await open({ games: [], file: 'dock.html', screen: SCREEN }, OPEN);
    const playing = { ...game, started: Math.floor(Date.now() / 1000) - 72 * 60 };
    await answers(page, { game: playing, sound, accessories: ipc('accessories'), quiet: ipc('quiet'), overlays: ipc('overlays') });
    await emit(page, 'play', like(ipc('play').find((p) => p.state === 'running'), { id: game.id }));
    await idle(page);
    let v = await view(page);
    const ready = ['dock_state', 'sound_state', 'accessories_state', 'quiet_state', 'overlay_state'].every((c) => v.calls.some(([cmd]) => cmd === c));
    check('a game starting gets the hidden dock ready: it reads what it shows', ready && v.mode === 'gone' && v.game === 'Half-Life', `${ready} ${v.mode} ${v.game}`);
    const from = v.calls.length;
    const frames = page.evaluate(
      () =>
        new Promise((resolve) => {
          const island = document.getElementById('island');
          const seen = [];
          const start = performance.now();
          const step = () => {
            if (island.dataset.mode === 'open') seen.push(`${island.offsetWidth}x${island.offsetHeight}|${getComputedStyle(island).clipPath}`);
            if (performance.now() - start < 500) requestAnimationFrame(step);
            else resolve(seen);
          };
          requestAnimationFrame(step);
        })
    );
    await emit(page, 'dock', opened);
    const seen = await frames;
    const sizes = new Set(seen.map((f) => f.split('|')[0]));
    const clips = new Set(seen.map((f) => f.split('|')[1]));
    check('the first opening springs open on a clip at its own size', sizes.size === 1 && clips.size > 5, `${[...sizes]} ${clips.size}`);
    await close(page);
  }

  // D8. Every icon the dock draws is one of the icons both pages share (ui/icons.js), from the set the page mounts:
  // Resume is Play, and Close game has a glyph of its own rather than the power symbol. Drawn in every state that
  // changes an icon: the tiles (quiet on, the stats, Force close), the list of outputs, the volume muted, the news and
  // the hints for both controllers.
  {
    const page = await openDock({ game: { ...hung, closable: true } });
    await page.evaluate(() => {
      const seen = (window.__drawn = new Set());
      const note = () => document.querySelectorAll('use').forEach((u) => seen.add(u.getAttribute('href')));
      note();
      new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
    });
    const tile = (key) => page.evaluate((key) => document.querySelector(`.tile[data-key="${key}"] use`)?.getAttribute('href'), key);
    const [play, closeGame] = [await tile('resume'), await tile('close')];
    await emit(page, 'dock-pad', 'right');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    await emit(page, 'dock-pad', 'back');
    await emit(page, 'dock-pad', 'up');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    await emit(page, 'pad-kind', known('pad_kind', 'xbox'));
    await emit(page, 'dock', closed);
    for (const icon of ['headset', 'controller']) await emit(page, 'dock', like(status, { icon: known('dock_icon', icon) }));
    const drawn = await page.evaluate(() => [...window.__drawn].map((href) => ({ href, mounted: !!document.querySelector(`#icons ${href}`) })));
    const missing = drawn.filter((d) => !d.mounted || !(d.href.slice(1) in ICONS)).map((d) => d.href);
    check("every icon the dock draws is a shared one, Resume's Play and Close game's own", drawn.length > 15 && missing.length === 0 && play === '#i-play' && closeGame === '#i-close-game', `${missing.join(', ')} ${play} ${closeGame} ${drawn.length}`);
    await close(page);
  }

  // D9. Settings > Overlay and pop-ups switches the dock off.
  {
    const page = await open({ games: [] });
    await page.evaluate((prefs) => {
      const s = (window.__settings = { prefs, overlay_state: { nvidia_overlay: false, nvidia_stats: null }, quiet_state: { state: 'off', active: false, notes: [] } });
      s.prefs_state = () => s.prefs;
      s.prefs_set_dock = ({ on }) => ((s.prefs.dock = on), s.prefs);
    }, ipc('prefs'));
    await page.keyboard.press('c');
    await idle(page);
    const focused = () => page.evaluate(() => document.querySelector('#settingsList .row.focus')?.textContent ?? '');
    const goTo = async (label) => {
      for (let i = 0; i < 12 && !(await focused()).startsWith(label); i++) await page.keyboard.press('ArrowDown');
    };
    await goTo('Overlay and pop-ups');
    await page.keyboard.press('Enter');
    await idle(page);
    await goTo('Dock over games');
    const before = await focused();
    await page.keyboard.press('Enter');
    await idle(page);
    const calls = await page.evaluate(() => window.__calls.map(([c, a]) => `${c} ${JSON.stringify(a ?? {})}`));
    const after = await focused();
    check('Settings switches the dock off', before.endsWith('On') && calls.includes('prefs_set_dock {"on":false}') && after.endsWith('Off'), `${before} ${after}`);
    await close(page);
  }
}
