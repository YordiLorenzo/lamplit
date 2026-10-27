// The in-game dock's page (ui/dock.html) in Chromium with the fake Tauri, run by ui.test.mjs: opening and folding,
// every tile, holding Cross to close a game, the controller, keyboard and mouse, the game's art and play time, news,
// and its size in the window Rust gives it. And the switch in Settings that turns the dock off.
import path from 'node:path';
import { pageFile } from './contract.mjs';
import { ipc, known, like } from './fixtures.mjs';
import { emit, idle, settled, until } from './page.mjs';

/** The dock's window while open: a 1080p screen (src-tauri/src/dock/window.rs). */
const OPEN = { width: 1920, height: 1080 };
const SCREEN = { width: 1920, height: 1080 };
/** Longer than Close game's hold (ui/dock/logic.js HOLD_MS), and well shorter. */
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
      news: $('newsText').textContent,
      calls: window.__calls,
    };
  });

/** The commands sent since `from` calls. */
const since = async (page, from) => (await view(page)).calls.slice(from).map(([cmd, args]) => (args ? `${cmd} ${JSON.stringify(args)}` : cmd));
const closes = async (page, from) => (await since(page, from)).filter((c) => c.startsWith('dock_close_game'));
/** A close as the page sends it: for the game `g` the dock shows, in its session. */
const closing = (force, g) => `dock_close_game ${JSON.stringify({ force, id: g.id, session: g.session })}`;

/** Cross held on the focused tile for `ms`, then let go. */
async function hold(page, ms) {
  await emit(page, 'dock-pad', 'ok');
  await page.waitForTimeout(ms);
  await emit(page, 'dock-pad', known('dock_release', 'ok-up'));
  await idle(page);
}

/** Where the focus ring is, and where the focused tile is, both inside the dock, in whole pixels. */
const ringOn = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        // After the ring's own frame of layout, and its spring.
        setTimeout(() => {
          const ring = document.getElementById('ring');
          const dock = document.getElementById('dock');
          const tile = document.querySelector('.tile.focus');
          const box = (el) => {
            let [x, y, n] = [0, 0, el];
            while (n && n !== dock) [x, y, n] = [x + n.offsetLeft, y + n.offsetTop, n.offsetParent];
            return [x, y, el.offsetWidth, el.offsetHeight].map(Math.round).join();
          };
          const s = getComputedStyle(ring);
          const at = [s.getPropertyValue('--x'), s.getPropertyValue('--y'), s.getPropertyValue('--w'), s.getPropertyValue('--h')]
            .map((v) => Math.round(parseFloat(v)))
            .join();
          resolve({ ring: at, tile: tile ? box(tile) : null, on: ring.classList.contains('on') });
        }, 450)
      )
  );

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
    await page.waitForTimeout(800);
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
    await hold(page, HELD_MS);
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
    await hold(page, HELD_MS);
    check('held, it ends the game', (await closes(page, from)).includes(closing(true, hung)), JSON.stringify(await closes(page, from)));
    // Rust refuses (a game run as administrator): the dock says so.
    await page.evaluate((error) => {
      window.__settings.dock_close_game = () => {
        throw error;
      };
    }, like(ipc('error'), { message: "Windows didn't let Lamplit end Half-Life." }));
    await hold(page, HELD_MS);
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
    await page.waitForTimeout(HELD_MS);
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
    await page.waitForTimeout(HELD_MS);
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
    await hold(page, HELD_MS);
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
    await hold(page, HELD_MS);
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
    await hold(page, HELD_MS);
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
    await page.waitForTimeout(2200);
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
    const asks = async (from) => (await since(page, from)).filter((c) => c.startsWith('dock_glass')).map((c) => (c.endsWith('null}') ? 'none' : 'island'));
    let from = (await view(page)).calls.length;
    await emit(page, 'dock', closed);
    await emit(page, 'dock', opened);
    await page.waitForTimeout(1000);
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
    await page.waitForTimeout(1100);
    check('the list of outputs grows the island: its own glass is back first, and the real glass comes again once it rests', !during && (await glass()) && (await asks(from)).join() === 'none,island', `${during} ${await glass()} ${await asks(from)}`);
    from = (await view(page)).calls.length;
    await emit(page, 'dock', closed);
    await page.waitForTimeout(150);
    const fading = await glass();
    await page.waitForTimeout(400);
    check('folding, the island fades on the real glass, which Rust fades with it, and is on its own glass once out of sight', fading && !(await glass()) && (await asks(from)).length === 0, `${fading} ${await glass()} ${await asks(from)}`);
    await close(page);
  }

  // D18. Folding moves nothing the page must lay out or paint again: the island keeps its size and only fades and
  // shrinks a little, frame by frame, on the compositor. Out of sight it is the pill again, and the log has a line
  // with the fold's frames.
  {
    const page = await openDock();
    await page.waitForTimeout(800);
    const frames = page.evaluate(
      () =>
        new Promise((resolve) => {
          const island = document.getElementById('island');
          const seen = [];
          const step = () => {
            const s = getComputedStyle(island);
            seen.push(`${island.offsetWidth}x${island.offsetHeight}|${s.scale}|${Number(s.opacity) > 0 ? 'shows' : 'gone'}`);
            // Until the window hides (dock/mod.rs FOLD), before the island is the pill again.
            if (performance.now() - start < 320) requestAnimationFrame(step);
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
    const moves = await page.evaluate(() => getComputedStyle(document.getElementById('island')).transitionProperty);
    check('folding keeps the island its size, frame by frame, and moves only its scale and opacity', sizes.size === 1 && sizes.has(before) && seen.some((f) => f.endsWith('gone')) && moves === 'scale, opacity', `${[...sizes]} ${moves} ${seen.at(-1)}`);
    await page.waitForTimeout(500);
    const rested = await page.evaluate(() => {
      const island = document.getElementById('island');
      return { pill: island.style.width === '' && island.classList.contains('rested'), logs: window.__logs.filter((l) => l.includes('dock: fold')) };
    });
    check('out of sight it is the pill again, and the log says how the fold ran', rested.pill && rested.logs.length === 1 && /^info dock: fold \d+ frames, worst \d+ ms$/.test(rested.logs[0]), JSON.stringify(rested));
    await close(page);
  }

  // D8. The dock draws the controller's buttons with index.html's own symbols.
  {
    const symbols = (file) => pageFile(file).match(/<symbol id="btn-[\s\S]*?<\/symbol>/g) ?? [];
    // Up and Down are the dock's own: the home screen's hints don't name the d-pad.
    const dock = symbols('dock.html').filter((s) => !/id="btn-(up|down)"/.test(s));
    const missing = dock.filter((s) => !symbols('index.html').includes(s));
    check("the dock's button symbols are the home screen's", dock.length === 3 && missing.length === 0, missing.join('\n'));
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
