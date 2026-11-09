import { downloadMedia, inspectMedia } from './media/engine';
import type { BackgroundReply, BackgroundRequest, JobProgress, MediaInspection, MediaResource, TabSnapshot, TrackChoice } from './shared/types';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}

const ui = {
  pageHost: element('page-host'), pageTitle: element('page-title'), guidance: element('source-guidance'),
  openSource: element<HTMLButtonElement>('open-source'), globalError: element('global-error'),
  captureIndicator: element('capture-indicator'), captureStatus: element('capture-status'), captureDescription: element('capture-description'),
  captureBytes: element('capture-bytes'), captureCount: element('capture-count'), captureToggle: element<HTMLButtonElement>('capture-toggle'), captureError: element('capture-error'),
  sourceCount: element('source-count'), refresh: element<HTMLButtonElement>('refresh'), emptySources: element('empty-sources'), resourceList: element('resource-list'),
  trafficCount: element('traffic-count'), clear: element<HTMLButtonElement>('clear'), selectedKind: element('selected-kind'),
  selectionEmpty: element('selection-empty'), selectionDetail: element('selection-detail'), selectedName: element('selected-name'), selectedUrl: element('selected-url'),
  inspectStatus: element('inspect-status'), inspectError: element('inspect-error'), inspectNote: element('inspect-note'),
  title: element<HTMLInputElement>('file-title'), video: element<HTMLSelectElement>('video-quality'), audio: element<HTMLSelectElement>('audio-track'),
  downloadVideo: element<HTMLButtonElement>('download-video'), downloadAudio: element<HTMLButtonElement>('download-audio'),
  job: element('job'), jobHeading: element('job-heading'), cancel: element<HTMLButtonElement>('cancel-job'), progress: element<HTMLProgressElement>('job-progress'), jobMessage: element('job-message'),
  historySection: element('history-section'), historyList: element('history-list'), segmentCount: element('segment-count'), segmentList: element('segment-list'),
};

const parameter = new URL(location.href).searchParams.get('tabId');
const tabId = parameter !== null && /^\d+$/.test(parameter) ? Number(parameter) : -1;
let snapshot: TabSnapshot | undefined;
let selected: MediaResource | undefined;
let inspection: MediaInspection | undefined;
let inspectionController: AbortController | undefined;
let jobController: AbortController | undefined;
let captureBusy = false;
let refreshBusy = false;
let missingTab = tabId < 0;
let titleEdited = false;
let inspectionVersion = 0;
let snapshotVersion = 0;
const rows = new Map<string, { row: HTMLLIElement; button: HTMLButtonElement; name: HTMLElement; meta: HTMLElement; icon: HTMLElement }>();
const kindNames = { hls: 'HLS', dash: 'DASH', video: '영상', audio: '오디오', segment: '조각' };

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showError(error?: unknown, kind: 'action' | 'connection' = 'action'): void {
  ui.globalError.hidden = error === undefined;
  ui.globalError.textContent = error === undefined ? '' : readableError(error);
  ui.globalError.dataset.kind = kind;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024, index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}

function resourceName(resource: MediaResource): string {
  try {
    const url = new URL(resource.url);
    const tail = url.pathname.split('/').filter(Boolean).at(-1);
    if (!tail) return url.hostname;
    try { return decodeURIComponent(tail); } catch { return tail; }
  } catch { return '미디어 파일'; }
}

function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return '연결된 페이지'; }
}

async function send(type: BackgroundRequest['type']): Promise<TabSnapshot> {
  const request: BackgroundRequest = { type, tabId };
  const reply = await chrome.runtime.sendMessage<BackgroundRequest, BackgroundReply>(request);
  if (!reply?.ok) throw new Error(reply?.error || '확장 프로그램에 연결할 수 없습니다. 이 탭을 새로고침해 주세요.');
  return reply.snapshot;
}

function updateButtons(): void {
  const working = !!jobController;
  const ready = !!selected && !!inspection && !inspectionController;
  ui.captureToggle.disabled = captureBusy || working || missingTab;
  ui.clear.disabled = captureBusy || working || missingTab;
  ui.refresh.disabled = refreshBusy || captureBusy || working || missingTab;
  ui.video.disabled = working || !ready || !inspection!.videos.length;
  ui.audio.disabled = working || !ready || !ui.audio.value;
  ui.title.disabled = working;
  ui.downloadVideo.disabled = working || !ready || !inspection!.videos.length;
  ui.downloadAudio.disabled = working || !ready || !ui.audio.value;
  ui.openSource.disabled = missingTab;
  for (const entry of rows.values()) entry.button.disabled = working;
}

