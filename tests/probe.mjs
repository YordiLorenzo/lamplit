// The frame probe (ui/probe.js), run by ui.test.mjs: off in a normal build, where the pages never load it, and on with
// the script Rust adds in a build with debug assertions (src-tauri/src/probe.rs), where each interaction logs a line.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipc, like } from './fixtures.mjs';
import { emit, until } from './page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The script probe.rs adds to every page, read from the Rust source so the two can't drift apart. */
const script = JSON.parse(readFileSync(path.join(here, '..', 'src-tauri', 'src', 'probe.rs'), 'utf8').match(/const SCRIPT: &str = ("[^"]*");/)[1]);
const LINE = /^info probe: (home|dock) ([\w-]+) frames (\d+), p50 [\d.]+, p95 [\d.]+, p99 [\d.]+, worst ([\d.]+) ms, long tasks \d+ \(max \d+ ms\)/;

/** Opens a page, noting whether it asked for probe.js. */
async function openNoting(open, opts) {
  const asked = [];
  const page = await open({ ...opts, init: opts.init ?? null });
  page.on('request', (r) => r.url().endsWith('/probe.js') && asked.push(r.url()));
  // The requests before the page was ready went by before the listener: the page's own list has them.
  const loaded = await page.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.endsWith('/probe.js')));
  return { page, asked: () => loaded || asked.length > 0 };
}
const probeLines = (page) => page.evaluate(() => window.__logs.filter((l) => l.startsWith('info probe')));

export async function probeTests({ open, close, check, games }) {
  const dockAnswers = (page) =>
    page.evaluate(
      (d) => {
        window.__settings = { dock_state: d.game, sound_state: d.sound, accessories_state: d.accessories, quiet_state: d.quiet, overlay_state: d.overlays };
      },
      { game: like(ipc('dock-game'), { responding: true, force_close: false }), sound: ipc('sound'), accessories: ipc('accessories'), quiet: ipc('quiet'), overlays: ipc('overlays') }
    );

  // P1. A normal build: neither page loads the probe, and moving about logs no probe lines.
  {
    const { page, asked } = await openNoting(open, { games });
    for (const key of ['ArrowRight', 'i', 'Escape', 'c', 'Escape']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(900);
    check('a normal build: the home screen never loads the probe', !asked(), '');
    const lines = await probeLines(page);
    check('... and logs no probe lines', lines.length === 0, JSON.stringify(lines));
    await close(page);
  }
  {
    const { page, asked } = await openNoting(open, { games: [], file: 'dock.html' });
    await dockAnswers(page);
    await emit(page, 'dock', ipc('dock')[0]);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1200);
    const lines = await probeLines(page);
    check('a normal build: the dock never loads the probe, nor logs its lines', !asked() && lines.length === 0, JSON.stringify(lines));
    await close(page);
  }

  // P2. With Rust's script: one line per interaction, named from the press and the screen, the first of each cold.
  {
    const { page, asked } = await openNoting(open, { games, init: script });
    await until(page, () => window.__logs.some((l) => l.startsWith('info probe: home on')));
    check('a measurement build: the home screen loads the probe', asked(), '');
    /** A key, then the wait until its interaction has ended and logged its line. */
    const run = async (key, name) => {
      const count = () => page.evaluate((n) => window.__logs.filter((l) => l.startsWith(`info probe: home ${n} `)).length, name);
      const before = await count();
      await page.keyboard.press(key);
      await until(page, ([n, k]) => window.__logs.filter((l) => l.startsWith(`info probe: home ${n} `)).length > k, [name, before]);
    };
    await run('ArrowRight', 'row-step');
    await run('ArrowRight', 'row-step');
    await run('i', 'lift-open');
    await run('Escape', 'lift-close');
    await run('f', 'find-open');
    await run('x', 'find-type');
    // Brought forward over a game: the page settles in on its own, which the summon names.
    await emit(page, 'summoned', 'pc:1');
    await until(page, () => window.__logs.some((l) => l.startsWith('info probe: home arrive ')));
    const lines = await probeLines(page);
    const runs = lines.map((l) => l.match(LINE)).filter(Boolean);
    check(
      'each interaction logs one line with its frames, named from the press and the screen',
      JSON.stringify(runs.map((m) => m[2])) === JSON.stringify(['row-step', 'row-step', 'lift-open', 'lift-close', 'find-open', 'find-type', 'arrive']) &&
        runs.every((m) => Number(m[3]) > 1),
      JSON.stringify(lines)
    );
    const steps = lines.filter((l) => l.includes(' row-step '));
    check('the first of each interaction is cold, the next one not', steps[0]?.includes(', cold,') && !steps[1]?.includes('cold'), JSON.stringify(steps));
    await close(page);
  }
  {
    const { page } = await openNoting(open, { games: [], file: 'dock.html', init: script });
    await until(page, () => window.__logs.some((l) => l.startsWith('info probe: dock on')));
    await dockAnswers(page);
    await emit(page, 'dock', ipc('dock')[0]);
    await until(page, () => window.__logs.some((l) => l.startsWith('info probe: dock dock-open ')));
    await page.keyboard.press('ArrowRight');
    await until(page, () => window.__logs.some((l) => l.startsWith('info probe: dock dock-step ')));
    const lines = (await probeLines(page)).filter((l) => LINE.test(l));
    check('a measurement build: the dock logs its opening and its steps', lines.map((l) => l.match(LINE)[2]).join() === 'dock-open,dock-step', JSON.stringify(lines));
    await close(page);
  }
}
