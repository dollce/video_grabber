import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackgroundReply } from '../src/shared/types';

function event() {
  const listeners: ((...args: any[]) => any)[] = [];
  return { listeners, addListener(listener: (...args: any[]) => any) { listeners.push(listener); } };
}
const onMessage = event(), onBeforeRequest = event(), onHeadersReceived = event(), onClicked = event();
const onDebuggerEvent = event(), onDetach = event(), onRemoved = event(), onStartup = event();
const commands: { target: unknown; method: string }[] = [];
const attaches: unknown[] = [];
const created: unknown[] = [];
const storage: Record<string, unknown> = {};
const fakeChrome = {
  runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`, onMessage, onStartup },
  storage: { session: { get: async () => ({ ...storage }), set: async (value: Record<string, unknown>) => Object.assign(storage, value), remove: async (key: string) => { delete storage[key]; } } },
  action: { onClicked, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { onRemoved, get: async (id: number) => ({ id, title: 'Fixture player', url: 'https://example.test/watch' }), create: async (value: unknown) => { created.push(value); } },
  webRequest: { onBeforeRequest, onHeadersReceived },
  debugger: { onEvent: onDebuggerEvent, onDetach, attach: async (target: unknown) => { attaches.push(target); }, detach: async () => {}, sendCommand: async (target: unknown, method: string) => { commands.push({ target, method }); } },
};
Object.assign(globalThis, { chrome: fakeChrome });
await import('../src/background');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
await tick();
const uiSender = { id: 'test-extension', url: 'chrome-extension://test-extension/app.html?tabId=7' };
function request(message: unknown, sender = uiSender): Promise<BackgroundReply> {
  return new Promise((resolve, reject) => {
    const accepted = onMessage.listeners[0](message, sender, resolve);
    if (accepted !== true) reject(new Error('rejected'));
  });
}

test('catalog is tab-scoped and ignores failed or extension-initiated traffic', async () => {
  const base = { tabId: 7, statusCode: 200, type: 'xmlhttprequest', responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }] };
  onHeadersReceived.listeners[0]({ ...base, url: 'https://cdn.test/main.m3u8' });
  onHeadersReceived.listeners[0]({ ...base, tabId: 8, url: 'https://cdn.test/other.m3u8' });
  onHeadersReceived.listeners[0]({ ...base, tabId: -1, url: 'https://cdn.test/background.m3u8' });
  onHeadersReceived.listeners[0]({ ...base, statusCode: 403, url: 'https://cdn.test/fail.m3u8' });
  onHeadersReceived.listeners[0]({ ...base, initiator: 'chrome-extension://test-extension', url: 'https://cdn.test/download.m3u8' });
  await tick();
  const reply = await request({ type: 'snapshot', tabId: 7 });
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.deepEqual(reply.snapshot.resources.map((resource) => resource.url), ['https://cdn.test/main.m3u8']);
  assert.equal(reply.snapshot.capture.active, false);
  assert.equal(attaches.length, 0);
});

test('content script and foreign extension senders cannot operate capture', async () => {
  for (const sender of [
    { id: 'test-extension', url: 'https://example.test/app.html' },
    { id: 'other-extension', url: 'chrome-extension://test-extension/app.html' },
    { id: 'test-extension', url: 'chrome-extension://other-extension/app.html' },
    { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' },
  ]) await assert.rejects(request({ type: 'capture-start', tabId: 7 }, sender), /rejected/);
  assert.equal(attaches.length, 0);
});

test('capture starts only on an explicit trusted request, configures child sessions, then stops', async () => {
  const reply = await request({ type: 'capture-start', tabId: 7 });
  assert.equal(reply.ok && reply.snapshot.capture.active, true);
  assert.deepEqual(attaches, [{ tabId: 7 }]);
  assert.deepEqual(commands.map((command) => command.method), ['Network.enable', 'Target.setAutoAttach']);
  onDebuggerEvent.listeners[0]({ tabId: 7 }, 'Target.attachedToTarget', { sessionId: 'child' });
  await tick();
  assert.deepEqual(commands.at(-1)?.target, { tabId: 7, sessionId: 'child' });
  const stopped = await request({ type: 'capture-stop', tabId: 7 });
  assert.equal(stopped.ok && stopped.snapshot.capture.active, false);
});

test('action opens a separate extension page bound to the clicked tab', () => {
  onClicked.listeners[0]({ id: 7 });
  assert.deepEqual(created, [{ url: 'chrome-extension://test-extension/app.html?tabId=7' }]);
});

test('only the extension removal page can clear all captured data', async () => {
  await assert.rejects(request({ type: 'uninstall-cleanup' }), /rejected/);
  await assert.rejects(request({ type: 'uninstall-cleanup' }, { id: 'test-extension', url: 'https://example.test/uninstall.html' }), /rejected/);
});