function renderSnapshot(next: TabSnapshot): void {
  const oldUrl = snapshot?.url;
  snapshot = next;
  ui.pageHost.textContent = hostname(next.url);
  ui.pageTitle.textContent = next.title || '재생 페이지';
  if (!titleEdited && !jobController) ui.title.value = next.title || 'video';
  ui.captureIndicator.classList.toggle('active', next.capture.active);
  ui.captureStatus.textContent = next.capture.active ? '미디어 응답 수집 중' : next.capture.count ? '응답 수집 중지됨' : '자동 감지 중';
  ui.captureDescription.textContent = next.capture.active
    ? '이후 재생되는 미디어 응답을 보관합니다. 처음부터 수집하려면 재생 페이지를 새로고침하세요.'
    : '이후 재생되는 미디어 데이터를 보관합니다. 수집 중에는 Chrome에 디버깅 알림이 표시됩니다.';
  ui.captureBytes.textContent = formatBytes(next.capture.bytes);
  ui.captureCount.textContent = `응답 ${next.capture.count.toLocaleString('ko-KR')}개`;
  ui.captureToggle.textContent = next.capture.active ? '응답 수집 중지' : '응답 수집 시작';
  ui.captureToggle.classList.toggle('button-recording', next.capture.active);
  ui.captureError.hidden = !next.capture.error;
  ui.captureError.textContent = next.capture.error || '';

  const resources = next.resources.filter(resource => resource.kind !== 'segment').sort((a, b) => {
    const rank = { hls: 0, dash: 1, video: 2, audio: 3, segment: 4 };
    return rank[a.kind] - rank[b.kind] || a.firstSeen - b.firstSeen;
  });
  const ids = new Set(resources.map(resource => resource.id));
  for (const [id, entry] of rows) {
    if (!ids.has(id)) { entry.row.remove(); rows.delete(id); }
  }
  for (const [index, resource] of resources.entries()) {
    let entry = rows.get(resource.id);
    if (!entry) {
      const row = document.createElement('li'); row.className = 'resource-row';
      const button = document.createElement('button'); button.className = 'resource-button'; button.type = 'button'; button.dataset.resourceId = resource.id;
      const icon = document.createElement('span'); icon.className = 'resource-icon'; icon.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span'); copy.className = 'resource-copy';
      const name = document.createElement('span'); name.className = 'resource-name';
      const meta = document.createElement('span'); meta.className = 'resource-meta';
      copy.append(name, meta); button.append(icon, copy); row.append(button);
      button.addEventListener('click', () => {
        const current = snapshot?.resources.find(candidate => candidate.id === resource.id);
        if (current && !jobController) void selectResource(current);
      });
      entry = { row, button, name, meta, icon }; rows.set(resource.id, entry); ui.resourceList.append(row);
    }
    entry.name.textContent = resourceName(resource);
    entry.meta.textContent = `${hostname(resource.url)} · ${kindNames[resource.kind]}${resource.size ? ` · ${formatBytes(resource.size)}` : ''}`;
    entry.icon.textContent = resource.kind === 'audio' ? '♫' : kindNames[resource.kind];
    entry.button.title = resource.url;
    entry.button.classList.toggle('selected', selected?.id === resource.id);
    entry.button.setAttribute('aria-pressed', String(selected?.id === resource.id));
    if (ui.resourceList.children[index] !== entry.row) ui.resourceList.insertBefore(entry.row, ui.resourceList.children[index] || null);
  }
  ui.sourceCount.textContent = String(resources.length);
  ui.emptySources.hidden = resources.length > 0;
  ui.trafficCount.textContent = `미디어 요청 ${next.resources.reduce((total, resource) => total + resource.requests, 0).toLocaleString('ko-KR')}회`;
  const segments = next.resources.filter(resource => resource.kind === 'segment');
  ui.segmentCount.textContent = `${segments.length.toLocaleString('ko-KR')}개`;
  const segmentSignature = segments.map(resource => `${resource.id}:${resource.requests}`).join('|');
  if (ui.segmentList.dataset.signature !== segmentSignature) {
    ui.segmentList.dataset.signature = segmentSignature;
    ui.segmentList.replaceChildren(...segments.slice(-100).map(resource => {
      const item = document.createElement('li'); item.textContent = `${resourceName(resource)} · 요청 ${resource.requests}회 · ${hostname(resource.url)}`; item.title = resource.url; return item;
    }));
  }
  if (selected && !ids.has(selected.id) && !jobController) resetSelection();
  if (oldUrl && oldUrl !== next.url) {
    ui.guidance.textContent = '재생 페이지가 변경되었습니다. 새로 감지한 미디어를 선택해 주세요.';
    titleEdited = false;
    if (!jobController) ui.title.value = next.title || 'video';
  }
  if (!selected && resources[0] && !jobController) void selectResource(resources[0]);
  updateButtons();
}

