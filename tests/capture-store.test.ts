import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedAliases } from '../src/shared/capture-store';

test('redirect metadata removes duplicates, final URLs and non-HTTP addresses', () => {
  assert.deepEqual(boundedAliases('https://cdn.test/final', [
    'https://origin.test/start', 'https://origin.test/start', 'file:///private/media', 'blob:https://test/id',
    'https://cdn.test/final', 'http://edge.test/next',
  ]), ['https://origin.test/start', 'http://edge.test/next']);
});

test('redirect metadata is bounded by both alias count and total characters', () => {
  const aliases = boundedAliases('https://cdn.test/final', Array.from({ length: 1000 }, (_, index) => `https://origin.test/${index}`));
  assert.equal(aliases.length, 20);
  const long = Array.from({ length: 10 }, (_, index) => `https://origin.test/${index}?token=${'a'.repeat(8000)}`);
  const bounded = boundedAliases('https://cdn.test/final', long);
  assert.ok(bounded.length > 0 && bounded.length < long.length);
  assert.ok(bounded.reduce((sum, alias) => sum + alias.length, 0) <= 32768);
});
