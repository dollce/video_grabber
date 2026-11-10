import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackgroundReply, CapturedResponse } from '../src/shared/types';

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
const captured: CapturedResponse[] = [];
const db = { transaction() {
  const transaction = {
    oncomplete: () => {},
    objectStore: () => ({
      put(record: CapturedResponse) { captured.push(record); queueMicrotask(() => transaction.oncomplete()); },
      clear() { captured.length = 0; queueMicrotask(() => transaction.oncomplete()); },
      index: () => ({ openCursor(tabId: number) {
        const rows = captured.filter(record => record.tabId === tabId);
        let offset = 0;
        const request: { result: unknown; onsuccess: () => void } = { result: null, onsuccess: () => {} };
        const advance = () => {
          const record = rows[offset++];
          request.result = record ? { delete: () => captured.splice(captured.indexOf(record), 1), continue: () => queueMicrotask(advance) } : null;
          request.onsuccess();
          if (!record) transaction.oncomplete();
        };
        queueMicrotask(advance);
        return request;
      } }),
    }),
  };
  return transaction;
} };
Object.assign(globalThis, {
  indexedDB: { open() {
    const request = { result: db, onsuccess: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  } },
  IDBKeyRange: { only: (key: unknown) => key },
});
const fakeChrome = {
  runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`, onMessage, onStartup },
  storage: { session: { get: async () => ({ ...storage }), set: async (value: Record<string, unknown>) => Object.assign(storage, value), remove: async (key: string) => { delete storage[key]; } } },
  action: { onClicked, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { onRemoved, get: async (id: number) => ({ id, title: 'Fixture player', url: 'https://example.test/watch' }), create: async (value: unknown) => { created.push(value); } },
  webRequest: { onBeforeRequest, onHeadersReceived },
  debugger: { onEvent: onDebuggerEvent, onDetach, attach: async (target: unknown) => { attaches.push(target); }, detach: async () => {}, sendCommand: async (target: unknown, method: string) => {
    commands.push({ target, method });
    if (method === 'Network.getResponseBody') return { body: 'captured bytes', base64Encoded: false };
  } },
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

const emit = async (source: { tabId: number; sessionId?: string }, method: string, params: unknown) => {
  onDebuggerEvent.listeners[0](source, method, params);
  await tick();
};
async function redirect(source: { tabId: number; sessionId?: string }, requestId: string, from: string, to: string) {
  await emit(source, 'Network.requestWillBeSent', { requestId, redirectResponse: { url: from, status: 302 }, request: { url: to } });
}
async function finish(source: { tabId: number; sessionId?: string }, requestId: string, url: string) {
  await emit(source, 'Network.responseReceived', { requestId, response: { url, mimeType: 'application/vnd.apple.mpegurl', status: 200 } });
  await emit(source, 'Network.loadingFinished', { requestId, encodedDataLength: 14 });
}

test('capture retains a contiguous redirect chain with one body and one quota charge', async () => {
  const source = { tabId: 101 };
  await request({ type: 'capture-start', tabId: source.tabId });
  await emit(source, 'Network.requestWillBeSent', { requestId: 'r', request: { url: 'https://origin.test/start.m3u8' } });
  await redirect(source, 'r', 'https://origin.test/start.m3u8', 'https://edge.test/list.m3u8');
  await redirect(source, 'r', 'https://edge.test/list.m3u8', 'https://cdn.test/session/list.m3u8');
  await finish(source, 'r', 'https://cdn.test/session/list.m3u8');
  const stopped = await request({ type: 'capture-stop', tabId: source.tabId });
  const rows = captured.filter(record => record.tabId === source.tabId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://cdn.test/session/list.m3u8');
  assert.deepEqual(rows[0].aliases, ['https://origin.test/start.m3u8', 'https://edge.test/list.m3u8']);
  assert.equal(stopped.ok && stopped.snapshot.capture.count, 1);
  assert.equal(stopped.ok && stopped.snapshot.capture.bytes, rows[0].body.size);
});

test('redirect chains are isolated by tab and debugger child session', async () => {
  const sources = [{ tabId: 102 }, { tabId: 102, sessionId: 'child' }, { tabId: 103 }];
  for (const tabId of [102, 103]) await request({ type: 'capture-start', tabId });
  for (const [index, source] of sources.entries()) await redirect(source, 'same-request', `https://origin.test/${index}.m3u8`, `https://cdn.test/${index}.m3u8`);
  for (const [index, source] of sources.entries()) await finish(source, 'same-request', `https://cdn.test/${index}.m3u8`);
  for (const [index, source] of sources.entries()) {
    const row = captured.find(record => record.tabId === source.tabId && record.url === `https://cdn.test/${index}.m3u8`);
    assert.deepEqual(row?.aliases, [`https://origin.test/${index}.m3u8`]);
  }
  for (const tabId of [102, 103]) await request({ type: 'capture-stop', tabId });
});

