import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { combineHlsWindows, inspectMedia, parseManifestSnapshots, prepareInputs } from '../src/media/engine';
import { MediaFetcher } from '../src/media/fetcher';
import type { DownloadRequest, MediaResource, RemoteFile } from '../src/shared/types';
import { parseHls, type HlsMedia } from '../src/media/manifests';

function window(sequence: number, files: string[], endList = false): HlsMedia {
  return { type: 'media', mediaSequence: sequence, endList,
    segments: files.map(name => ({ url: `https://media.example.test/${name}`, duration: 2 })) };
}

test('login HTML cannot replace valid captured manifests', () => {
  const valid = '#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n';
  const parsed = parseManifestSnapshots([
    { text: valid, url: 'https://example.test/list.m3u8' },
    { text: '<html>Sign in</html>', url: 'https://accounts.example.test/login' },
  ], parseHls);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'media');
  assert.throws(() => parseManifestSnapshots([{ text: '<html>Sign in</html>', url: 'https://accounts.example.test/login' }], parseHls));
});

test('live HLS joins overlapping windows in sequence order without duplicate segments', () => {
  const result = combineHlsWindows([
    window(100, ['100.ts', '101.ts', '102.ts']),
    window(102, ['102.ts', '103.ts', '104.ts']),
    window(103, ['103.ts', '104.ts', '105.ts'], true),
  ]);
  assert.equal(result.mediaSequence, 100);
  assert.equal(result.endList, true);
  assert.deepEqual(result.segments.map(segment => segment.url.split('/').at(-1)),
    ['100.ts', '101.ts', '102.ts', '103.ts', '104.ts', '105.ts']);
});

test('live HLS rejects missing windows and conflicting media for the same sequence', () => {
  assert.throws(() => combineHlsWindows([window(1, ['a.ts']), window(3, ['c.ts'])]), /누락/);
  assert.throws(() => combineHlsWindows([window(1, ['a.ts']), window(1, ['different.ts'])]), /변경/);
  assert.throws(() => combineHlsWindows([]), /없습니다/);
});

test('complete zero-based HLS VOD replaces prior live capture snapshots', () => {
  const vod = window(0, ['new-0.ts', 'new-1.ts'], true);
  assert.equal(combineHlsWindows([window(0, ['old-0.ts']), vod]), vod);
});

test('sliding HLS windows preserve previously observed discontinuity boundaries', () => {
  const early = parseHls(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:2,
10.ts
#EXT-X-DISCONTINUITY
#EXTINF:2,
11.ts
#EXTINF:2,
12.ts
`, 'https://media.example.test/live.m3u8') as HlsMedia;
  const later = parseHls(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:11
#EXT-X-DISCONTINUITY-SEQUENCE:1
#EXTINF:2,
11.ts
#EXTINF:2,
12.ts
#EXTINF:2,
13.ts
`, 'https://media.example.test/live.m3u8') as HlsMedia;
  const result = combineHlsWindows([early, later]);
  assert.equal(result.segments[1].discontinuity, true,
    'Removing the old window edge must not erase a known timestamp reset inside the assembled media.');
});

test('live HLS refuses an initialization change for an already observed segment', () => {
  const first = window(1, ['1.m4s']);
  first.segments[0].init = { url: 'https://media.example.test/init-a.mp4' };
  const later = window(1, ['1.m4s']);
  later.segments[0].init = { url: 'https://media.example.test/init-b.mp4' };
  assert.throws(() => combineHlsWindows([first, later]), /변경/);
});

const masterUrl = 'https://media.example.test/master.m3u8';
const resource: MediaResource = { id: masterUrl, tabId: 7, url: masterUrl, kind: 'hls', mime: 'application/vnd.apple.mpegurl', firstSeen: 1, lastSeen: 1, requests: 1 };
const inbandPair = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="English",LANGUAGE="en",DEFAULT=YES\n'
  + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="French",LANGUAGE="fr"\n';
const variant = '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="sound"\nvideo.m3u8\n';
function playlist(tags: string, variants = variant): string { return `#EXTM3U\n${tags}${variants}`; }
function mediaPlaylist(url: string): string {
  return `#EXTM3U\n#EXTINF:2,\n${url.split('/').at(-1)!.replace('.m3u8', '.ts')}\n#EXT-X-ENDLIST\n`;
}
function request(audioId?: string, mode: 'audio' | 'video' = 'video'): DownloadRequest {
  return { tabId: 7, resource, videoId: 'video-0', audioId, mode, title: 'selection' };
}
function preparation(t: TestContext, master: string) {
  const manifests: string[] = [], files: string[] = [], written: string[] = [];
  const fetcher = new MediaFetcher(7);
  t.mock.method(fetcher, 'manifests', async (url: string) => {
    manifests.push(url);
    return [{ text: url === masterUrl ? master : mediaPlaylist(url), url }];
  });
  t.mock.method(fetcher, 'file', async (file: RemoteFile) => { files.push(file.url); return new Uint8Array([1]); });
  const ffmpeg = { async writeFile(name: string) { written.push(name); return true; } } as unknown as FFmpeg;
  return { fetcher, ffmpeg, manifests, files, written };
}

