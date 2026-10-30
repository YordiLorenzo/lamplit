// @ts-check
// The icons both pages draw, in one style: symbols on a 24-unit grid, drawn with round 2-unit strokes in the colour of
// the text beside them. The controller's button marks take 2.4, as they sit small inside their circles. Three fill
// their shape to show a state: Play, a favourite's star and quiet mode on. mountIcons puts them in the page once, and
// <use href="#i-play"> draws one.

/**
 * Strokes in the text's colour.
 * @param {string} shapes @param {number} [width]
 */
const lines = (shapes, width = 2) =>
  `<g fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${shapes}</g>`;
/** A shape filled in the text's colour, its corners rounded by a stroke of the same. @param {string} d */
const filled = (d) => `<path fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="${d}"/>`;

const STAR = 'M12 3.8l2.5 5.2 5.6.8-4.1 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8z';
const MOON = 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z';
const WINDOW = '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 8.5h17"/>';
const SCREEN = '<rect x="3" y="5" width="18" height="12" rx="1.6"/><path d="M8.5 20h7"/>';

/** Each icon by id: what its symbol holds. */
export const ICONS = {
  // The controller's buttons, for the hints: each centred on the grid, so it sits in the middle of its circle.
  'btn-cross': lines('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 2.4),
  'btn-circle': lines('<circle cx="12" cy="12" r="6.5"/>', 2.4),
  'btn-triangle': lines('<path d="M12 5.4 19 17.4H5z"/>', 2.4),
  'btn-square': lines('<rect x="6.2" y="6.2" width="11.6" height="11.6" rx="1"/>', 2.4),
  'btn-menu': lines('<path d="M6 8h12M6 12h12M6 16h12"/>', 2.4),
  'btn-adjust': lines('<path d="M5 12h14M8.5 8.5 5 12l3.5 3.5M15.5 8.5 19 12l-3.5 3.5"/>', 2.4),
  'btn-up': lines('<path d="M12 18.5V5.5M6.8 10.7 12 5.5l5.2 5.2"/>', 2.4),
  'btn-down': lines('<path d="M12 5.5v13M6.8 13.3 12 18.5l5.2-5.2"/>', 2.4),

  // A game: its menu's rows, and Close game, which is not the power symbol.
  // Play's triangle is its own shape, its corners rounded in the path, as the dock's Resume has it.
  'i-play': '<path fill="currentColor" d="M8.5 5.8v12.4a.8.8 0 0 0 1.2.7l9.6-6.2a.8.8 0 0 0 0-1.4L9.7 5.1a.8.8 0 0 0-1.2.7z"/>',
  'i-star': lines(`<path d="${STAR}"/>`),
  'i-star-on': filled(STAR),
  'i-photo': lines('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17.5l5-4.5 3.5 3 3-2.5 4.5 4"/>'),
  'i-eye': lines('<path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.6"/>'),
  'i-eye-off': lines('<path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.6"/><path d="M4.5 4.5l15 15"/>'),
  'i-close-game': lines(`${WINDOW}<path d="M9.8 11.3l4.4 4.4M14.2 11.3l-4.4 4.4"/>`),
  'i-remove': lines('<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>'),
  'i-folder': lines('<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/>'),
  'i-drive': lines('<path d="M3.5 13.5 6 5.5h12l2.5 8"/><rect x="3.5" y="13.5" width="17" height="6" rx="1.5"/><path d="M16.5 16.5h.01"/>'),
  'i-app': lines(`${WINDOW}<path d="M6.5 6.5h.01M9 6.5h.01"/>`),
  'i-search': lines('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3 20 20"/>'),
  'i-sort': lines('<path d="M7 5v14M4 16l3 3 3-3M13.5 7h6.5M13.5 12h4.5M13.5 17h2.5"/>'),

  // What the dock and Settings show and switch.
  'i-volume': lines('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>'),
  'i-muted': lines('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  'i-tv': lines(SCREEN),
  'i-headset': lines('<path d="M4.5 15v-3a7.5 7.5 0 0 1 15 0v3"/><rect x="3.5" y="13.5" width="4" height="6.5" rx="1.6"/><rect x="16.5" y="13.5" width="4" height="6.5" rx="1.6"/>'),
  'i-controller': lines(
    '<path d="M7.5 7h9a4.4 4.4 0 0 1 4.3 3.5l1 5a2.5 2.5 0 0 1-4.4 2.1L15.6 16H8.4l-1.8 1.6a2.5 2.5 0 0 1-4.4-2.1l1-5A4.4 4.4 0 0 1 7.5 7z"/><path d="M8 10v3.4M6.3 11.7h3.4M15.5 10.6h.01M17.6 12.6h.01"/>'
  ),
  'i-speaker': lines('<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="14" r="3"/><path d="M12 7.5h.01"/>'),
  'i-quiet': lines(`<path d="${MOON}"/>`),
  'i-quiet-on': filled(MOON),
  'i-stats': lines('<path d="M5 19v-6M10 19V6M15 19v-9M20 19v-4"/>'),
  'i-home': lines('<path d="M3.5 11.5 12 4.5l8.5 7"/><path d="M6.5 9.5v10h11v-10"/>'),
  'i-check': lines('<path d="M6 12.5l4 4L18.5 8"/>'),
  'i-store': lines('<path d="M5 8h14l-1 11.5H6z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>'),
  'i-screensaver': lines(`${SCREEN}<path d="M7 11.5c1.7-2 3.3-2 5 0s3.3 2 5 0"/>`),
  'i-popups': lines('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><rect x="11.5" y="12" width="6" height="4.5" rx="1"/>'),
  'i-system': lines('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>'),
  'i-settings': lines('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  'i-add': lines('<path d="M12 5v14M5 12h14"/>'),

  // Power: the power symbol is for the PC itself.
  'i-power': lines('<path d="M12 3.8v7.4"/><path d="M7.2 6.6a7.5 7.5 0 1 0 9.6 0"/>'),
  'i-restart': lines('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
  'i-sleep': lines('<path d="M16.5 15.5A6.5 6.5 0 0 1 8.5 7.5a6.5 6.5 0 1 0 8 8z"/><path d="M15 3.5h4l-4 4h4"/>'),

  // Messages and steps.
  'i-info': lines('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>'),
  'i-warn': lines('<path d="M12 4 21 19.5H3z"/><path d="M12 10v4M12 16.8h.01"/>'),
  'i-error': lines('<path d="M7 7l10 10M17 7 7 17"/>'),
  'i-next': lines('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  'i-back': lines('<path d="M14.5 6 8.5 12l6 6"/>'),
};

/** @typedef {keyof typeof ICONS} IconId */

/** Puts the icons in the page, once, for <use> to draw. @param {Document} doc */
export function mountIcons(doc) {
  if (doc.getElementById('icons')) return;
  const sprite = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.id = 'icons';
  sprite.setAttribute('class', 'sprite');
  sprite.setAttribute('aria-hidden', 'true');
  sprite.innerHTML = Object.entries(ICONS)
    .map(([id, shapes]) => `<symbol id="${id}" viewBox="0 0 24 24">${shapes}</symbol>`)
    .join('');
  doc.body.prepend(sprite);
}