function resetSelection(): void {
  inspectionController?.abort(); inspectionController = undefined; inspectionVersion++;
  selected = undefined; inspection = undefined;
  ui.selectionEmpty.hidden = false; ui.selectionDetail.hidden = true; ui.selectedKind.hidden = true;
}

function options(select: HTMLSelectElement, choices: TrackChoice[], empty: string): void {
  select.replaceChildren();
  for (const choice of choices.length ? choices : [{ id: '', label: empty }]) {
    const option = document.createElement('option'); option.value = choice.id; option.textContent = choice.label; select.append(option);
  }
}

function updateAudioChoices(): void {
  if (!inspection) return;
  const previous = ui.audio.value;
  const allowed = inspection.videos.find(video => video.id === ui.video.value)?.audioIds;
  const choices = allowed ? inspection.audios.filter(audio => allowed.includes(audio.id)) : inspection.audios;
  options(ui.audio, choices, '오디오 트랙 없음');
  if (choices.some(audio => audio.id === previous)) ui.audio.value = previous;
  updateButtons();
}

async function selectResource(resource: MediaResource): Promise<void> {
  if (jobController) return;
  inspectionController?.abort();
  const controller = new AbortController(); inspectionController = controller;
  const version = ++inspectionVersion;
  selected = resource; inspection = undefined;
  ui.selectionEmpty.hidden = true; ui.selectionDetail.hidden = false; ui.selectedKind.hidden = false;
  ui.selectedKind.textContent = kindNames[resource.kind];
  ui.selectedName.textContent = resourceName(resource); ui.selectedUrl.textContent = resource.url;
  ui.inspectStatus.textContent = '화질과 오디오 트랙을 확인하고 있습니다.';
  ui.inspectError.hidden = true; ui.inspectNote.hidden = true;
  options(ui.video, [], '확인 중'); options(ui.audio, [], '확인 중');
  for (const [id, entry] of rows) { entry.button.classList.toggle('selected', id === resource.id); entry.button.setAttribute('aria-pressed', String(id === resource.id)); }
  updateButtons();
  try {
    const result = await inspectMedia(resource, tabId, controller.signal);
    if (version !== inspectionVersion || controller.signal.aborted) return;
    inspection = result;
    options(ui.video, result.videos, '영상 트랙 없음'); updateAudioChoices();
    const notes = [result.note, result.live && !result.note ? '실시간 스트림입니다. 현재 재생 목록 또는 수집된 구간만 저장할 수 있습니다.' : undefined].filter(Boolean);
    ui.inspectNote.textContent = notes.join(' '); ui.inspectNote.hidden = !notes.length;
  } catch (error) {
    if (version !== inspectionVersion || controller.signal.aborted) return;
    ui.inspectError.textContent = `${readableError(error)} 목록에서 다시 선택하면 재시도합니다.`; ui.inspectError.hidden = false;
    options(ui.video, [], '확인 실패'); options(ui.audio, [], '확인 실패');
  } finally {
    if (version === inspectionVersion) { inspectionController = undefined; ui.inspectStatus.textContent = ''; updateButtons(); }
  }
}

async function refresh(): Promise<void> {
  if (refreshBusy || captureBusy || missingTab) return;
  refreshBusy = true; updateButtons();
  const version = snapshotVersion;
  try {
    const next = await send('snapshot');
    if (version === snapshotVersion) {
      renderSnapshot(next);
      if (ui.globalError.dataset.kind === 'connection') showError();
    }
  } catch (error) { if (version === snapshotVersion) showError(error, 'connection'); }
  finally { refreshBusy = false; updateButtons(); }
}

function updateProgress(progress: JobProgress): void {
  const headings = { inspect: '저장 준비 중', fetch: '미디어 다운로드 중', merge: '영상과 오디오 처리 중', save: '파일 저장 중', done: '저장 완료' };
  ui.jobHeading.textContent = headings[progress.phase];
  ui.jobMessage.textContent = progress.message;
  if (progress.total && progress.completed !== undefined) { ui.progress.max = progress.total; ui.progress.value = progress.completed; }
  else if (progress.phase === 'done') { ui.progress.max = 1; ui.progress.value = 1; }
  else ui.progress.removeAttribute('value');
}