test('ambiguous in-band languages reject both named selections before media retrieval in either output mode', async t => {
  for (const mode of ['audio', 'video'] as const) {
    for (const audioId of ['audio-0', 'audio-1', undefined]) {
      const fixture = preparation(t, playlist(inbandPair));
      await assert.rejects(prepareInputs(fixture.ffmpeg, fixture.fetcher, request(audioId, mode), () => {}), /여러 트랙.*구분해 저장/);
      assert.deepEqual(fixture.manifests, [masterUrl]);
      assert.deepEqual(fixture.files, []);
      assert.deepEqual(fixture.written, []);
    }
  }
});

test('inspection excludes ambiguous in-band choices and retains external renditions in mixed groups', async t => {
  let master = playlist(inbandPair);
  t.mock.method(MediaFetcher.prototype, 'manifests', async (url: string) => [{ text: url === masterUrl ? master : mediaPlaylist(url), url }]);
  let result = await inspectMedia(resource, 7);
  assert.deepEqual(result.audios, []);
  assert.deepEqual(result.videos[0].audioIds, []);
  assert.match(result.note!, /여러 오디오.*지원하지 않습니다/);
  master = playlist(inbandPair + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="External",LANGUAGE="ko",URI="external.m3u8"\n');
  result = await inspectMedia(resource, 7);
  assert.deepEqual(result.audios.map(track => track.id), ['audio-2']);
  assert.deepEqual(result.videos[0].audioIds, ['audio-2']);
  assert.match(result.audios[0].label, /External/);
  const fixture = preparation(t, master);
  await prepareInputs(fixture.ffmpeg, fixture.fetcher, request(), () => {});
  assert.deepEqual(fixture.files, ['https://media.example.test/video.ts', 'https://media.example.test/external.ts']);
  await assert.rejects(prepareInputs(fixture.ffmpeg, fixture.fetcher, request('audio-1'), () => {}), /여러 트랙/);
});

test('distinct external language selections fetch their selected audio instead of defaulting to the first', async t => {
  const master = playlist('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="english.m3u8"\n'
    + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="French",LANGUAGE="fr",URI="french.m3u8"\n');
  for (const mode of ['audio', 'video'] as const) {
    for (const [audioId, name] of [['audio-0', 'english'], ['audio-1', 'french']]) {
      const fixture = preparation(t, master);
      await prepareInputs(fixture.ffmpeg, fixture.fetcher, request(audioId, mode), () => {});
      assert.deepEqual(fixture.files, [...(mode === 'video' ? ['https://media.example.test/video.ts'] : []), `https://media.example.test/${name}.ts`]);
    }
  }
});

test('a single in-band rendition and ungrouped embedded audio remain selectable without false ambiguity', async t => {
  const single = playlist('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="Original",LANGUAGE="en",DEFAULT=YES\n');
  let master = single;
  t.mock.method(MediaFetcher.prototype, 'manifests', async (url: string) => [{ text: url === masterUrl ? master : mediaPlaylist(url), url }]);
  let result = await inspectMedia(resource, 7);
  assert.deepEqual(result.audios.map(track => track.id), ['audio-0']);
  assert.equal(result.note, undefined);
  for (const audioId of ['audio-0', undefined]) {
    const fixture = preparation(t, single);
    await prepareInputs(fixture.ffmpeg, fixture.fetcher, request(audioId), () => {});
    assert.deepEqual(fixture.files, ['https://media.example.test/video.ts']);
  }
  // An ambiguous group used by another variant must not disable this variant.
  master = playlist(inbandPair, variant + '#EXT-X-STREAM-INF:BANDWIDTH=2000\nplain.m3u8\n');
  result = await inspectMedia(resource, 7);
  assert.deepEqual(result.videos.find(track => track.id === 'video-1')?.audioIds, ['embedded']);
  assert.deepEqual(result.audios.map(track => track.id), ['embedded']);
  const fixture = preparation(t, master);
  await prepareInputs(fixture.ffmpeg, fixture.fetcher, { ...request('embedded'), videoId: 'video-1' }, () => {});
  assert.deepEqual(fixture.files, ['https://media.example.test/plain.ts']);
});

test('missing or mismatched HLS selections cannot silently fall back to an unrelated audio stream', async t => {
  const master = playlist(inbandPair + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="other",NAME="Other",URI="other.m3u8"\n');
  for (const candidate of [request('embedded'), request('missing'), request('audio-2'), { ...request('audio-0'), videoId: 'missing' }]) {
    const fixture = preparation(t, master);
    await assert.rejects(prepareInputs(fixture.ffmpeg, fixture.fetcher, candidate, () => {}), /선택한/);
    assert.deepEqual(fixture.manifests, [masterUrl]);
    assert.deepEqual(fixture.files, []);
    assert.deepEqual(fixture.written, []);
  }
});
