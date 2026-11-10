import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMedia, httpUrl, headerValue, parseContentRange } from '../src/shared/detection';

test('detects media from case-insensitive paths without mistaking query strings for extensions', () => {
  assert.equal(classifyMedia('https://cdn.test/PLAY.M3U8?token=abc'), 'hls');
  assert.equal(classifyMedia('https://cdn.test/a.mpd'), 'dash');
  assert.equal(classifyMedia('https://cdn.test/a.m4s', 'video/mp4'), 'segment');
  assert.equal(classifyMedia('https://cdn.test/a.ts', 'application/octet-stream'), 'segment');
  assert.equal(classifyMedia('https://cdn.test/a.mp4'), 'video');
  assert.equal(classifyMedia('https://cdn.test/a.webm'), 'video');
  assert.equal(classifyMedia('https://cdn.test/a.m4a'), 'audio');
  assert.equal(classifyMedia('https://cdn.test/search?q=playlist.m3u8'), undefined);
});

test('MIME classification works for opaque URLs and audio wins over mp4 extension', () => {
  assert.equal(classifyMedia('https://cdn.test/opaque', 'Application/Vnd.Apple.Mpegurl; charset=utf-8'), 'hls');
  assert.equal(classifyMedia('https://cdn.test/opaque', 'application/dash+xml'), 'dash');
  assert.equal(classifyMedia('https://cdn.test/opaque', 'video/mp2t'), 'segment');
  assert.equal(classifyMedia('https://cdn.test/audio.mp4', 'audio/mp4'), 'audio');
  assert.equal(classifyMedia('https://cdn.test/opaque', 'video/webm'), 'video');
  assert.equal(classifyMedia('https://cdn.test/opaque', 'application/octet-stream'), undefined);
});

test('rejects non-network and invalid URLs', () => {
  for (const url of ['blob:https://cdn.test/video.mp4', 'file:///video.mp4', 'javascript:video.mp4', '/video.mp4', 'not a URL']) {
    assert.equal(classifyMedia(url), undefined);
    assert.equal(httpUrl(url), false);
  }
  assert.equal(httpUrl('https://cdn.test/a'), true);
  assert.equal(httpUrl(42), false);
});

test('normalizes header access and validates partial content bounds', () => {
  assert.equal(headerValue({ 'Content-Range': 'bytes 0-9/10' }, 'content-range'), 'bytes 0-9/10');
  assert.deepEqual(parseContentRange('bytes 0-9/10'), { start: 0, end: 9, total: 10 });
  assert.deepEqual(parseContentRange('bytes 5-9/*'), { start: 5, end: 9, total: undefined });
  for (const range of ['bytes 10-9/11', 'bytes 0-10/10', 'items 0-9/10', 'bytes -1-9/10', 'bytes 0-9007199254740992/*']) assert.equal(parseContentRange(range), undefined);
});
