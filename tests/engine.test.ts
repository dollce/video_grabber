import assert from 'node:assert/strict';
import test from 'node:test';
import { combineHlsWindows, parseManifestSnapshots } from '../src/media/engine';
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
