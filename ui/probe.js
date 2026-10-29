// @ts-check
// The frame probe, in measurement builds only: Rust tells the pages so (src-tauri/src/probe.rs), and main.js and
// dock/main.js load this then. Each interaction, from the press that starts it until its animations have ended and
// the page has kept still for IDLE_MS, adds one line to lamplit.log:
//
//   probe: <page> <interaction> frames N, p50 A, p95 B, p99 C, worst D ms, long tasks K (max M ms)
//
// The frame times are the gaps between requestAnimationFrame's timestamps, from the last frame before the press, so
// the press's own work counts. Then the main thread's work per frame, which tells a frame that would miss 120 Hz's
// 8.3 ms on a screen running at 60 Hz. Then, where they apply: the long animation frames, the late frames and when
// they came, the time from the press to its first frame and to the paint after it, how many presses it took (a held
// direction, typing), `cold` for the first of its name since the page started, `cut` when another press ended it
// early, and the wall-clock time of the press. The longest frames get a line of their own (probe-detail), with the
// scripts that ran in them, and every frame's gap and work follow in a probe-frames line, for percentiles over many
// runs. The interaction is named from the press and what was on screen then: lift-open, row-step,
// settings-section-sound, dock-output-open. A plate changing shape (morph.js) adds a probe-morph line of its own.

import * as api from './api.js';

/** The page keeps still this long after its last animation or change: the interaction has ended. */
const IDLE_MS = 150;
/** An interaction that never keeps still ends here. */
const LONGEST_MS = 8000;
/** How often the probe looks whether the page keeps still: between frames, where looking costs next to nothing. */
const LOOK_MS = 40;
/** Long animation frames over this get a probe-detail line, the longest two of an interaction. */
const DETAIL_MS = 50;

const page = location.pathname.endsWith('dock.html') ? 'dock' : 'home';

/**
 * @typedef {{ name: string, t0: number, frames: number[], work: number[], inputs: number, busy: number, end: number, cut: boolean,
 *   hidden: boolean, after?: number }} Run
 */
/** @type {Run | null} */
let run = null;
/** The names seen since the page started: the first of each is cold. */
const named = new Set();

// ---------- frames and long tasks ----------