function addHistory(filename: string, downloadId: number, mode: 'video' | 'audio'): void {
  const row = document.createElement('li'); row.className = 'history-item';
  const text = document.createElement('div'); const name = document.createElement('strong'); name.textContent = filename;
  const meta = document.createElement('span'); meta.textContent = `${mode === 'video' ? '영상 + 오디오' : '오디오'} · ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} · 저장 완료`;
  text.append(name, meta);
  const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = '다운로드 보기';
  button.addEventListener('click', () => chrome.downloads.show(downloadId));
  row.append(text, button); ui.historyList.prepend(row); ui.historySection.hidden = false;
  while (ui.historyList.childElementCount > 10) ui.historyList.lastElementChild?.remove();
}

async function startDownload(mode: 'video' | 'audio'): Promise<void> {
  if (jobController || !selected || !inspection || inspectionController) return;
  const controller = new AbortController(); jobController = controller;
  ui.job.hidden = false; ui.job.classList.remove('failed'); ui.cancel.hidden = false; ui.cancel.disabled = false;
  showError(); updateButtons(); updateProgress({ phase: 'inspect', message: '선택한 미디어를 준비하고 있습니다.' });
  try {
    const result = await downloadMedia({ tabId, resource: selected, videoId: ui.video.value || undefined, audioId: ui.audio.value || undefined, mode, title: ui.title.value.trim() || snapshot?.title || 'video' }, updateProgress, controller.signal);
    updateProgress({ phase: 'done', message: `${result.filename} 파일을 저장했습니다.` });
    addHistory(result.filename, result.downloadId, mode);
  } catch (error) {
    ui.job.classList.add('failed'); ui.progress.max = 1; ui.progress.value = 0;
    ui.jobHeading.textContent = controller.signal.aborted ? '저장을 취소했습니다' : '저장하지 못했습니다';
    ui.jobMessage.textContent = controller.signal.aborted ? '선택한 미디어에서 다시 저장을 시작할 수 있습니다.' : readableError(error);
  } finally { jobController = undefined; ui.cancel.hidden = true; updateButtons(); }
}

ui.captureToggle.addEventListener('click', async () => {
  if (captureBusy || jobController || missingTab) return;
  const stopping = !!snapshot?.capture.active;
  captureBusy = true; snapshotVersion++; updateButtons(); showError();
  try {
    renderSnapshot(await send(stopping ? 'capture-stop' : 'capture-start'));
  } catch (error) { showError(error); }
  finally { captureBusy = false; updateButtons(); }
});

ui.clear.addEventListener('click', async () => {
  if (captureBusy || jobController || missingTab) return;
  captureBusy = true; snapshotVersion++; updateButtons(); showError();
  try { resetSelection(); renderSnapshot(await send('clear')); }
  catch (error) { showError(error); }
  finally { captureBusy = false; updateButtons(); }
});

ui.openSource.addEventListener('click', async () => {
  try { const tab = await chrome.tabs.update(tabId, { active: true }); if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }); }
  catch { showError('재생 페이지가 닫혔습니다. 원하는 페이지에서 확장 프로그램을 다시 열어 주세요.'); }
});
ui.refresh.addEventListener('click', async () => { await refresh(); if (selected && !jobController) await selectResource(selected); });
ui.title.addEventListener('input', () => { titleEdited = true; });
ui.video.addEventListener('change', updateAudioChoices);
ui.downloadVideo.addEventListener('click', () => void startDownload('video'));
ui.downloadAudio.addEventListener('click', () => void startDownload('audio'));
ui.cancel.addEventListener('click', () => { jobController?.abort(); ui.cancel.disabled = true; ui.jobMessage.textContent = '저장을 취소하고 있습니다.'; });
window.addEventListener('beforeunload', event => { if (jobController) { event.preventDefault(); event.returnValue = ''; } });

if (missingTab) {
  ui.pageTitle.textContent = '재생 페이지에서 확장 프로그램을 열어 주세요';
  ui.guidance.textContent = '동영상이 있는 탭에서 Video Grabber 아이콘을 누르면 해당 페이지에 연결됩니다.';
  showError('연결할 재생 페이지가 지정되지 않았습니다.'); updateButtons();
} else {
  void refresh();
  setInterval(() => void refresh(), 1500);
}
