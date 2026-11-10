// @ts-check
// Steam's store gives trailers only as DASH and HLS (appdetails `dash_h264`, checked 2026-11-10): a manifest, then per
// stream an init segment and fixed-length fragmented MP4 chunks. WebView2 plays neither format from a src, so Lamplit
// feeds the chunks to Media Source Extensions itself, the first minute only.

/** How much of a trailer Lamplit plays (and loops). */
export const TRAILER_SECONDS = 60;

/** @typedef {{ type: string, urls: string[] }} DashStream  urls = the init segment, then the chunks in order */

/** `PT2M29.7S` as seconds. @param {string | null} value */
function seconds(value) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(value ?? '');
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/**
 * The streams to fetch from a manifest: the video Representation nearest 720p, and the first audio one when `sound`.
 * Null when the manifest is not one Lamplit reads (no fixed-duration SegmentTemplate, no length, no video).
 * @param {Document} mpd @param {string} manifestUrl @param {boolean} sound @returns {DashStream[] | null}
 */
export function dashStreams(mpd, manifestUrl, sound) {
  const total = Math.min(seconds(mpd.documentElement.getAttribute('mediaPresentationDuration')), TRAILER_SECONDS);
  const sets = [...mpd.getElementsByTagName('AdaptationSet')];
  const reps = (type) => [...(sets.find((s) => s.getAttribute('contentType') === type)?.getElementsByTagName('Representation') ?? [])];
  const near720 = (/** @type {Element} */ r) => Math.abs(Number(r.getAttribute('height')) - 720);
  const video = reps('video').sort((a, b) => near720(a) - near720(b))[0];
  const chosen = sound ? [video, reps('audio')[0]] : [video];
  if (!total || chosen.some((r) => !r)) return null;
  const streams = chosen.map((rep) => {
    const tpl = rep.getElementsByTagName('SegmentTemplate')[0];
    const each = Number(tpl?.getAttribute('duration')) / Number(tpl?.getAttribute('timescale') || 1);
    const init = tpl?.getAttribute('initialization');
    const media = tpl?.getAttribute('media');
    if (!tpl || !(each > 0) || !init || !media) return null;
    const id = rep.getAttribute('id') ?? '';
    const first = Number(tpl.getAttribute('startNumber') ?? 1);
    const fill = (/** @type {string} */ name, /** @type {number} */ n) => name
      .replaceAll('$RepresentationID$', id)
      .replace(/\$Number%0(\d+)d\$/g, (_, width) => String(n).padStart(Number(width), '0'))
      .replaceAll('$Number$', String(n));
    const chunks = Array.from({ length: Math.ceil(total / each) }, (_, i) => fill(media, first + i));
    return {
      type: `${rep.getAttribute('mimeType')}; codecs="${rep.getAttribute('codecs')}"`,
      urls: [fill(init, 0), ...chunks].map((name) => new URL(name, manifestUrl).href),
    };
  });
  return streams.every(Boolean) ? /** @type {DashStream[]} */ (streams) : null;
}

/** @param {string} url @param {AbortSignal} signal */
async function get(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`trailer: ${response.status} for ${url}`);
  return response;
}

/** @param {SourceBuffer} buffer @param {ArrayBuffer} data */
const append = (buffer, data) => new Promise((resolve, reject) => {
  buffer.addEventListener('updateend', resolve, { once: true });
  buffer.addEventListener('error', reject, { once: true });
  buffer.appendBuffer(data);
});

/**
 * Plays the first minute of the trailer at `manifestUrl` in `video` (muted or not is the caller's). Returns the
 * MediaSource's object URL, for the caller to revoke when it stops; rejects when the manifest isn't one Lamplit
 * reads or the browser can't decode it. `signal` stops every fetch.
 * @param {HTMLVideoElement} video @param {string} manifestUrl @param {boolean} sound @param {AbortSignal} signal
 */
export async function playDash(video, manifestUrl, sound, signal) {
  const text = await (await get(manifestUrl, signal)).text();
  const streams = dashStreams(new DOMParser().parseFromString(text, 'application/xml'), manifestUrl, sound);
  if (!streams || !streams.every((s) => MediaSource.isTypeSupported(s.type))) throw new Error('trailer: no stream Lamplit can play');
  const source = new MediaSource();
  const objectUrl = URL.createObjectURL(source);
  video.src = objectUrl;
  await new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }));
  const feed = async (/** @type {DashStream} */ s) => {
    const buffer = source.addSourceBuffer(s.type);
    for (const url of s.urls) await append(buffer, await (await get(url, signal)).arrayBuffer());
  };
  // Both buffers exist before either is fed: a MediaSource starts playing once every buffer it has holds data.
  Promise.all(streams.map(feed)).then(
    () => { if (source.readyState === 'open') source.endOfStream(); },
    () => {}
  );
  return objectUrl;
}
