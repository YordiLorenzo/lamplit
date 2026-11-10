// @ts-check
// One picture full screen over the page, with a caption: a capture from Your captures, or a screenshot from About.

import { els } from './state.js';

/** Shows `picture` full screen, or hides the viewer for null. @param {{ src: string, alt: string, caption: string } | null} picture */
export function showPicture(picture) {
  els.viewer.hidden = !picture;
  if (!picture) return els.viewerImage.removeAttribute('src');
  els.viewerError.hidden = true;
  els.viewerImage.src = picture.src;
  els.viewerImage.alt = picture.alt;
  els.viewerCaption.textContent = picture.caption;
}

els.viewerImage.addEventListener('error', () => {
  if (!els.viewer.hidden) els.viewerError.hidden = false;
});
