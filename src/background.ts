import { boundedAliases, clearAllCaptured, clearCaptured, putCaptured } from './shared/capture-store';
import { classifyMedia, headerValue, httpUrl, parseContentRange } from './shared/detection';
import type { BackgroundReply, BackgroundRequest, MediaKind, TabSnapshot } from './shared/types';

const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_BODIES = 10000;
const MAX_RESOURCES = 1500;
const MAX_PENDING = 1000;
const PREFIX = 'media-tab:';
const states = new Map<number, State>();
let shuttingDown = false;

interface PendingResponse {
  requestId: string;
  url: string;
  aliases: string[];
  mime: string;
  status: number;
  contentRange?: string;
  epoch: number;
  capturedAt: number;
}
interface State {
  snapshot: TabSnapshot;
  epoch: number;
  navigationId?: string;
  pending: Map<string, PendingResponse>;
  redirects: Map<string, { url: string; aliases: string[] }>;
  tasks: Set<Promise<void>>;
  writes: Promise<void>;
  commands: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  stopping: boolean;
}

function makeState(tabId: number, snapshot?: TabSnapshot): State {
  return {
    snapshot: snapshot ?? { tabId, title: '', url: '', resources: [], capture: { active: false, bytes: 0, count: 0 } },
    epoch: 0, pending: new Map(), redirects: new Map(), tasks: new Set(), writes: Promise.resolve(), commands: Promise.resolve(), stopping: false,
  };
}
function stateFor(tabId: number): State {
  let state = states.get(tabId);
  if (!state) { state = makeState(tabId); states.set(tabId, state); }
  return state;
}
const ready = chrome.storage.session.get(null).then(async (stored) => {
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PREFIX)) continue;
    const snapshot = value as TabSnapshot;
    if (!snapshot || !Number.isInteger(snapshot.tabId) || !Array.isArray(snapshot.resources)) continue;
    if (snapshot.capture.active) {
      // A running debugger normally keeps MV3 alive. Do not silently imply continuity after a restart.
      snapshot.capture.active = false;
      snapshot.capture.error = '확장 프로그램이 다시 시작되어 수집을 중단했습니다. 수집 시작을 눌러 이어서 수집하세요.';
      await chrome.debugger.detach({ tabId: snapshot.tabId }).catch(() => undefined);
    }
    states.set(snapshot.tabId, makeState(snapshot.tabId, snapshot));
  }
}).catch(() => undefined);

function persist(state: State): void {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (states.get(state.snapshot.tabId) !== state) return;
    void chrome.storage.session.set({ [`${PREFIX}${state.snapshot.tabId}`]: state.snapshot }).catch(() => undefined);
  }, 150);
}
function warn(state: State, message: string): void {
  state.snapshot.capture.error = message;
  persist(state);
}
function badge(state: State): void {
  const count = state.snapshot.resources.filter((resource) => resource.kind !== 'segment').length;
  void chrome.action.setBadgeText({ tabId: state.snapshot.tabId, text: count ? String(count) : '' }).catch(() => undefined);
  void chrome.action.setBadgeBackgroundColor({ tabId: state.snapshot.tabId, color: '#235cba' }).catch(() => undefined);
}
function record(state: State, url: string, mime: string, kind: MediaKind, size?: number, countRequest = true): void {
  const snapshot = state.snapshot;
  const current = snapshot.resources.find((resource) => resource.url === url);
  if (current) {
    current.lastSeen = Date.now();
    if (countRequest) current.requests++;
    if (mime) current.mime = mime;
    if (size !== undefined) current.size = size;
    current.kind = kind;
  } else {
    if (snapshot.resources.length >= MAX_RESOURCES) {
      const oldestSegment = snapshot.resources.findIndex((resource) => resource.kind === 'segment');
      snapshot.resources.splice(oldestSegment >= 0 ? oldestSegment : 0, 1);
    }
    snapshot.resources.push({ id: url, tabId: snapshot.tabId, url, kind, mime, firstSeen: Date.now(), lastSeen: Date.now(), requests: 1, size });
    badge(state);
  }
  persist(state);
}