/** A frame at 120 Hz. */
const FRAME_120 = 1000 / 120;
/** The last frame drawn; a press counts from it. */
let lastFrame = 0;
/** The main thread's work on a frame: from its start to the first task after it was drawn. */
const drawn = new MessageChannel();
// A frame's timestamp can be a little ahead of the clock (the vsync it is drawn for).
drawn.port1.onmessage = (e) => run?.work.push(Math.max(0, performance.now() - e.data));
/** @param {number} t */
function frame(t) {
  lastFrame = t;
  if (run) {
    run.frames.push(t);
    drawn.port2.postMessage(t);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** @type {Record<string, any[]>} the entries of each kind lately, for the interaction they fall in */
const entries = { longtask: [], 'long-animation-frame': [], event: [] };
/** @param {string} type @param {object} [options] */
function observe(type, options = {}) {
  if (!PerformanceObserver.supportedEntryTypes.includes(type)) return false;
  new PerformanceObserver((list) => {
    const kept = entries[type];
    kept.push(...list.getEntries());
    if (kept.length > 300) kept.splice(0, kept.length - 300);
  }).observe({ type, ...options });
  return true;
}
const hasLongTasks = observe('longtask');
const hasLongFrames = observe('long-animation-frame');
// Event Timing reports a press that took 16 ms or more to its next paint.
observe('event', { durationThreshold: 16 });

// ---------- interactions ----------

const HELD = ['row-step', 'row-edge', 'row-held'];

/**
 * A press, or an event that changes the screen, starts interaction `name`. More of the same while one plays joins it
 * (a held direction, typing); anything else ends it and starts its own.
 * @param {string | null} name
 * @param {number} [t0]  when it happened, on performance.now()'s clock
 */
function begin(name, t0 = performance.now()) {
  if (!name) return;
  if (run && (run.name === name || (HELD.includes(run.name) && HELD.includes(name)))) {
    if (HELD.includes(name)) run.name = 'row-held';
    run.inputs++;
    run.busy = performance.now();
    return;
  }
  if (run) {
    run.cut = true;
    finish();
  }
  // From the last frame before the press, unless the page hasn't drawn lately (a window that was hidden).
  const frames = t0 - lastFrame < 50 ? [lastFrame] : [];
  const r = (run = { name, t0, frames, work: [], inputs: 1, busy: performance.now(), end: 0, cut: false, hidden: false });
  const look = () => {
    if (run !== r) return;
    const now = performance.now();
    if (moving()) r.busy = now;
    if (now - r.busy >= IDLE_MS || now - r.t0 >= LONGEST_MS) finish();
    else setTimeout(look, LOOK_MS);
  };
  setTimeout(look, LOOK_MS);
}

/** Something on screen changed: the interaction playing now goes on. */
function touch() {
  if (run) run.busy = performance.now();
}

/**
 * An event from Rust that names an interaction. The page may have drawn it already, before this listener heard the
 * event, and that change started an update- run: the run takes the name. `own`: the event starts an interaction of
 * its own, else one playing goes on.
 * @param {string} name @param {boolean} [own]
 */
function heard(name, own = false) {
  if (run?.name.startsWith('update-')) run.name = name;
  else if (own || !run) begin(name);
  else touch();
}

/** A transition or a one-off animation plays (the hero's drift and the caret's blink never end). */
const moving = () =>
  document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);

/** Takes what is on screen once an interaction has ended: the next controller press is named from it. */
let afterFinish = () => {};

function finish() {
  const r = run;
  run = null;
  r.end = performance.now();
  afterFinish();
  // The observers hand over their entries a little later.
  setTimeout(() => report(r), 200);
}

/** @param {number[]} sorted @param {number} share */
const at = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * share) - 1))] ?? 0;
/** @param {number} n */
const ms = (n) => n.toFixed(1);
/** @param {any[]} list */
const longest = (list) => Math.round(Math.max(0, ...list.map((e) => e.duration)));
/** @param {number} n */
const two = (n) => String(n).padStart(2, '0');
/** The wall clock at `t` on performance.now()'s clock, HH:MM:SS.mmm, to line the probe up with other tools. @param {number} t */
function wall(t) {
  const d = new Date(Date.now() - performance.now() + t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** @param {Run} r */
function report(r) {
  /** Each gap with when it began, from the press. @type {[number, number][]} */
  const timed = r.frames.slice(1).map((t, i) => [r.frames[i] - r.t0, t - r.frames[i]]);
  const gaps = timed.map(([, gap]) => gap).sort((a, b) => a - b);
  /** @param {string} type */
  const during = (type) => entries[type].filter((e) => e.startTime >= r.t0 - 1 && e.startTime <= r.end);
  const tasks = during('longtask');
  const frames = during('long-animation-frame');
  let line =
    `probe: ${page} ${r.name} frames ${r.frames.length}, p50 ${ms(at(gaps, 0.5))}, p95 ${ms(at(gaps, 0.95))}, ` +
    `p99 ${ms(at(gaps, 0.99))}, worst ${ms(at(gaps, 1))} ms, long tasks ${tasks.length} (max ${longest(tasks)} ms)`;
  const work = r.work.sort((a, b) => a - b);
  line += `, work p95 ${ms(at(work, 0.95))}, worst ${ms(at(work, 1))} ms (${work.filter((w) => w > FRAME_120).length} over ${ms(FRAME_120)})`;
  if (hasLongFrames) line += `, long frames ${frames.length} (max ${longest(frames)} ms)`;
  const first = r.frames.find((t) => t > r.t0);
  if (first) line += `, first frame ${ms(first - r.t0)} ms`;
  const paint = during('event').find((e) => Math.abs(e.startTime - r.t0) < 1);
  if (paint) line += `, to paint ${Math.round(paint.duration)} ms`;
  // The frames that came late (half a frame or more over the usual), and when: what the page did then is the cause.
  const late = timed.filter(([, gap]) => gap > 1.5 * at(gaps, 0.5)).slice(0, 4);
  if (late.length) line += `, late ${late.map(([when, gap]) => `${ms(gap)} at +${Math.round(when)}`).join(' ')}`;
  if (r.after !== undefined) line += `, after ${Math.round(r.after)} ms`;
  if (r.inputs > 1) line += `, inputs ${r.inputs}`;
  if (!named.has(r.name)) line += ', cold';
  if (r.cut) line += ', cut';
  if (r.hidden) line += ', hidden';
  line += `, pressed ${wall(r.t0)}`;
  named.add(r.name);
  api.log.info(line);
  const list = (/** @type {number[]} */ values) => values.map((v) => v.toFixed(1)).join(' ');
  api.log.info(`probe-frames: ${page} ${r.name} gaps ${list(gaps)}; work ${list(work)}`);
  for (const e of frames.filter((f) => f.duration > DETAIL_MS).sort((a, b) => b.duration - a.duration).slice(0, 2)) {
    api.log.info(detail(r, e));
  }
}

/**
 * A long animation frame: when it came, how long its rendering and its style and layout took, and its longest scripts.
 * @param {Run} r @param {any} e
 */
function detail(r, e) {
  const end = e.startTime + e.duration;
  const scripts = [...(e.scripts ?? [])]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
    .map((s) => {
      const where = `${s.sourceURL.split('/').pop() || '?'}${s.sourceFunctionName ? ` ${s.sourceFunctionName}` : ''}`;
      const forced = s.forcedStyleAndLayoutDuration ? `, forced layout ${Math.round(s.forcedStyleAndLayoutDuration)} ms` : '';
      return `${s.invoker} (${where}) ${Math.round(s.duration)} ms${forced}`;
    });
  return (
    `probe-detail: ${page} ${r.name} long frame ${Math.round(e.duration)} ms at +${Math.round(e.startTime - r.t0)} ms, ` +
    `blocking ${Math.round(e.blockingDuration)} ms, rendering ${e.renderStart ? Math.round(end - e.renderStart) : 0} ms, ` +
    `style and layout ${e.styleAndLayoutStart ? Math.round(end - e.styleAndLayoutStart) : 0} ms; ` +
    (scripts.join('; ') || 'no scripts')
  );
}

// A plate changing shape (morph.js) logs its own frames too, whatever interaction it plays in: from the frame it
// starts on until its spring has ended.
//
//   probe-morph: <page> <name> frames N, p50 A, p95 B, worst C ms, over D ms
document.addEventListener('morph', (e) => {
  const { name, ms: span } = /** @type {CustomEvent<{ name: string, ms: number }>} */ (e).detail;
  const start = performance.now();
  /** @type {number[]} */
  const times = [];
  /** @param {number} t */
  const step = (t) => {
    times.push(t);
    if (t - start < span) return requestAnimationFrame(step);
    const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    api.log.info(`probe-morph: ${page} ${name} frames ${gaps.length}, p50 ${ms(at(gaps, 0.5))}, p95 ${ms(at(gaps, 0.95))}, worst ${ms(gaps.at(-1) ?? 0)} ms, over ${Math.round(t - times[0])} ms`);
  };
  requestAnimationFrame(step);
});

// A page that goes out of sight (Lamplit behind a game) draws no more frames: what it played ends there.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || !run) return;
  run.hidden = true;
  finish();
});

