// @ts-check
// The new version's three built-in highlights. It waits for the home screen so it can't interrupt a launch or game.

import { showHints } from './hints.js';
import { els, state } from './state.js';

/** @param {import('./api.js').News | null} news */
export function showNews(news) {
  if (!news) return;
  if (state.mode !== 'browse' || state.running || document.hidden) {
    setTimeout(() => showNews(news), 1000);
    return;
  }
  els.newsVersion.textContent = `Lamplit ${news.version}`;
  els.newsList.replaceChildren(...news.highlights.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  state.mode = 'news';
  els.news.hidden = false;
  els.newsClose.focus();
  showHints();
}

export function closeNews() {
  els.news.hidden = true;
  state.mode = 'browse';
  showHints();
}

els.newsClose.addEventListener('click', closeNews);
