// @ts-check
// The focus ring both pages draw: one ring that springs from what had the focus to what has it, on the snap spring
// (plate.css .ring). It lives in a layer, a positioned element, and is laid out from the offsets of what is inside it
// rather than from where it shows: something still moving in, or a layer still opening, doesn't throw it off.

/**
 * Makes the ring in `layer`. `bottom`: placed from the layer's bottom, for a layer laid out from its bottom (the dock),
 * where what grows above the focus doesn't move the ring on the screen.
 * @param {HTMLElement} layer
 * @param {{ bottom?: boolean }} [options]
 */
export function focusRing(layer, { bottom = false } = {}) {
  const ring = document.createElement('div');
  ring.className = bottom ? 'ring instant from-bottom' : 'ring instant';
  ring.setAttribute('aria-hidden', 'true');
  layer.append(ring);

  /**
   * Onto `target`, inside the layer: it springs there from where it was, or shows there at once when it was hidden.
   * After this frame's layout, as a list that just opened has no boxes before it.
   * @param {HTMLElement} target
   */
  function move(target) {
    requestAnimationFrame(() => {
      let [x, y, n] = [0, 0, /** @type {HTMLElement | null} */ (target)];
      while (n && n !== layer) {
        x += n.offsetLeft;
        y += n.offsetTop;
        const parent = /** @type {HTMLElement | null} */ (n.offsetParent);
        // A scrolled list between the target and the layer moves what is in it.
        if (parent && parent !== layer) {
          x -= parent.scrollLeft;
          y -= parent.scrollTop;
        }
        n = parent;
      }
      const r = ring.style;
      r.setProperty('--x', `${x}px`);
      r.setProperty('--y', `${bottom ? y + target.offsetHeight - layer.clientHeight : y}px`);
      r.setProperty('--w', `${target.offsetWidth}px`);
      r.setProperty('--h', `${target.offsetHeight}px`);
      r.setProperty('--r', getComputedStyle(target).borderRadius);
      ring.classList.add('on');
      // Shown where the focus is, it springs from there on.
      requestAnimationFrame(() => ring.classList.remove('instant'));
    });
  }

  /** Off: it fades, and shows at once where the focus is next time. */
  function hide() {
    ring.classList.add('instant');
    ring.classList.remove('on');
  }

  return { el: ring, move, hide };
}
