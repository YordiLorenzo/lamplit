// @ts-check
// Hold to confirm, for every action that can't be taken back (closing a game, removing one, restarting or shutting
// down the PC): holding the button fills a ring round the action's icon, and the action happens once it is full. Let
// go before that, the ring drains and nothing happens. As the dock's Close game has always done (plate.css .hold).

/** How long the button is held. */
export const HOLD_MS = 900;

/** The ring that fills round an icon: put it beside the icon, in the element that `hold` is given. */
export function holdRing() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('hold');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  for (const cls of ['track', 'fill']) {
    const c = document.createElementNS(ns, 'circle');
    c.classList.add(cls);
    for (const [k, v] of [['cx', '20'], ['cy', '20'], ['r', '18'], ['pathLength', '100']]) c.setAttribute(k, v);
    svg.append(c);
  }
  return svg;
}

/**
 * The button goes down on `el`: its ring fills over `ms`, and `done` runs once it is full. Returns what letting go
 * does: before it is full, the ring drains and `done` never runs; after, nothing.
 * @param {HTMLElement} el  holds a holdRing
 * @param {() => void} done
 * @param {number} [ms]
 */
export function hold(el, done, ms = HOLD_MS) {
  el.style.setProperty('--hold-ms', `${ms}ms`);
  el.classList.add('holding');
  const full = setTimeout(() => {
    el.classList.remove('holding');
    done();
  }, ms);
  return () => {
    clearTimeout(full);
    el.classList.remove('holding');
  };
}
