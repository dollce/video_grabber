import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MediaFetcher } from '../src/media/fetcher';
import { parseManifestSnapshots } from '../src/media/engine';
import { parseDash, parseHls } from '../src/media/manifests';
import type { CapturedResponse } from '../src/shared/types';

// A small read-only IDB harness exercises the real capture-store lookup. Each
// fixture record retains the response URL recorded by the capture service.
let captured: CapturedResponse[] = [];
const db = { transaction: () => ({ objectStore: () => ({ index: () => ({
  getAll([tabId, url]: [number, string]) {
    const request = { result: captured.filter(record => record.tabId === tabId && record.url === url), onsuccess: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  },
}) }) }) };
Object.assign(globalThis, {
  indexedDB: { open() {
    const request = { result: db, onsuccess: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  } },
  IDBKeyRange: { only: (key: unknown) => key },
});
afterEach(() => { captured = []; });

function response(text: string, url: string, init?: ResponseInit): Response {
  const reply = new Response(text, init);
  Object.defineProperty(reply, 'url', { value: url });
  return reply;
}
function capture(text: string, url: string): CapturedResponse {
  return { id: 'captured-manifest', tabId: 7, url, mime: 'application/vnd.apple.mpegurl', status: 200, capturedAt: 1, body: new Blob([text]) };
}
const media = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nchunk.m4s\n#EXT-X-ENDLIST\n';

test('HLS master and variant redirects each resolve references against their final response URL', async t => {
  const original = 'https://origin.example/start/master.m3u8';
  const finalMaster = 'https://cdn.example/session/master.m3u8';
  const variant = 'https://cdn.example/session/video.m3u8';
  const finalVariant = 'https://media.example/selected/video/list.m3u8';
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input); requested.push(url);
    if (url === original) return response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a"\nvideo.m3u8\n', finalMaster);
    if (url === variant) return response(media, finalVariant);
    throw new Error(`Unexpected URL: ${url}`);
  });
  const fetcher = new MediaFetcher(7);
  const [master] = parseManifestSnapshots(await fetcher.manifests(original), parseHls);
  assert.equal(master.type, 'master');
  if (master.type !== 'master') return;
  assert.equal(master.variants[0].url, variant);
  assert.equal(master.audios[0].url, 'https://cdn.example/session/audio.m3u8');
  const [playlist] = parseManifestSnapshots(await fetcher.manifests(master.variants[0].url), parseHls);
  assert.equal(playlist.type, 'media');
  if (playlist.type !== 'media') return;
  assert.equal(playlist.segments[0].url, 'https://media.example/selected/video/chunk.m4s');
  assert.equal(playlist.segments[0].init?.url, 'https://media.example/selected/video/init.mp4');
  assert.deepEqual(requested, [original, variant]);
});

test('DASH redirects resolve BaseURL, initialization and segment templates against the final response URL', async t => {
  t.mock.method(globalThis, 'fetch', async () => response(`<MPD type="static" mediaPresentationDuration="PT4S">
    <BaseURL>tracks/</BaseURL><Period><AdaptationSet mimeType="audio/mp4">
    <Representation id="a" bandwidth="128000"><SegmentTemplate timescale="1" duration="2"
      initialization="init-$RepresentationID$.mp4" media="chunk-$Number$.m4s" /></Representation>
    </AdaptationSet></Period></MPD>`, 'https://cdn.example/session/stream.mpd'));
  const [manifest] = parseManifestSnapshots(await new MediaFetcher(7).manifests('https://origin.example/stream.mpd'), parseDash);
  const track = manifest.representations[0];
  assert.equal(track.init?.url, 'https://cdn.example/session/tracks/init-a.mp4');
  assert.deepEqual(track.segments.map(segment => segment.url), [
    'https://cdn.example/session/tracks/chunk-1.m4s', 'https://cdn.example/session/tracks/chunk-2.m4s',
  ]);
});

test('identical manifest text at different response URLs retains each snapshot base', async t => {
  const previous = 'https://cdn.example/old/list.m3u8';
  const latest = 'https://cdn.example/new/list.m3u8';
  captured = [capture(media, previous)];
  t.mock.method(globalThis, 'fetch', async () => response(media, latest));
  const snapshots = await new MediaFetcher(7).manifests(previous);
  assert.deepEqual(snapshots.map(snapshot => snapshot.url), [previous, latest]);
  const playlists = parseManifestSnapshots(snapshots, parseHls);
  assert.deepEqual(playlists.map(playlist => playlist.type === 'media' && playlist.segments[0].url), [
    'https://cdn.example/old/chunk.m4s', 'https://cdn.example/new/chunk.m4s',
  ]);
});

test('captured manifests retain their response base when replay fails or redirects to login HTML', async t => {
  const url = 'https://cdn.example/session/list.m3u8';
  captured = [capture(media, url)];
  const mock = t.mock.method(globalThis, 'fetch', async () => response('Replay denied', url, { status: 403 }));
  let snapshots = await new MediaFetcher(7).manifests(url);
  assert.equal(snapshots.length, 1);
  mock.mock.mockImplementation(async () => response('<html>Sign in</html>', 'https://accounts.example/login'));
  snapshots = await new MediaFetcher(7).manifests(url);
  const playlists = parseManifestSnapshots(snapshots, parseHls);
  assert.equal(playlists.length, 1);
  const playlist = playlists[0];
  assert.equal(playlist.type === 'media' && playlist.segments[0].url, 'https://cdn.example/session/chunk.m4s');
  mock.mock.mockImplementation(async () => response(media, url));
  assert.equal((await new MediaFetcher(7).manifests(url)).length, 1, 'same URL and text still deduplicate');
});

test('deduplication keeps the latest network snapshot last even when its body was captured before', async t => {
  const url = 'https://cdn.example/list.m3u8';
  const intervening = media.replace('chunk.m4s', 'other.m4s');
  captured = [capture(media, url), { ...capture(intervening, url), id: 'later', capturedAt: 2 }];
  t.mock.method(globalThis, 'fetch', async () => response(media, url));
  const snapshots = await new MediaFetcher(7).manifests(url);
  assert.deepEqual(snapshots.map(snapshot => snapshot.text), [intervening, media]);
});

test('redirected manifest responses retain size and HTTP(S) URL restrictions', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => response(media, 'https://cdn.example/list.m3u8', { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } }));
  await assert.rejects(new MediaFetcher(7).manifests('https://origin.example/list.m3u8'), /크기 제한/);
  mock.mock.mockImplementation(async () => response(media, 'file:///private/list.m3u8'));
  await assert.rejects(new MediaFetcher(7).manifests('https://origin.example/list.m3u8'), /HTTP\(S\)/);
});

test('redirected media file responses still enforce ranges and account the returned bytes', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => response('abcdef', 'https://cdn.example/file.mp4'));
  const fetcher = new MediaFetcher(7);
  assert.deepEqual(await fetcher.file({ url: 'https://origin.example/file.mp4', range: { offset: 2, length: 3 } }), new TextEncoder().encode('cde'));
  assert.equal(fetcher.bytes, 3);
  mock.mock.mockImplementation(async () => response('cd', 'https://cdn.example/file.mp4', { status: 206, headers: { 'Content-Range': 'bytes 2-3/6' } }));
  await assert.rejects(fetcher.file({ url: 'https://origin.example/file.mp4', range: { offset: 2, length: 3 } }), /다른 데이터/);
  assert.equal(fetcher.bytes, 3);
});
