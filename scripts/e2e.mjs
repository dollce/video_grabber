import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateFixtures, startFixtureServer, ffmpegPath } from './fixtures.mjs';

await generateFixtures();
await mkdir('artifacts/e2e', { recursive: true });
const fixture = await startFixtureServer();
const profile = await mkdtemp(resolve(tmpdir(), 'video-grabber-e2e-'));
let context;
const failures = [];
const results = [];
const captureProofs = [];
let migrationProof;
function validateMedia(file, audioOnly) {
  // Native FFmpeg fully decodes both selected streams; missing streams cause a nonzero exit.
  const args = ['-hide_banner', '-i', file, ...(!audioOnly ? ['-map', '0:v:0'] : []), '-map', '0:a:0', '-f', 'null', '-'];
  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Duration: 00:00:04\./, 'output should preserve four-second fixture');
  if (audioOnly) assert.doesNotMatch(result.stderr, /Video:/);
}
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--autoplay-policy=no-user-gesture-required'],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const player = await context.newPage();
  await player.goto(fixture.url);
  assert.ok(await player.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42c01e,mp4a.40.2"')),
    'This browser lacks H.264/AAC playback. Set CHROMIUM_PATH to the official Chrome for Testing executable.');
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find(tab => tab.url === url + '/')?.id, fixture.url);
  assert.ok(Number.isInteger(tabId), 'fixture tab found');
  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/app.html?tabId=${tabId}`);
  await app.evaluate(() => {
    const NativeWorker = window.Worker;
    window.__mediaTestLogs = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          if (event.data?.type === 'LOG') {
            window.__mediaTestLogs.push(event.data.data.message);
            if (window.__mediaTestLogs.length > 100) window.__mediaTestLogs.shift();
          }
        });
      }
    };
  });
  app.on('pageerror', error => failures.push(error.message));
  const snapshot = () => app.evaluate(tabId => chrome.runtime.sendMessage({ type: 'snapshot', tabId }), tabId);
  async function play(mode) {
    await player.selectOption('#mode', mode);
    await player.click('#play');
    await player.waitForFunction(() => /재생 중|오류:/.test(document.querySelector('#status').textContent));
    assert.equal(await player.locator('#status').textContent(), '재생 중');
    await player.waitForFunction(() => document.querySelector('video').currentTime > 0.25);
  }
  async function select(suffix) {
    const row = app.locator(`.resource-button[data-resource-id$="${suffix}"]`);
    await row.waitFor(); await row.click();
    await app.locator('#download-audio').waitFor({ state: 'visible' });
    await app.waitForFunction(() => !document.querySelector('#download-audio').disabled);
  }
  async function download(label, audioOnly = false) {
    await app.evaluate(() => { window.__mediaTestLogs = []; });
    const waiting = app.waitForEvent('download', { timeout: 120_000 });
    await app.fill('#file-title', label);
    await app.click(audioOnly ? '#download-audio' : '#download-video');
    const download = await Promise.race([waiting, app.waitForFunction(() => document.querySelector('#job').classList.contains('failed'), undefined, { timeout: 120_000 }).then(async () => { throw new Error(`${await app.locator('#job-message').textContent()}\n${await app.evaluate(() => window.__mediaTestLogs.join('\n'))}`); })]);
    const path = resolve('artifacts/e2e', `${label}.${audioOnly ? 'm4a' : 'mp4'}`);
    await download.saveAs(path);
    assert.equal(await download.failure(), null);
    validateMedia(path, audioOnly);
    await app.waitForFunction(() => !document.querySelector('#download-audio').disabled);
    results.push(label);
    console.log(`PASS ${label}`);
  }
  await play('direct');
  await select('/direct.mp4');
  await download('direct-video');
  await download('direct-audio', true);

  // Upgrade the original capture schema without losing its existing bodies.
  migrationProof = await app.evaluate(async ({ tabId, url }) => {
    const body = await (await fetch(url)).blob();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('video-grabber-capture');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('video-grabber-capture', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('responses', { keyPath: 'id' });
        store.createIndex('tab', 'tabId');
        store.createIndex('tabUrl', ['tabId', 'url']);
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('responses', 'readwrite');
        transaction.objectStore('responses').put({ id: 'legacy-direct', tabId, url, mime: 'video/mp4', status: 200, capturedAt: Date.now(), body });
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
    return { previousVersion: 1, bytes: body.size };
  }, { tabId, url: `${fixture.url}/direct.mp4` });
  fixture.replay.blocked = true;
  await download('legacy-capture-video');
  fixture.replay.blocked = false;
  const migratedVersion = await app.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('video-grabber-capture');
    request.onsuccess = () => { const db = request.result; resolve(db.version); db.close(); };
    request.onerror = () => reject(request.error);
  }));
  assert.ok(migratedVersion > 1, 'the legacy store should be upgraded before cached replay');
  migrationProof.currentVersion = migratedVersion;
  await play('hls');
  await select('/master.m3u8');
  await download('hls-video');
  await download('hls-audio', true);
  await play('fmp4');
  await select('/master-fmp4.m3u8');
  await download('hls-fmp4-video');
  await play('range');
  await select('/range.m3u8');
  await download('hls-range-video');
  await play('dash');
  await select('/stream.mpd');
  await download('dash-video');
  await download('dash-audio', true);
  await play('separate');
  await select('/video-only.mp4');
  await app.selectOption('#audio-track', `resource:${fixture.url}/audio.m4a`);
  await download('separate-video');

  // Relative segment references must use each redirected playlist's final URL.
  await play('hls-redirect');
  const hlsRedirectStart = fixture.requests.length;
  await select('/redirect-hls/master.m3u8');
  await download('redirected-hls-video');
  const hlsRedirectRequests = fixture.requests.slice(hlsRedirectStart).map(request => request.path);
  assert.ok(hlsRedirectRequests.includes('/relocated-hls/video/video-000.ts'));
  assert.ok(hlsRedirectRequests.includes('/relocated-hls/audio/audio-000.ts'));
  assert.ok(!hlsRedirectRequests.some(path => /^\/redirect-hls\/.+\.ts$/.test(path)), 'HLS segments must not use the pre-redirect base');

  await play('dash-redirect');
  fixture.redirects.set('/redirect-dash/stream.mpd', '/relocated-dash/stream.mpd');
  const dashRedirectStart = fixture.requests.length;
  await select('/redirect-dash/stream.mpd');
  await download('redirected-dash-video');
  const dashRedirectRequests = fixture.requests.slice(dashRedirectStart).map(request => request.path);
  assert.ok(dashRedirectRequests.some(path => path.startsWith('/relocated-dash/init-stream')));
  assert.ok(dashRedirectRequests.some(path => path.startsWith('/relocated-dash/chunk-stream')));
  assert.ok(!dashRedirectRequests.some(path => path.startsWith('/redirect-dash/') && path !== '/redirect-dash/stream.mpd'), 'DASH children must not use the pre-redirect base');

  // Capture both ordinary playback and redirected playlists/media files, then
  // deny every subsequent fixture request, including original redirect URLs.
  for (const [mode, master, prefix] of [
    ['hls', '/master.m3u8', 'captured-hls'],
    ['hls-redirect', '/redirect-hls/master.m3u8', 'captured-redirected-hls'],
  ]) {
    await app.click('#capture-toggle');
    await app.waitForFunction(() => document.querySelector('#capture-toggle').textContent.includes('중지'));
    await player.reload();
    const playbackStart = fixture.requests.length;
    await play(mode);
    await player.waitForFunction(() => document.querySelector('video').ended);
    await app.waitForFunction(async tabId => {
      const reply = await chrome.runtime.sendMessage({ type: 'snapshot', tabId });
      return reply.ok && reply.snapshot.capture.count >= 12;
    }, tabId);
    await app.click('#capture-toggle');
    await app.waitForFunction(() => document.querySelector('#capture-toggle').textContent.includes('시작'));
    const captured = await snapshot();
    assert.ok(captured.snapshot.capture.bytes > 0);
    const aliasQueries = mode === 'hls-redirect' ? [
      ['/redirect-hls/video.m3u8', '/relocated-hls/video/video.m3u8'],
      ['/redirect-hls/audio.m3u8', '/relocated-hls/audio/audio.m3u8'],
      ['/relocated-hls/video/video-000.ts', '/delivered-hls/video/video-000.ts'],
      ['/relocated-hls/audio/audio-000.ts', '/delivered-hls/audio/audio-000.ts'],
    ].map(([url, finalUrl]) => ({ url: fixture.url + url, finalUrl: fixture.url + finalUrl })) : [];
    const stored = await app.evaluate(({ tabId, aliases }) => new Promise((resolve, reject) => {
      const request = indexedDB.open('video-grabber-capture');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const store = db.transaction('responses').objectStore('responses');
        const read = query => new Promise((resolve, reject) => {
          query.onsuccess = () => resolve(query.result);
          query.onerror = () => reject(query.error);
        });
        const records = read(store.index('tab').getAll(IDBKeyRange.only(tabId)));
        const lookups = aliases.map(({ url, finalUrl }) => Promise.all([
          read(store.index('tabAlias').getAll(IDBKeyRange.only([tabId, url]))),
          read(store.index('tabUrl').getAll(IDBKeyRange.only([tabId, finalUrl]))),
          read(store.index('tabAlias').getAll(IDBKeyRange.only([tabId + 100000, url]))),
        ]).then(([matching, primary, foreign]) => ({ url, finalUrl, ids: matching.map(row => row.id), primaryIds: primary.map(row => row.id), foreignCount: foreign.length })));
        Promise.all([records, Promise.all(lookups)]).then(([rows, aliases]) => {
          resolve({ rows: rows.map(record => ({ url: record.url, size: record.body.size })), aliases });
          db.close();
        }, error => { db.close(); reject(error); });
      };
    }), { tabId, aliases: aliasQueries });
    const { rows } = stored;
    assert.equal(rows.length, captured.snapshot.capture.count, 'aliases must not create duplicate body records');
    assert.equal(rows.reduce((sum, row) => sum + row.size, 0), captured.snapshot.capture.bytes, 'body bytes are charged once');
    if (mode === 'hls-redirect') {
      const playbackRequests = fixture.requests.slice(playbackStart);
      for (const path of ['/redirect-hls/video.m3u8', '/redirect-hls/audio.m3u8', '/relocated-hls/video/video-000.ts', '/relocated-hls/audio/audio-000.ts']) {
        assert.ok(playbackRequests.some(request => request.path === path && request.status === 302), `redirect observed: ${path}`);
      }
      assert.ok(rows.some(row => row.url.endsWith('/delivered-hls/video/video-000.ts')));
      assert.ok(rows.some(row => row.url.endsWith('/delivered-hls/audio/audio-000.ts')));
      for (const alias of stored.aliases) {
        assert.ok(alias.ids.length > 0, `alias indexed: ${alias.url}`);
        assert.ok(alias.ids.every(id => alias.primaryIds.includes(id)), 'an alias must refer to the same stored body as its final URL');
        assert.equal(alias.foreignCount, 0, 'alias lookup must remain tab-scoped');
      }
    }
    const replayStart = fixture.requests.length;
    fixture.replay.blocked = true;
    await select(master);
    await download(`${prefix}-video`);
    await download(`${prefix}-audio`, true);
    const denied = fixture.requests.slice(replayStart);
    assert.ok(denied.length > 0, 'manifest refresh attempts should exercise denied replay');
    assert.ok(denied.every(request => request.status === 403), 'every network replay response must be denied');
    fixture.replay.blocked = false;
    captureProofs.push({ mode, capture: captured.snapshot.capture, deniedRequests: denied.length, bodies: rows.length, aliasesChecked: stored.aliases.length });
  }
  await app.screenshot({ path: 'artifacts/e2e/manager.png', fullPage: true });
  await app.click('#clear');
  await app.waitForFunction(async tabId => {
    const reply = await chrome.runtime.sendMessage({ type: 'snapshot', tabId });
    return reply.ok && reply.snapshot.capture.count === 0 && reply.snapshot.resources.length === 0;
  }, tabId);
  assert.deepEqual(failures, []);
  await writeFile('artifacts/e2e/results.json', JSON.stringify({ browser: context.browser()?.version(), passed: results, capture: captureProofs[0].capture, captures: captureProofs, migration: migrationProof, pageErrors: failures }, null, 2));
  // The removal helper closes managers, clears extension-owned data, then removes itself.
  const removal = await context.newPage();
  await removal.goto(`chrome-extension://${extensionId}/uninstall.html`);
  const appClosed = app.waitForEvent('close');
  const workerClosed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Extension did not uninstall within 15 seconds')), 15_000);
    worker.once('close', () => { clearTimeout(timer); resolve(); });
  });
  await removal.click('#uninstall');
  await appClosed;
  await workerClosed;
  console.log('PASS browser data cleanup and extension self-removal');
  console.log(`Passed ${results.length} real extension downloads, native decode checks, response replay and cleanup.`);
} catch (error) {
  if (context) {
    for (const [index, page] of context.pages().entries()) await page.screenshot({ path: `artifacts/e2e/failure-${index}.png`, fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => fixture.server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
