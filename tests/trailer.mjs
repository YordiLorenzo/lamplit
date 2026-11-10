// Trailer page checks, called by ui.test.mjs. tests/media/trailer, a 4-second DASH trailer in Steam's layout, exercises
// the page's own player (ui/dash.js) and the browser's actual media element.
import path from 'node:path';
import { ipc } from './fixtures.mjs';
import { assetOrigin, emit, idle } from './page.mjs';

const read = (page) => page.evaluate(() => {
  const v = document.querySelector('#trailer');
  return {
    requests: window.__calls.filter(([name]) => name === 'library_details'),
    logs: window.__logs.filter((line) => line.includes('trailer:')),
    exists: !!v, shown: !!v?.classList.contains('on'), paused: v?.paused,
    muted: v?.muted, volume: v?.volume, loop: v?.loop, source: v?.getAttribute('src'),
    fade: v && getComputedStyle(v).transitionDuration,
    fading: v?.getAnimations().some((a) => a.transitionProperty === 'opacity'),
    size: [v?.videoWidth, v?.videoHeight],
  };
});

export async function trailerTests({ browser, open, close, game, check, shots, holdClock }) {
  const games = [game(1), game(2)];
  const details = {
    ...ipc('details'),
    trailer: {
      ...ipc('details').trailer,
      url: 'https://video.fastly.steamstatic.com/store_trailers/test/dash_h264.mpd',
      poster: games[0].art.hero ? `${assetOrigin}/${encodeURIComponent(games[0].art.hero)}` : '',
    },
  };
  const start = async (extra = {}) => {
    const trailerRequests = [];
    const page = await open({ games, details, trailerRequests, clock: true, ...extra });
    page.trailerRequests = trailerRequests;
    await holdClock(page);
    await page.clock.runFor(100);
    await emit(page, 'pad', 'up');
    return page;
  };
  const playing = async (page) => {
    await page.clock.runFor(2700);
    await page.locator('#trailer.on').waitFor({ timeout: 5000 });
    return read(page);
  };

  {
    const page = await start();
    await page.clock.runFor(2400);
    check('trailers do not fetch details before 2.5 seconds of rest', (await read(page)).requests.length === 0);
    await page.clock.runFor(200);
    await page.locator('#trailer.on').waitFor({ timeout: 5000 });
    let v = await read(page);
    check('a muted trailer fetches the video stream only', page.trailerRequests.includes('dash_h264/init-stream0.m4s') && !page.trailerRequests.includes('dash_h264/init-stream1.m4s'), JSON.stringify(page.trailerRequests));
    check('a playing trailer is logged once', JSON.stringify(v.logs) === `["info trailer: playing ${details.appid}"]`, JSON.stringify(v.logs));
    check('the idle trailer decodes, loops and fades in muted', v.requests.length === 1 && v.shown && !v.paused && v.muted && v.volume === 0.4 && v.loop && v.fade === '0.6s' && v.fading && v.size[0] === 640, JSON.stringify(v));
    // CSS transitions use Chromium's animation clock, so screenshots let it settle in real time.
    await page.clock.resume();
    await page.waitForTimeout(1200);
    await holdClock(page);
    await page.screenshot({ path: path.join(shots, 'trailer.png') });
    await page.evaluate(() => { window.__oldTrailer = document.querySelector('#trailer'); });
    await emit(page, 'pad', 'right');
    v = await read(page);
    check('a controller move pauses and fades the trailer out immediately', v.paused && !v.shown && v.fade === '0.2s', JSON.stringify(v));
    await page.clock.runFor(200);
    check('the fade releases the source and removes the video', await page.evaluate(() => !window.__oldTrailer.hasAttribute('src') && !window.__oldTrailer.isConnected));
    await playing(page);
    check('the new focused cover gets its own details', (await read(page)).requests.at(-1)[1].id === games[1].id);
    await page.mouse.move(900, 200);
    check('a pointer move also pauses playback', (await read(page)).paused);
    await page.clock.runFor(200);
    await close(page);
  }

  {
    const page = await start({ prefs: { ...ipc('prefs'), trailers: 'with_sound' } });
    const v = await playing(page);
    check('With sound plays at 40 percent volume', !v.muted && v.volume === 0.4, JSON.stringify(v));
    check('With sound also fetches the audio stream', page.trailerRequests.includes('dash_h264/init-stream1.m4s'), JSON.stringify(page.trailerRequests));
    await page.keyboard.press('z');
    check('a key with no home-screen action still mutes and pauses', (await read(page)).muted && (await read(page)).paused);
    await page.clock.runFor(200);
    await emit(page, 'pad', 'triangle');
    await idle(page);
    await emit(page, 'pad', 'ok');
    await emit(page, 'pad', 'down');
    await emit(page, 'pad', 'left');
    await idle(page);
    await emit(page, 'pad', 'left');
    await idle(page);
    check('Settings saves Trailers Off after Interface sounds', await page.evaluate(() => window.__prefs.trailers === 'off' && document.querySelector('#settingsList .row.focus').textContent === 'TrailersOff'));
    await page.clock.resume();
    await page.waitForTimeout(1200);
    await holdClock(page);
    await page.screenshot({ path: path.join(shots, 'trailers-setting.png') });
    await emit(page, 'pad', 'right');
    await idle(page);
    await emit(page, 'pad', 'right');
    await idle(page);
    check('Settings can save With sound again', await page.evaluate(() => window.__prefs.trailers === 'with_sound'));
    await close(page);
  }

  for (const reason of ['off', 'offline', 'reduced', 'running', 'settings', 'find', 'menu', 'starting', 'dock', 'blur', 'hidden', 'screensaver']) {
    const prefs = { ...ipc('prefs'), ...(reason === 'off' ? { trailers: 'off' } : {}), ...(reason === 'offline' ? { online_art: false } : {}) };
    const page = await start({ prefs, running: reason === 'running' ? games[0].id : null });
    if (reason === 'reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
    if (reason === 'settings') await emit(page, 'pad', 'triangle');
    if (reason === 'find') await emit(page, 'pad', 'square');
    if (reason === 'menu') await emit(page, 'pad', 'menu');
    if (reason === 'starting') await emit(page, 'pad', 'ok');
    if (reason === 'dock') await emit(page, 'dock', { mode: 'open' });
    if (reason === 'blur') await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
    if (reason === 'hidden') await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    if (reason === 'screensaver') await page.evaluate(async () => (await import('/screensaver/index.js')).showScreensaver());
    await page.clock.runFor(3000);
    check(`no trailer request when ${reason}`, (await read(page)).requests.length === 0, JSON.stringify(await read(page)));
    await close(page);
  }

  {
    const page = await start();
    await page.evaluate(() => {
      window.__settings = { library_details: () => new Promise((resolve) => { window.__detailsReply = resolve; }) };
    });
    await page.clock.runFor(2600);
    check('one details request can remain pending', (await read(page)).requests.length === 1);
    await emit(page, 'pad', 'right');
    await emit(page, 'pad', 'left');
    await page.evaluate((value) => window.__detailsReply(value), details);
    await idle(page);
    check('an old answer stays cancelled even after returning to its cover', !(await read(page)).exists);
    await close(page);
  }

  for (const failure of ['timeout', 'error', 'rejected', 'buffering']) {
    const page = await start();
    if (failure === 'timeout' || failure === 'rejected') await page.evaluate((kind) => {
      HTMLMediaElement.prototype.play = () => kind === 'rejected' ? Promise.reject(new Error('play blocked')) : new Promise(() => {});
    }, failure);
    await page.clock.runFor(2600);
    await idle(page);
    if (failure === 'buffering') await page.locator('#trailer.on').waitFor();
    if (failure === 'error' || failure === 'buffering') await page.evaluate((kind) => {
      const video = document.querySelector('#trailer');
      if (kind === 'buffering') video.pause();
      video.dispatchEvent(new Event(kind === 'error' ? 'error' : 'waiting'));
    }, failure);
    if (failure === 'timeout' || failure === 'buffering') {
      await page.clock.runFor(3900);
      check(`${failure} keeps the video for less than four seconds`, (await read(page)).exists);
    }
    await page.clock.runFor(failure === 'timeout' || failure === 'buffering' ? 400 : 250);
    const gone = await read(page);
    const why = { timeout: 'stalled for 4 s', error: 'media error unknown', rejected: 'play blocked', buffering: 'stalled for 4 s' }[failure];
    check(`${failure} releases the video quietly`, !gone.exists);
    check(`${failure} logs why the trailer stopped`, gone.logs.includes(`warn trailer: ${details.appid} ${why}`), JSON.stringify(gone.logs));
    await page.clock.runFor(5000);
    check(`${failure} does not retry without new input`, (await read(page)).requests.length === 1);
    await close(page);
  }

  for (const reason of ['blur', 'reduced', 'mode', 'running', 'dock']) {
    const page = await start();
    await playing(page);
    if (reason === 'blur') await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
    if (reason === 'reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
    if (reason === 'mode') await page.evaluate(async () => { (await import('/state.js')).state.mode = 'details'; });
    if (reason === 'running') await emit(page, 'play', { state: 'running', id: games[0].id });
    if (reason === 'dock') await emit(page, 'dock', { mode: 'open' });
    await page.clock.runFor(400);
    check(`active playback releases its source on ${reason}`, !(await read(page)).exists);
    await close(page);
  }

  {
    const page = await start({ trailerDelayMs: 400 });
    await playing(page);
    await emit(page, 'pad', 'right');
    const seen = page.trailerRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    check('stopping a trailer stops its downloads', page.trailerRequests.length === seen && seen < 5, JSON.stringify(page.trailerRequests));
    check('stopping a trailer on input logs no failure', !(await read(page)).logs.some((line) => line.startsWith('warn')), JSON.stringify((await read(page)).logs));
    await page.clock.runFor(200);
    await close(page);
  }

  {
    const page = await start();
    const plans = await page.evaluate(async () => {
      const { dashStreams } = await import('/dash.js');
      const rep = (id, h) => `<Representation id="${id}" mimeType="video/mp4" codecs="avc1.640029" height="${h}"><SegmentTemplate timescale="1000000" duration="3000000" initialization="dash_h264/init-stream$RepresentationID$.m4s" media="dash_h264/chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1"/></Representation>`;
      const steam = `<MPD mediaPresentationDuration="PT2M29.7S"><Period><AdaptationSet contentType="video">${rep(0, 1080)}${rep(1, 720)}${rep(2, 480)}${rep(3, 360)}</AdaptationSet><AdaptationSet contentType="audio"><Representation id="4" mimeType="audio/mp4" codecs="mp4a.40.2"><SegmentTemplate timescale="1000000" duration="3000000" initialization="dash_h264/init-stream$RepresentationID$.m4s" media="dash_h264/chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1"/></Representation></AdaptationSet></Period></MPD>`;
      const parse = (text) => new DOMParser().parseFromString(text, 'application/xml');
      const url = 'https://video.akamai.steamstatic.com/store_trailers/1/2/abc/3/dash_h264.mpd?t=5';
      const muted = dashStreams(parse(steam), url, false);
      const sound = dashStreams(parse(steam), url, true);
      const timeline = dashStreams(parse(steam.replaceAll(' duration="3000000"', '')), url, false);
      return { muted, sound, timeline };
    });
    const video = plans.muted?.[0];
    check('the player takes the 720p stream, its first minute in 3-second chunks', plans.muted?.length === 1 && video.urls.length === 21
      && video.urls[0] === 'https://video.akamai.steamstatic.com/store_trailers/1/2/abc/3/dash_h264/init-stream1.m4s'
      && video.urls[1].endsWith('/dash_h264/chunk-stream1-00001.m4s') && video.urls.at(-1).endsWith('/dash_h264/chunk-stream1-00020.m4s'), JSON.stringify(plans.muted));
    check('With sound adds the audio stream', plans.sound?.length === 2 && plans.sound[1].type === 'audio/mp4; codecs="mp4a.40.2"', JSON.stringify(plans.sound));
    check('a manifest without fixed-length chunks is not played', plans.timeline === null);
    await close(page);
  }
}
