// @ts-check
// A worker that reads the games' art files and scales them for the screensaver (saver.js scaledArt), so that neither
// the decoding nor the scaling holds up the page: createImageBitmap decodes off the thread that asks, but scales on it,
// which on the page's main thread takes 30 ms for a hero image at 4x CPU. It answers { id, url, size } with
// { id, bitmap }, the bitmap null when the file can't be read.

self.onmessage = async (/** @type {MessageEvent<{ id: number, url: string, size: ImageBitmapOptions }>} */ e) => {
  const { id, url, size } = e.data;
  const bitmap = await fetch(url)
    .then((file) => file.blob())
    .then((blob) => createImageBitmap(blob, { ...size, resizeQuality: 'high' }))
    .catch(() => null);
  self.postMessage({ id, bitmap }, { transfer: bitmap ? [bitmap] : [] });
};
