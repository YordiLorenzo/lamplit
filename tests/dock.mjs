// The in-game dock's page (ui/dock.html) in Chromium with the fake Tauri, run by ui.test.mjs: opening and folding,
// every tile, the controller, keyboard and mouse, news, and its size in the window Rust gives it. And the switch in
// Settings that turns the dock off.
import path from 'node:path';
import { pageFile } from './contract.mjs';
import { ipc, known, like } from './fixtures.mjs';
import { emit, idle, settled, until } from './page.mjs';

/** The dock's window while open: the bottom 60% of a 1080p screen (src-tauri/src/dock/window.rs). */
const OPEN = { width: 1920, height: 648 };
const SCREEN = { width: 1920, height: 1080 };

const [opened, closed, status] = ipc('dock');
const game = like(ipc('dock-game'), { responding: true, force_close: false });
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

const view = (page) =>
  page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const tiles = [...document.querySelectorAll('.tile')];
    const focus = document.querySelector('.slot.focus');
    return {
      mode: $('island').dataset.mode,
      tiles: tiles.map((t) => t.dataset.key),
      values: Object.fromEntries(tiles.map((t) => [t.dataset.key, `${t.querySelector('.label').textContent}|${t.querySelector('.value').textContent}`])),
      focus: focus ? focus.dataset.key || focus.id || focus.textContent : null,
      outputs: $('outputs').hidden ? null : [...document.querySelectorAll('.output')].map((o) => o.textContent),
      game: $('game').textContent,
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
    await answers(page, { game, sound, accessories: ipc('accessories'), quiet: ipc('quiet'), overlays: ipc('overlays'), ...data });
    await emit(page, 'dock', opened);
    await idle(page);
    await settled(page);
    return page;
  };

  // D1. The dock springs open on Resume with a tile for everything it does, names the game and every battery, and
  // fits in its window; Circle goes back to the game, and Rust's word folds it.
  {
    const page = await openDock();
    let v = await view(page);
    check('the dock opens on Resume', v.mode === 'open' && v.focus === 'resume' && v.hint.includes('Resume'), `${v.mode} ${v.focus} ${v.hint}`);
    check('the dock has Resume, output, quiet mode, stats, Home and Close game', JSON.stringify(v.tiles) === '["resume","output","quiet","stats","home","close"]', JSON.stringify(v.tiles));
    check('the dock reads what it shows when it opens', ['dock_state', 'sound_state', 'accessories_state', 'quiet_state', 'overlay_state'].every((c) => v.calls.some(([cmd]) => cmd === c)), JSON.stringify(v.calls));
    check('the top line names the game and every battery', v.game === 'Half-Life' && v.chips === '60%Medium80%' && v.volume === '45%', `${v.game} ${v.chips} ${v.volume}`);
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

  // D2. The controller around the dock: the tiles left and right, the volume above them, the outputs in a list.
  {
    const page = await openDock();
    await emit(page, 'dock-pad', 'left');
    let v = await view(page);
    check('left of Resume is the edge', v.focus === 'resume', v.focus);
    await emit(page, 'dock-pad', 'right');
    await emit(page, 'dock-pad', 'ok');
    v = await view(page);
    await settled(page);
    await page.screenshot({ path: path.join(shots, 'dock-output.png'), omitBackground: true });
    check('Cross on the output lists the outputs, on the one in use', v.focus?.startsWith('TV') && JSON.stringify(v.outputs) === '["TVIn use","PRO X 2 headset"]', `${v.focus} ${JSON.stringify(v.outputs)}`);
    let from = v.calls.length;
    await emit(page, 'dock-pad', 'down');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    v = await view(page);
    check('Cross on another output makes it the default, and the list closes', (await since(page, from)).includes(`sound_set_default {"id":"${headsetOut.id}"}`) && v.outputs === null && v.values.output === 'Output|PRO X 2 headset', `${await since(page, from)} ${v.values.output}`);
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
    let from = (await view(page)).calls.length;
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    let v = await view(page);
    check('Cross on quiet mode switches it, and says what had to wait', (await since(page, from)).includes('quiet_set {"on":true}') && v.values.quiet === 'Quiet mode|On' && v.message.includes('Ubisoft'), `${v.values.quiet} ${v.message}`);
    await emit(page, 'dock-pad', 'right');
    from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    v = await view(page);
    const toggles = (await since(page, from)).filter((c) => c === 'overlay_toggle_stats').length;
    check('the stats switch once, however often Cross is pressed while NVIDIA answers', toggles === 1 && v.values.stats === 'Stats|On', `${toggles} ${v.values.stats}`);
    await emit(page, 'dock-pad', 'right');
    from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    check('Home brings the home screen', (await since(page, from)).includes('dock_home'), JSON.stringify(await since(page, from)));
    await close(page);
  }

  // D4. Closing the game asks once; leaving the tile asks again; a game that hangs is force closed.
  {
    const page = await openDock();
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    let from = (await view(page)).calls.length;
    await emit(page, 'dock-pad', 'ok');
    let v = await view(page);
    check('Cross on Close game asks again first', v.focus === 'close' && v.values.close === 'Close game|Press again' && !(await since(page, from)).some((c) => c.startsWith('dock_close_game')), `${v.values.close}`);
    await emit(page, 'dock-pad', 'left');
    await emit(page, 'dock-pad', 'right');
    v = await view(page);
    check('leaving Close game takes the question back', v.values.close === 'Close game|', v.values.close);
    await emit(page, 'dock-pad', 'ok');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    check('Cross twice asks the game to close', (await since(page, from)).includes('dock_close_game {"force":false}'), JSON.stringify(await since(page, from)));
    await page.evaluate((hung) => (window.__settings.game = hung), ipc('dock-game'));
    await emit(page, 'dock', closed);
    await emit(page, 'dock', opened);
    await idle(page);
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    v = await view(page);
    check('a game that isn\'t responding offers a forced close', v.values.close === 'Force close|Not responding', v.values.close);
    from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    check('Cross twice ends it', (await since(page, from)).includes('dock_close_game {"force":true}'), JSON.stringify(await since(page, from)));
    // Rust refuses (a game run as administrator): the dock says so.
    await page.evaluate((error) => {
      window.__settings.dock_close_game = () => {
        throw error;
      };
    }, like(ipc('error'), { message: "Windows didn't let Lamplit end Half-Life." }));
    await emit(page, 'dock-pad', 'ok');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    v = await view(page);
    check('a refused close says so under the tiles', v.message.includes("didn't let Lamplit end"), v.message);
    await settled(page);
    await page.screenshot({ path: path.join(shots, 'dock-force-close.png'), omitBackground: true });
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

  // D7. On a 4K TV the dock keeps its proportions in its window.
  {
    const page = await openDock({}, { width: 3840, height: 1296 }, { width: 3840, height: 2160 });
    const fit = await page.evaluate(() => {
      const r = document.getElementById('island').getBoundingClientRect();
      return { width: r.width / innerWidth, top: r.top / innerHeight, bottom: r.bottom / innerHeight, scroll: document.documentElement.scrollWidth - innerWidth };
    });
    check('4K: the dock is as big a share of the screen as at 1080p', fit.width > 0.4 && fit.width < 0.6 && fit.top > 0.1 && fit.bottom < 0.95 && fit.scroll === 0, JSON.stringify(fit));
    await close(page);
  }

  // D10. The open dock reads the game again: a game that stops responding turns Close game into Force close without
  // the dock opening again, a press already asked for starts over, and the folded dock stops asking.
  {
    const page = await openDock();
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    await emit(page, 'dock-pad', 'ok');
    let v = await view(page);
    check('Close game waits for a second press', v.values.close === 'Close game|Press again', v.values.close);
    await page.evaluate((hung) => (window.__settings.game = hung), ipc('dock-game'));
    await until(page, () => document.querySelector('.tile[data-key="close"] .label')?.textContent === 'Force close');
    v = await view(page);
    check('the open dock offers Force close once the game stops responding, and asks first', v.values.close === 'Force close|Not responding', v.values.close);
    const from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    check('Cross twice then ends the game', (await since(page, from)).includes('dock_close_game {"force":true}'), JSON.stringify(await since(page, from)));
    await emit(page, 'dock', closed);
    const reads = async () => (await view(page)).calls.filter(([cmd]) => cmd === 'dock_state').length;
    const folded = await reads();
    await page.waitForTimeout(2500);
    check('the folded dock stops reading the game', (await reads()) === folded, `${folded} then ${await reads()}`);
    await close(page);
  }

  // D11. The dock opens on what it knew of the game. A press of Close game made before Rust answers was for that
  // offer: when the answer turns it into Force close, or names another game, the next press asks again.
  {
    const page = await openDock();
    await emit(page, 'dock', closed);
    // Rust answers when the test says so.
    await page.evaluate((hung) => {
      window.__answers = [];
      window.__settings.dock_state = () => new Promise((resolve) => window.__answers.push(() => resolve(hung)));
    }, ipc('dock-game'));
    await emit(page, 'dock', opened);
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    await emit(page, 'dock-pad', 'ok');
    let v = await view(page);
    check('before Rust answers, the dock asks about the game it knew', v.values.close === 'Close game|Press again', v.values.close);
    await page.evaluate(() => window.__answers.forEach((answer) => answer()));
    await idle(page);
    v = await view(page);
    check('an answer that turns Close game into Force close takes back the press', v.values.close === 'Force close|Not responding', v.values.close);
    let from = v.calls.length;
    await emit(page, 'dock-pad', 'ok');
    await idle(page);
    v = await view(page);
    check('the next press asks again rather than forcing the game closed', !(await since(page, from)).some((c) => c.startsWith('dock_close_game')) && v.values.close === 'Force close|Press again', `${v.values.close} ${JSON.stringify(await since(page, from))}`);
    // Another game runs now, with the same offer: a press asked for the old one asks again.
    await page.evaluate((other) => {
      window.__settings.dock_state = () => other;
    }, like(ipc('dock-game'), { id: 'steam:80', name: 'Other game' }));
    await emit(page, 'dock', closed);
    await emit(page, 'dock', opened);
    await idle(page);
    for (let i = 0; i < 5; i++) await emit(page, 'dock-pad', 'right');
    await emit(page, 'dock-pad', 'ok');
    await page.evaluate((hung) => (window.__settings.dock_state = () => hung), like(ipc('dock-game'), { id: 'steam:90', name: 'Third game' }));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2300)));
    v = await view(page);
    check('a press asked for one game is no press for the next', v.values.close === 'Force close|Not responding' && v.game === 'Third game', `${v.values.close} ${v.game}`);
    await close(page);
  }

  // D8. The dock draws the controller's buttons with index.html's own symbols.
  {
    const symbols = (file) => pageFile(file).match(/<symbol id="btn-[\s\S]*?<\/symbol>/g) ?? [];
    const dock = symbols('dock.html');
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
