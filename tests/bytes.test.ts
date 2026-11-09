import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesFromCaptured, parseContentRange, safeFilename } from '../src/media/bytes';
import type { CapturedResponse } from '../src/shared/types';

function record(content: string, contentRange?: string): CapturedResponse {
  return { id: content, tabId: 1, url: 'https://example.test/media', status: contentRange ? 206 : 200, mime: 'video/mp4', capturedAt: 1, body: new Blob([content]), contentRange };
}
test('partial responses are only reused when the requested interval is complete', async () => {
  assert.equal(await bytesFromCaptured([record('abc', 'bytes 0-2/6')]), undefined);
  assert.equal(new TextDecoder().decode(await bytesFromCaptured([record('abc', 'bytes 0-2/6'), record('def', 'bytes 3-5/6')])), 'abcdef');
  assert.equal(new TextDecoder().decode(await bytesFromCaptured([record('abc', 'bytes 0-2/6'), record('def', 'bytes 3-5/6')], { offset: 2, length: 3 })), 'cde');
  assert.equal(await bytesFromCaptured([record('abc', 'bytes 0-2/6'), record('ef', 'bytes 4-5/6')]), undefined);
});
test('validates server ranges and slices a complete cached response', async () => {
  assert.equal(parseContentRange('bytes 3-1/4'), undefined);
  assert.equal(parseContentRange('bytes 0-3/3'), undefined);
  assert.equal(new TextDecoder().decode(await bytesFromCaptured([record('abcdef')], { offset: 1, length: 2 })), 'bc');
});
test('sanitizes download names without allowing directories', () => {
  assert.equal(safeFilename('../동영상/a:*?. '), '_동영상_a___');
  assert.equal(safeFilename('...'), 'video');
});
