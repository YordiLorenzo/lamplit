// Lamplit's page in Chromium with a fake Tauri API, for ui.test.mjs and screenshots.mjs. The page is served the way
// Tauri serves it on Windows (from http://tauri.localhost, art from http://asset.localhost) under the CSP in
// tauri.conf.json, so a script, style or image the policy blocks fails to load.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rust } from './contract.mjs';
import { values } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const pageOrigin = 'http://tauri.localhost';
export const assetOrigin = 'http://asset.localhost';
const { csp } = JSON.parse(readFileSync(path.join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8')).app.security;
export const cspHeader = Object.entries(csp)
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join('; ');

/** The commands Rust registers, with the argument keys each takes. */
export const commands = Object.fromEntries(rust().defined);

// Installed before the page's own scripts: records calls and log lines, lets tests emit events. A command answers
// from window.__settings, else from `replies`, else with null. Like Tauri, it refuses a command Rust doesn't register
// or arguments that aren't the command's, and hands over copies (the page never shares an object with the test). An
// event with a pad step, controller kind, step state or account Rust never sends (tests/ipc/values.json) is a mistake
// in the test.
// earlyGames: a 'games' event brings this list while the answer to library_games (`games`) is still on its way.
// padKind: the kind of controller Rust says was used last, before the page listened.
const fakeTauri = ({ games, running = null, launchError = null, earlyGames = null, padKind = null }) => `
  const commands = ${JSON.stringify(commands)};
  const values = ${JSON.stringify(values)};
  const sent = {
    pad: (step) => values.pad.includes(step),
    'dock-pad': (step) => values.pad.includes(step),
    dock: (show) => show.mode !== 'status' || values.dock_icon.includes(show.icon),
    'pad-kind': (kind) => values.pad_kind.includes(kind),
    'launch-step': (step) => values.step_state.includes(step.state),
    stores: (list) => list.every((s) => values.account.includes(s.account)),
  };
  window.__calls = [];
  window.__pending = 0;
  window.__logs = [];
  window.__listeners = {};
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
  document.addEventListener('securitypolicyviolation', (e) =>
    window.__errors.push('CSP blocked ' + e.blockedURI + ' (' + e.violatedDirective + ')'));
  const replies = {
    library_games: ${JSON.stringify(games)},
    launch_running: ${JSON.stringify(running)},
    stores_status: [],
    controller_kind: ${JSON.stringify(padKind)},
  };
  const early = ${JSON.stringify(earlyGames)};
  window.__TAURI__ = {
    core: {
      convertFileSrc: (p) => '${assetOrigin}/' + encodeURIComponent(p),
      invoke: async (cmd, args) => {
        window.__calls.push([cmd, args]);
        window.__pending++;
        try {
          if (!commands[cmd]) throw 'command ' + cmd + ' not found';
          const keys = Object.keys(args ?? {}).sort().join();
          if (keys !== [...commands[cmd]].sort().join()) throw 'invalid args {' + keys + '} for command ' + cmd;
          if (cmd === 'launch_start' && ${JSON.stringify(launchError)}) throw ${JSON.stringify(launchError)};
          if (cmd === 'library_games' && early) await new Promise((r) => setTimeout(r, 100));
          const fake = window.__settings?.[cmd] ?? replies[cmd];
          return structuredClone(await (typeof fake === 'function' ? fake(args) : fake ?? null));
        } finally {
          window.__pending--;
        }
      },
    },
    event: {
      listen: async (name, cb) => {
        (window.__listeners[name] ??= []).push(cb);
        if (name === 'games' && early) setTimeout(() => cb({ payload: early }), 0);
        return () => {};
      },
    },
    log: Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, async (msg) => window.__logs.push(level + ' ' + msg)])),
  };
  window.__emit = (name, payload) => {
    if (sent[name] && !sent[name](payload)) throw new Error('Rust never sends this ' + name + ': ' + JSON.stringify(payload));
    (window.__listeners[name] ?? []).forEach((cb) => cb({ payload: structuredClone(payload) }));
  };
`;

/** Answers with a file from disk, or 404 when there is none. */
export const serveFile = (route, file, headers) =>
  existsSync(file) ? route.fulfill({ path: file, headers }) : route.fulfill({ status: 404 });

/**
 * Opens the page in `uiDir` in a new tab and waits until it is ready. `opts` are the fake Tauri's (see fakeTauri),
 * plus `now`: a Date the page's clock stands still at, `clock`: Playwright's fake timers, so a test can move the
 * page's time on with page.clock (the screensaver's minutes without input), `file`: the page to open, the dock's
 * (dock.html) rather than index.html, and `screen`: the size of the screen, when the page's window covers only part of
 * it (the dock's).
 * @param {import('playwright-core').Browser} browser
 * @param {string} uiDir
 */
export async function open(browser, uiDir, opts, viewport = { width: 1920, height: 1080 }) {
  const page = await browser.newPage({ viewport, screen: opts.screen ?? viewport });
  if (opts.now) await page.clock.setFixedTime(opts.now);
  if (opts.clock) await page.clock.install();
  await page.route(`${pageOrigin}/**`, (route) =>
    serveFile(route, path.join(uiDir, new URL(route.request().url()).pathname), { 'Content-Security-Policy': cspHeader })
  );
  // The hero image is read back to sample its colour, which needs the CORS header Tauri's asset protocol sends.
  await page.route(`${assetOrigin}/**`, (route) =>
    serveFile(route, decodeURIComponent(new URL(route.request().url()).pathname.slice(1)), {
      'Access-Control-Allow-Origin': pageOrigin,
    })
  );
  await page.addInitScript(fakeTauri(opts));
  await page.goto(`${pageOrigin}/${opts.file ?? 'index.html'}`);
  await page.waitForFunction(() => window.__logs.some((line) => line.startsWith('info ready')));
  return page;
}

/** Sends the page an event, as Rust would. */
export const emit = (page, name, payload) => page.evaluate(([n, p]) => window.__emit(n, p), [name, payload]);
/** Waits until `fn` holds in the page; after 3 s it gives up and leaves the next check to report what it sees. */
export const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 3000 }).catch(() => {});
/** Waits until every command the page called has answered. */
export const idle = (page) => until(page, () => window.__pending === 0);
/** Waits for transitions and one-off animations to end (the hero's drift never does), for layout and screenshots. */
export const settled = (page) =>
  until(page, () => document.getAnimations().every((a) => a.effect.getTiming().iterations === Infinity));