/**
 * Changes to the page keep the interaction going, all but `ignored`'s (a clock, the screensaver's every frame). A
 * change while none plays starts one: `starts` names those that are interactions of their own, such as a toast; any
 * other is an answer drawn after its press had ended (Steam's covers found, the settings read), named after the
 * element it changed: update-artTiles.
 * @param {string} ignored  a selector
 * @param {(m: MutationRecord) => string | null} starts
 */
function watch(ignored, starts) {
  new MutationObserver((list) => {
    for (const m of list) {
      const el = m.target instanceof Element ? m.target : m.target.parentElement;
      const kept = !el?.closest(ignored);
      if (!run) begin(starts(m) ?? (kept ? `update-${el?.closest('[id]')?.id ?? 'page'}` : null));
      if (kept) touch();
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true });
}

/** Whether class `cls` came (true) or went (false) with change `m`; null when it did neither. @param {MutationRecord} m @param {string} cls */
const flipped = (m, cls) => {
  if (m.type !== 'attributes' || m.attributeName !== 'class') return null;
  const was = (m.oldValue ?? '').split(/\s+/).includes(cls);
  const is = /** @type {Element} */ (m.target).classList.contains(cls);
  return was === is ? null : is;
};

const DIRECTIONS = ['up', 'down', 'left', 'right'];

// ---------- the home screen ----------

async function home() {
  const [{ state, focused }, { detailChoices, narrowed }] = await Promise.all([import('./state.js'), import('./logic.js')]);

  /** What is on screen, as the press finds it. */
  const snap = () => {
    const g = focused();
    const s = state.settings;
    return {
      mode: state.mode,
      art: state.art.open,
      editing: state.art.editing,
      artFocus: state.art.focus,
      typing: !!state.typing,
      count: state.games.length,
      all: state.all.length,
      loaded: state.loaded,
      edge: [state.idx === 0, state.idx === state.games.length - 1],
      narrowed: narrowed(state.find),
      running: !!state.running,
      playing: !!g && state.running === g.id,
      choice: state.mode === 'details' && g ? detailChoices(g, state.running, state.closer)[state.detailsIdx]?.kind : null,
      row: s.rows[s.idx],
      section: s.section,
      findFocus: state.findFocus,
      findList: !!state.findList,
      add: state.add.view,
      addKind: state.add.rows.filter((r) => r.kind)[state.add.idx]?.kind,
    };
  };
  /** @typedef {ReturnType<typeof snap>} Snap */

  /** What a press does to what is on screen, as input.js and the files it calls act on it. @param {string} action @param {Snap} s */
  const name = (action, s) => {
    const dir = DIRECTIONS.includes(action);
    if (s.mode === 'starting') return `launch-${action}`;
    if (s.mode === 'settings') {
      const row = s.row;
      if (action === 'triangle') return 'settings-close';
      if (action === 'back') return s.section ? 'settings-back' : 'settings-close';
      if (action === 'up' || action === 'down') return 'settings-move';
      if ((action === 'left' || action === 'right') && row?.adjust) return `settings-step-${row.kind}`;
      if ((action === 'right' || action === 'ok') && row?.kind === 'section') return row.key === 'add' ? 'add-open' : `settings-section-${row.key}`;
      if (action === 'left' && s.section) return 'settings-back';
      if (action !== 'ok' || !row?.kind) return null;
      if (row.kind === 'power') return `settings-power-${row.id}`;
      if (row.kind === 'savernow') return 'screensaver-wait';
      return `settings-select-${row.kind}`;
    }
    if (s.mode === 'details' && s.art && s.editing) {
      return { back: 'art-keys-close', ok: 'art-key-press', square: 'art-type', triangle: 'art-type' }[action] ?? (dir ? 'art-key-step' : null);
    }
    if (s.mode === 'details' && s.art) {
      return { back: 'art-close', ok: s.artFocus === 'search' ? 'art-keys-open' : 'art-choose', square: 'art-keys-open' }[action] ?? (dir ? 'art-step' : null);
    }
    if (s.mode === 'details') {
      if (action === 'back' || action === 'menu') return 'lift-close';
      if (action === 'up' || action === 'down') return 'lift-move';
      if (action === 'ok') return s.choice === 'art' ? 'art-open' : `lift-${s.choice}`;
      return null;
    }
    if (s.mode === 'find') {
      // ○ closes the store list when it is open (find.js backFind), else Find.
      if (action === 'back') return s.findList ? 'find-stores-close' : 'find-close';
      if (dir) return 'find-move';
      if (action === 'square' || action === 'triangle') return 'find-type';
      if (action !== 'ok') return null;
      if (s.findFocus === 'store') return 'find-stores-open';
      const [kind] = s.findFocus.split(':');
      return { done: 'find-close', clear: 'find-clear', store: 'find-store-pick', sort: 'find-sort' }[kind] ?? 'find-type';
    }
    if (s.mode === 'add' && s.add === 'name') {
      return { back: 'add-name-back', ok: 'add-key-press', square: 'add-type', triangle: 'add-type' }[action] ?? (dir ? 'add-key-step' : null);
    }
    if (s.mode === 'add') {
      if (action === 'back' || (action === 'left' && s.add === 'browse')) return s.add === 'browse' ? 'add-up' : 'add-close';
      const opens = s.addKind === 'drive' || s.addKind === 'folder';
      if (action === 'ok' || (action === 'right' && opens)) {
        return { browse: 'add-drives', drive: 'add-folder', folder: 'add-folder', exe: 'add-name', program: 'add-name' }[s.addKind] ?? null;
      }
      if (action === 'up' || action === 'down') return 'add-step';
      if (action === 'l1' || action === 'r1') return 'add-page';
      return null;
    }
    if (action === 'triangle') return 'settings-open';
    if (action === 'square') return s.all ? 'find-open' : null;
    if (action === 'back') return s.narrowed ? 'find-show-all' : s.running ? 'back-to-game' : null;
    if (!s.count) return action === 'ok' && s.loaded && !s.all ? 'add-open' : null;
    if (action === 'left' || action === 'right') return s.edge[action === 'left' ? 0 : 1] ? 'row-edge' : 'row-step';
    if (action === 'l1' || action === 'r1') return 'row-jump';
    if (action === 'ok') return s.playing ? 'back-to-game' : 'play';
    if (action === 'menu') return 'lift-open';
    return null;
  };

  /** When Show it now was pressed, for how long the screensaver took to start fading in. */
  let waitFrom = NaN;
  /** When the game menu was opened, for how long its veil took to be drawn. */
  let liftAt = NaN;
  /** When Show it now was pressed, for when the screensaver stepped its render scale down (saver.js adapt). */
  let saverAt = NaN;
  /** A press: begins its interaction, noting Show it now's and the menu's. @param {string | null} n @param {number} [t] */
  const press = (n, t = performance.now()) => {
    if (n === 'screensaver-wait') waitFrom = t;
    if (n === 'lift-open') liftAt = t;
    if (n === 'screensaver-wait') saverAt = t;
    begin(n, t);
  };

  // input.js's keys, which it doesn't share.
  /** @type {Record<string, string>} */
  const KEYS = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    Enter: 'ok', Escape: 'back', Backspace: 'back', i: 'menu', c: 'triangle', f: 'square', PageUp: 'l1', PageDown: 'r1',
  };

  // Ahead of input.js's own listener, while the screen is as the press finds it. The screensaver's listener comes
  // first and keeps the key that wakes it to itself, which the class it drops tells instead (below).
  window.addEventListener(
    'keydown',
    (e) => {
      const s = snap();
      const typing = (e.key.length === 1 || e.key === 'Backspace') && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (s.mode === 'find' && typing) return begin('find-type', e.timeStamp);
      if (s.typing && typing && (s.mode === 'details' || s.mode === 'add')) return begin(s.mode === 'add' ? 'add-type' : 'art-type', e.timeStamp);
      const action = KEYS[e.key];
      if (action && !(e.repeat && !DIRECTIONS.includes(action))) press(name(action, s), e.timeStamp);
    },
    true
  );
  // input.js hears a controller's press first, so the screen is taken as it was when the last interaction ended.
  let still = snap();
  afterFinish = () => (still = snap());
  await Promise.all([
    api.onPad((action) => press(name(action, still))),
    // Brought forward over a game (holding PS, the dock's Home): the screen settles in.
    api.onSummoned(() => heard('arrive')),
  ]);
  // Show it now waits (screensaver-wait) until the screensaver's frames come on time, unseen; screensaver-show starts as
  // it fades in (#saver gets .on), also when it starts on its own after minutes without input, and its line says how
  // long after the press that was.
  new MutationObserver((list) => {
    for (const m of list) {
      if (/** @type {Element} */ (m.target).id !== 'saver' || flipped(m, 'on') !== true) continue;
      if (run) finish();
      begin('screensaver-show');
      if (!Number.isNaN(waitFrom)) run.after = performance.now() - waitFrom;
      waitFrom = NaN;
      // flipped compares with the classes as they are now, so every class change in this batch would look like .on
      // arriving: one start is all there is.
      break;
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  // The screensaver draws lower when the screen misses refreshes (saver.js adapt): each step, and when after Show it now.
  document.addEventListener('saver-scale', (e) => {
    const after = Number.isNaN(saverAt) ? '' : `, ${Math.round(performance.now() - saverAt)} ms after the press`;
    api.log.info(`probe: ${page} screensaver scale ${/** @type {CustomEvent} */ (e).detail.toFixed(2)}${after}`);
  });
  // The game menu's veil (veil.js) fades in once its canvas is drawn, after its images decode: how long after the press.
  new MutationObserver((list) => {
    for (const m of list) {
      if (!(/** @type {Element} */ (m.target).classList.contains('veil')) || flipped(m, 'drawn') !== true) continue;
      if (!Number.isNaN(liftAt)) api.log.info(`probe: ${page} veil drawn ${ms(performance.now() - liftAt)} ms after the press`);
      liftAt = NaN;
      break;
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  // A toast, and the screensaver woken (by a key it keeps to itself), start interactions of their own.
  // The stage held and copied under the game menu's veil (veil.js) is no change anyone sees.
  watch('#status, #saver, #stage[data-stage]', (m) => {
    const on = flipped(m, 'on');
    const id = /** @type {Element} */ (m.target).id;
    if (on === null) return null;
    if (id === 'toast') return on ? 'toast-show' : 'toast-hide';
    if (id === 'saver') return on ? null : 'screensaver-wake';
    return null;
  });
}

// ---------- the dock ----------

async function dock() {
  /** @param {string} id */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  /** What the dock shows, from its page: dock/main.js keeps its state to itself. */
  const snap = () => ({
    mode: $('island').dataset.mode,
    leaving: document.body.classList.contains('home'),
    outputs: !$('outputs').hidden,
    volume: $('volume').classList.contains('focus'),
    tile: /** @type {HTMLElement | null} */ (document.querySelector('#tiles .tile.focus'))?.dataset.key,
  });

  /** What a press does in the open dock, as dock/main.js acts on it. @param {string} action @param {ReturnType<typeof snap>} s */
  const name = (action, s) => {
    if (s.mode !== 'open') return null;
    if (s.leaving) return action === 'back' ? 'dock-home-back' : null;
    if (s.outputs) return { back: 'dock-output-close', up: 'dock-output-step', down: 'dock-output-step', ok: 'dock-output-choose' }[action] ?? null;
    if (action === 'back') return 'dock-resume';
    if (s.volume) return { left: 'dock-volume', right: 'dock-volume', ok: 'dock-mute', down: 'dock-row', up: 'dock-edge' }[action] ?? null;
    if (action === 'left' || action === 'right') return 'dock-step';
    if (action === 'up') return 'dock-row';
    if (action === 'down') return 'dock-edge';
    if (action !== 'ok') return null;
    return { resume: 'dock-resume', output: 'dock-output-open', quiet: 'dock-quiet', stats: 'dock-stats', home: 'dock-home', close: 'dock-close-hold' }[s.tile] ?? null;
  };

  // dock/main.js's keys.
  /** @type {Record<string, string>} */
  const KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'ok', Escape: 'back', Backspace: 'back' };
  window.addEventListener(
    'keydown',
    (e) => {
      const action = KEYS[e.key];
      if (action && !(e.repeat && (action === 'ok' || action === 'back'))) begin(name(action, snap()), e.timeStamp);
    },
    true
  );
  let still = snap();
  afterFinish = () => (still = snap());
  await Promise.all([
    api.onDock((show) => {
      // The window shows first, still and as the pill, until its frames come on time (dock/main.js steady): that wait
      // is dock-show, and dock-open starts as the island starts to move (below).
      if (show.mode === 'open') heard('dock-show', true);
      else if (show.mode === 'closed') heard(document.body.classList.contains('home') ? 'dock-home-lift' : 'dock-fold');
      else heard('dock-news');
    }),
    api.onDockPad((action) => (action === 'ok-up' ? touch() : begin(name(action, still)))),
  ]);
  watch('#clock, #session', () => null);
  // The island starts to move: the wait before it ends there, not cut, and dock-open begins.
  new MutationObserver(() => {
    if ($('island').dataset.mode !== 'open' || run?.name !== 'dock-show') return;
    finish();
    begin('dock-open');
  }).observe($('island'), { attributes: true, attributeFilter: ['data-mode'] });
}

await (page === 'dock' ? dock() : home());
api.log.info(`probe: ${page} on, long tasks ${hasLongTasks ? 'yes' : 'no'}, long frames ${hasLongFrames ? 'yes' : 'no'}`);