test('new requests and discontinuous redirect events cannot inherit old aliases', async () => {
  const source = { tabId: 104 };
  await request({ type: 'capture-start', tabId: source.tabId });
  await redirect(source, 'reused', 'https://old.test/a', 'https://old.test/b');
  await emit(source, 'Network.requestWillBeSent', { requestId: 'reused', request: { url: 'https://new.test/list.m3u8' } });
  await finish(source, 'reused', 'https://new.test/list.m3u8');
  await redirect(source, 'broken', 'https://old.test/a', 'https://old.test/b');
  await redirect(source, 'broken', 'https://different.test/start', 'https://new.test/other.m3u8');
  await finish(source, 'broken', 'https://new.test/other.m3u8');
  assert.deepEqual(captured.find(record => record.url === 'https://new.test/list.m3u8')?.aliases, []);
  assert.deepEqual(captured.find(record => record.url === 'https://new.test/other.m3u8')?.aliases, ['https://different.test/start']);
  await request({ type: 'capture-stop', tabId: source.tabId });
});

test('failed, detached, stopped and navigation-cleared redirect state is not reused', async () => {
  const source = { tabId: 105 }, child = { tabId: 105, sessionId: 'child' };
  await request({ type: 'capture-start', tabId: source.tabId });
  await redirect(source, 'failed', 'https://old.test/failure', 'https://new.test/failed.m3u8');
  await emit(source, 'Network.loadingFailed', { requestId: 'failed' });
  await finish(source, 'failed', 'https://new.test/failed.m3u8');
  await redirect(child, 'detached', 'https://old.test/child', 'https://new.test/child.m3u8');
  await emit(source, 'Target.detachedFromTarget', { sessionId: 'child' });
  await finish(child, 'detached', 'https://new.test/child.m3u8');
  for (const row of captured.filter(record => record.tabId === source.tabId)) assert.deepEqual(row.aliases, []);
  await redirect(source, 'navigation', 'https://old.test/page', 'https://new.test/page.m3u8');
  onBeforeRequest.listeners[0]({ tabId: source.tabId, type: 'main_frame', requestId: 'new-page', url: 'https://example.test/next' });
  await tick();
  await finish(source, 'navigation', 'https://new.test/page.m3u8');
  assert.deepEqual(captured.find(record => record.url === 'https://new.test/page.m3u8')?.aliases, []);
  await redirect(source, 'stopped', 'https://old.test/stopped', 'https://new.test/stopped.m3u8');
  await request({ type: 'capture-stop', tabId: source.tabId });
  await request({ type: 'capture-start', tabId: source.tabId });
  await finish(source, 'stopped', 'https://new.test/stopped.m3u8');
  assert.deepEqual(captured.find(record => record.url === 'https://new.test/stopped.m3u8')?.aliases, []);
  await request({ type: 'capture-stop', tabId: source.tabId });
});