async function reset(state: State): Promise<void> {
  state.epoch++;
  state.pending.clear();
  state.redirects.clear();
  state.snapshot.resources = [];
  state.snapshot.capture = { active: state.snapshot.capture.active, bytes: 0, count: 0, startedAt: state.snapshot.capture.active ? Date.now() : undefined };
  state.writes = state.writes.catch(() => undefined).then(() => clearCaptured(state.snapshot.tabId));
  badge(state);
  persist(state);
  await state.writes;
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL(`app.html?tabId=${tab.id}`) });
});

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (shuttingDown || details.tabId < 0 || details.type !== 'main_frame') return;
  void ready.then(async () => {
    if (shuttingDown) return;
    const state = stateFor(details.tabId);
    if (state.navigationId === details.requestId) return;
    state.navigationId = details.requestId;
    state.snapshot.url = details.url;
    state.snapshot.title = '';
    await reset(state);
  }).catch(() => undefined);
  return undefined;
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] });

chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (shuttingDown || details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300 || details.initiator?.startsWith('chrome-extension:')) return;
  const headers = Object.fromEntries((details.responseHeaders ?? []).map((header) => [header.name, header.value ?? '']));
  const mime = headerValue(headers, 'content-type') ?? '';
  const kind = classifyMedia(details.url, mime) ?? (details.type === 'media' ? 'video' : undefined);
  if (!kind) return;
  const range = parseContentRange(headerValue(headers, 'content-range'));
  const length = Number(headerValue(headers, 'content-length'));
  const size = range?.total ?? (Number.isSafeInteger(length) && length > 0 ? length : undefined);
  void ready.then(() => { if (!shuttingDown) record(stateFor(details.tabId), details.url, mime, kind, size); });
  return undefined;
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

async function networkEnable(source: chrome.debugger.DebuggerSession): Promise<void> {
  await chrome.debugger.sendCommand(source, 'Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: MAX_BODY_BYTES });
  await chrome.debugger.sendCommand(source, 'Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }],
  });
}

async function start(state: State): Promise<void> {
  if (state.snapshot.capture.active) return;
  if (state.snapshot.capture.bytes >= MAX_CAPTURE_BYTES || state.snapshot.capture.count >= MAX_BODIES) throw new Error('수집 한도에 도달했습니다. 저장 후 수집 기록을 비워 주세요.');
  const tabId = state.snapshot.tabId;
  const tab = await chrome.tabs.get(tabId);
  if (!httpUrl(tab.url)) throw new Error('HTTP 또는 HTTPS 동영상 페이지에서 수집을 시작해 주세요.');
  await chrome.debugger.attach({ tabId }, '1.3');
  state.stopping = false;
  state.snapshot.capture.active = true;
  state.snapshot.capture.error = undefined;
  state.snapshot.capture.startedAt ??= Date.now();
  try { await networkEnable({ tabId }); }
  catch (error) {
    state.snapshot.capture.active = false;
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    throw error;
  } finally { persist(state); }
}

async function stop(state: State): Promise<void> {
  state.stopping = true;
  state.snapshot.capture.active = false;
  state.pending.clear();
  state.redirects.clear();
  // Already completed responses may still be being read; finish them before detaching.
  await Promise.allSettled([...state.tasks]);
  await state.writes.catch(() => undefined);
  await chrome.debugger.detach({ tabId: state.snapshot.tabId }).catch(() => undefined);
  state.stopping = false;
  persist(state);
}

function stopAtLimit(state: State): void {
  if (state.stopping) return;
  warn(state, '수집 한도(256 MiB 또는 응답 10,000개)에 도달해 수집을 중단했습니다. 저장 후 수집 기록을 비워 주세요.');
  // Schedule after the current write resolves to avoid awaiting ourselves.
  state.snapshot.capture.active = false;
  state.pending.clear();
  state.redirects.clear();
  queueMicrotask(() => { void stop(state); });
}

async function captureBody(state: State, source: chrome.debugger.DebuggerSession, pending: PendingResponse): Promise<void> {
  try {
    const result = await chrome.debugger.sendCommand(source, 'Network.getResponseBody', { requestId: pending.requestId }) as { body: string; base64Encoded: boolean };
    if (state.epoch !== pending.epoch || states.get(state.snapshot.tabId) !== state) return;
    if (result.body.length > (result.base64Encoded ? Math.ceil(MAX_BODY_BYTES / 3) * 4 : MAX_BODY_BYTES)) {
      warn(state, '32 MiB를 넘는 응답 하나를 수집하지 못했습니다. 일반 다운로드를 이용해 주세요.');
      return;
    }
    const bytes = result.base64Encoded ? Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0)) : new TextEncoder().encode(result.body);
    if (bytes.byteLength > MAX_BODY_BYTES) {
      warn(state, '32 MiB를 넘는 응답 하나를 수집하지 못했습니다. 일반 다운로드를 이용하거나 작은 스트림 조각을 수집하세요.');
      return;
    }
    if (pending.status === 206) {
      const range = parseContentRange(pending.contentRange);
      if (!range || range.end - range.start + 1 !== bytes.byteLength) {
        warn(state, '일부 범위 응답이 불완전하여 저장하지 않았습니다. 일반 다운로드로 누락된 데이터를 다시 가져올 수 있습니다.');
        return;
      }
    }
    state.writes = state.writes.catch(() => undefined).then(async () => {
      if (state.epoch !== pending.epoch || states.get(state.snapshot.tabId) !== state) return;
      const capture = state.snapshot.capture;
      if (capture.bytes + bytes.byteLength > MAX_CAPTURE_BYTES || capture.count >= MAX_BODIES) { stopAtLimit(state); return; }
      await putCaptured({ id: crypto.randomUUID(), tabId: state.snapshot.tabId, url: pending.url, aliases: pending.aliases, mime: pending.mime, status: pending.status, contentRange: pending.contentRange, capturedAt: pending.capturedAt, body: new Blob([bytes], { type: pending.mime }) });
      if (state.epoch !== pending.epoch) return;
      capture.bytes += bytes.byteLength;
      capture.count++;
      const resource = state.snapshot.resources.find((entry) => entry.url === pending.url);
      if (resource) resource.capturedBytes = (resource.capturedBytes ?? 0) + bytes.byteLength;
      persist(state);
      if (capture.bytes >= MAX_CAPTURE_BYTES || capture.count >= MAX_BODIES) stopAtLimit(state);
    });
    await state.writes;
  } catch {
    if (state.epoch === pending.epoch) warn(state, '일부 응답 데이터를 수집하지 못했습니다. 브라우저 버퍼에서 제거됐거나 요청이 중단되었을 수 있습니다. 일반 다운로드는 다시 시도할 수 있습니다.');
  }
}

chrome.debugger.onEvent.addListener((source, method, raw) => {
  if (source.tabId === undefined) return;
  void ready.then(async () => {
    const state = states.get(source.tabId!);
    if (!state?.snapshot.capture.active || state.stopping) return;
    const params = raw as Record<string, any> | undefined;
    if (!params) return;
    if (method === 'Target.attachedToTarget') {
      const child = { tabId: source.tabId!, sessionId: String(params.sessionId) };
      try { await networkEnable(child); }
      catch { warn(state, '일부 프레임 또는 worker의 트래픽 수집을 시작하지 못했습니다.'); }
      return;
    }
    const key = `${source.sessionId ?? 'root'}:${params.requestId}`;
    if (method === 'Network.requestWillBeSent') {
      // CDP reuses requestId throughout a redirect chain, but can reuse it for
      // unrelated requests later. Only a contiguous observed redirect extends it.
      const previous = state.redirects.get(key);
      state.redirects.delete(key);
      state.pending.delete(key);
      const from = params.redirectResponse?.url, to = params.request?.url;
      if (!httpUrl(from) || !httpUrl(to)) return;
      const aliases = boundedAliases(to, [...(previous?.url === from ? previous.aliases : []), from]);
      if (state.redirects.size >= MAX_PENDING) {
        warn(state, '동시 리다이렉트 요청이 너무 많아 일부 주소 연결을 수집하지 못했습니다.');
        return;
      }
      state.redirects.set(key, { url: to, aliases });
    } else if (method === 'Network.responseReceived') {
      const response = params.response;
      const redirect = state.redirects.get(key);
      state.redirects.delete(key);
      if (!response || !httpUrl(response.url) || response.status < 200 || response.status >= 300) return;
      const mime = String(response.mimeType ?? '');
      const kind = classifyMedia(response.url, mime) ?? (params.type === 'Media' ? 'video' : undefined);
      if (!kind) return;
      if (state.pending.size >= MAX_PENDING) {
        warn(state, '동시 요청이 너무 많아 일부 응답 수집을 생략했습니다.');
        return;
      }
      record(state, response.url, mime, kind, undefined, false);
      state.pending.set(key, { requestId: String(params.requestId), url: response.url, aliases: redirect && redirect.url === response.url ? redirect.aliases : [], mime, status: response.status, contentRange: headerValue(response.headers ?? {}, 'content-range'), epoch: state.epoch, capturedAt: Date.now() });
    } else if (method === 'Network.loadingFinished') {
      state.redirects.delete(key);
      const pending = state.pending.get(key);
      if (!pending) return;
      state.pending.delete(key);
      if (Number(params.encodedDataLength) > MAX_BODY_BYTES) {
        warn(state, '32 MiB를 넘는 응답 하나는 수집하지 않았습니다. 일반 다운로드를 이용해 주세요.');
        return;
      }
      const task = captureBody(state, source, pending);
      state.tasks.add(task);
      void task.finally(() => state.tasks.delete(task));
    } else if (method === 'Network.loadingFailed') {
      state.redirects.delete(key);
      if (state.pending.delete(key)) warn(state, '재생 페이지에서 미디어 요청이 중단되어 일부 응답이 수집되지 않았습니다.');
    } else if (method === 'Target.detachedFromTarget') {
      const prefix = `${params.sessionId}:`;
      for (const requestKey of state.pending.keys()) if (requestKey.startsWith(prefix)) state.pending.delete(requestKey);
      for (const requestKey of state.redirects.keys()) if (requestKey.startsWith(prefix)) state.redirects.delete(requestKey);
    }
  }).catch(() => undefined);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  void ready.then(() => {
    const state = states.get(source.tabId!);
    if (!state || state.stopping) return;
    const wasActive = state.snapshot.capture.active;
    state.snapshot.capture.active = false;
    state.pending.clear();
    state.redirects.clear();
    if (wasActive) warn(state, reason === 'canceled_by_user' ? '브라우저에서 수집 연결을 해제했습니다. 다시 시작하려면 수집 시작을 눌러 주세요.' : '재생 탭 연결이 종료되어 수집을 중단했습니다.');
    persist(state);
  });
});

function isUiSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && url.pathname === '/app.html';
  }
  catch { return false; }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: BackgroundReply) => void) => {
  if ((message as { type?: string } | null)?.type === 'uninstall-cleanup') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('uninstall.html')) return false;
    shuttingDown = true;
    void ready.then(async () => {
      const tabs = await chrome.tabs.query({});
      const managers = tabs.filter(tab => tab.url?.startsWith(chrome.runtime.getURL('app.html')) && tab.id !== undefined);
      await Promise.all(managers.map(tab => chrome.tabs.remove(tab.id!).catch(() => undefined)));
      for (const state of states.values()) {
        await state.commands.catch(() => undefined);
        await stop(state);
        state.epoch++;
        if (state.timer) clearTimeout(state.timer);
      }
      states.clear();
      await clearAllCaptured();
      await Promise.all([chrome.storage.session.clear(), chrome.storage.local.clear(), chrome.storage.sync.clear()]);
      for (const key of await caches.keys()) await caches.delete(key);
    }).then(() => sendResponse({ ok: true } as BackgroundReply), (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (shuttingDown) return false;
  if (!isUiSender(sender)) return false;
  const request = message as Partial<BackgroundRequest> | null;
  if (!request || !Number.isInteger(request.tabId) || request.tabId! < 0 || !['snapshot', 'capture-start', 'capture-stop', 'clear'].includes(request.type ?? '')) return false;
  void ready.then(async () => {
    const state = stateFor(request.tabId!);
    const perform = async () => {
      if (request.type === 'capture-start') await start(state);
      if (request.type === 'capture-stop') await stop(state);
      if (request.type === 'clear') { await stop(state); await reset(state); }
      const tab = await chrome.tabs.get(request.tabId!);
      state.snapshot.title = tab.title ?? '';
      state.snapshot.url = tab.url ?? '';
      persist(state);
      return { ok: true, snapshot: state.snapshot } as BackgroundReply;
    };
    // Polling snapshots need not queue behind the body flush of a stop operation.
    if (request.type === 'snapshot') return perform();
    const operation = state.commands.catch(() => undefined).then(perform);
    state.commands = operation;
    return operation;
  }).then(sendResponse, (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(async () => {
    const state = states.get(tabId);
    if (state) {
      state.epoch++;
      state.snapshot.capture.active = false;
      state.pending.clear();
      state.redirects.clear();
      if (state.timer) clearTimeout(state.timer);
      await state.writes.catch(() => undefined);
    }
    states.delete(tabId);
    await clearCaptured(tabId);
    await chrome.storage.session.remove(`${PREFIX}${tabId}`);
  }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void ready.then(async () => {
    for (const state of states.values()) if (state.timer) clearTimeout(state.timer);
    states.clear();
    await clearAllCaptured();
  }).catch(() => undefined);
});
