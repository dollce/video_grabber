import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { BackgroundReply, DownloadRequest, JobProgress, MediaInspection, MediaResource, RemoteFile, TrackChoice } from '../shared/types';
import { MediaFetcher, type ManifestSnapshot } from './fetcher';
import { safeFilename } from './bytes';
import { parseDash, parseHls, type DashRepresentation, type HlsMaster, type HlsMedia } from './manifests';

type Notify = (progress: JobProgress) => void;
const embedded = { id: 'embedded', label: '영상에 포함된 첫 번째 오디오' };
const ambiguousInbandAudio = '선택한 HLS 오디오는 영상 안에 여러 트랙으로 함께 들어 있어 구분해 저장할 수 없습니다. 별도 오디오 트랙을 선택해 주세요.';
const quality = (track: { height?: number; bandwidth: number }) =>
  [track.height ? `${track.height}p` : '원본', track.bandwidth ? `${Math.round(track.bandwidth / 1000)} kbps` : ''].filter(Boolean).join(' / ');
const highest = <T extends { bandwidth: number }>(tracks: T[]): T[] => [...tracks].sort((a, b) => b.bandwidth - a.bandwidth);
// A login redirect may return HTML with HTTP 200. It must not replace a captured manifest.
export function parseManifestSnapshots<T>(snapshots: ManifestSnapshot[], parser: (text: string, url: string) => T): T[] {
  const parsed: T[] = [];
  let lastError: unknown;
  for (const { text, url } of snapshots) {
    try { parsed.push(parser(text, url)); } catch (error) { lastError = error; }
  }
  if (!parsed.length) throw lastError ?? new Error('사용 가능한 재생 목록이 없습니다.');
  return parsed;
}
const latestHls = async (fetcher: MediaFetcher, url: string) => parseManifestSnapshots(await fetcher.manifests(url), parseHls).at(-1)!;
const latestDash = async (fetcher: MediaFetcher, url: string) => parseManifestSnapshots(await fetcher.manifests(url), parseDash).at(-1)!;

export async function inspectMedia(resource: MediaResource, tabId: number, signal?: AbortSignal): Promise<MediaInspection> {
  const fetcher = new MediaFetcher(tabId, signal);
  if (resource.kind === 'hls') {
    const manifest = await latestHls(fetcher, resource.url);
    if (manifest.type === 'media') return { videos: [{ id: 'media', label: '재생 중인 원본' }], audios: [embedded], live: !manifest.endList,
      note: !manifest.endList ? '수집된 재생 목록과 현재 목록에 남아 있는 구간을 저장합니다. 수집 전 구간은 보장되지 않습니다.' : undefined };
    const variants = highest(manifest.variants);
    const defaultGroup = variants[0]?.audioGroup;
    const ambiguousGroups = ambiguousInbandGroups(manifest);
    const audios = manifest.audios.filter(track => track.url || !ambiguousGroups.has(track.groupId))
      .sort((a, b) => Number(b.groupId === defaultGroup) - Number(a.groupId === defaultGroup) || Number(b.default) - Number(a.default));
    let live = false;
    const media = await latestHls(fetcher, variants[0].url);
    if (media.type === 'media') live = !media.endList;
    const audioChoices = audios.map(track => ({ id: track.id, label: `${track.name}${track.language ? ` (${track.language})` : ''} / ${track.groupId}` }));
    if (variants.some(track => !track.audioGroup)) audioChoices.push(embedded);
    const notes = [
      live ? '수집된 구간과 현재 재생 목록을 저장합니다. 저장 중에는 이 창을 열어 두세요.' : undefined,
      variants.some(track => track.audioGroup && ambiguousGroups.has(track.audioGroup))
        ? '영상에 포함된 여러 오디오 중 하나를 구분해 저장하는 기능은 아직 지원하지 않습니다. 선택 가능한 별도 오디오가 있으면 사용할 수 있습니다.' : undefined,
    ].filter(Boolean);
    return { videos: variants.map(track => ({ id: track.id, label: quality(track), audioIds: track.audioGroup ? audios.filter(audio => audio.groupId === track.audioGroup).map(audio => audio.id) : ['embedded'] })),
      audios: audioChoices, live,
      note: notes.length ? notes.join(' ') : undefined };
  }
  if (resource.kind === 'dash') {
    const manifest = await latestDash(fetcher, resource.url);
    return { videos: highest(manifest.representations.filter(track => track.kind === 'video')).map(track => ({ id: track.id, label: quality(track) })),
      audios: highest(manifest.representations.filter(track => track.kind === 'audio')).map(track => ({ id: track.id, label: `${track.language ?? '오디오'} / ${Math.round(track.bandwidth / 1000)} kbps` })), live: false };
  }
  if (resource.kind === 'segment') throw new Error('개별 조각은 재생 목록에서 선택해 저장해 주세요.');
  const audios: TrackChoice[] = resource.kind === 'audio' ? [{ id: 'self', label: '선택한 오디오' }] : [embedded];
  if (resource.kind === 'video') {
    const reply: BackgroundReply = await chrome.runtime.sendMessage({ type: 'snapshot', tabId });
    if (reply.ok) for (const track of reply.snapshot.resources.filter(item => item.kind === 'audio')) {
      audios.push({ id: `resource:${track.url}`, label: decodeName(track.url) });
    }
  }
  return { videos: resource.kind === 'video' ? [{ id: 'self', label: '원본 화질' }] : [], audios, live: false,
    note: resource.kind === 'video' ? '분리된 오디오가 있으면 목록에서 같은 영상의 오디오를 선택하세요.' : undefined };
}

function decodeName(url: string): string {
  const name = new URL(url).pathname.split('/').at(-1) || '오디오';
  try { return decodeURIComponent(name); } catch { return name; }
}

/** Join overlapping live windows using sequence numbers, refusing silent gaps or switched renditions. */
export function combineHlsWindows(windows: HlsMedia[]): HlsMedia {
  const newest = windows.at(-1)!;
  if (!newest) throw new Error('수집한 재생 목록이 없습니다.');
  // A complete VOD playlist is authoritative; old live snapshots may belong to an earlier broadcast.
  if (newest.endList && newest.mediaSequence === 0) return newest;
  const indexed = new Map<number, HlsMedia['segments'][number]>();
  for (const window of windows) {
    window.segments.forEach((segment, i) => {
      const sequence = window.mediaSequence + i;
      const previous = indexed.get(sequence);
      if (previous && (previous.url !== segment.url || JSON.stringify(previous.range) !== JSON.stringify(segment.range) || JSON.stringify(previous.init) !== JSON.stringify(segment.init))) {
        throw new Error('수집된 라이브 목록의 조각 순서가 변경되었습니다. 수집 내역을 비우고 다시 시작해 주세요.');
      }
      indexed.set(sequence, { ...segment, discontinuity: previous?.discontinuity || segment.discontinuity });
    });
  }
  const sequences = [...indexed.keys()].sort((a, b) => a - b);
  if (sequences.length > 10_000 || sequences.at(-1)! - sequences[0] + 1 !== sequences.length) {
    throw new Error('수집 구간 사이에 누락된 조각이 있거나 조각 수 제한을 초과했습니다. 연속된 구간을 다시 수집해 주세요.');
  }
  return { type: 'media', segments: sequences.map(sequence => indexed.get(sequence)!), endList: newest.endList, mediaSequence: sequences[0] };
}

async function hlsWindows(fetcher: MediaFetcher, url: string): Promise<HlsMedia> {
  const windows = parseManifestSnapshots(await fetcher.manifests(url), parseHls);
  if (windows.some(window => window.type !== 'media')) throw new Error('중첩된 HLS 마스터 목록은 지원하지 않습니다. 미디어 목록을 선택해 주세요.');
  return combineHlsWindows(windows as HlsMedia[]);
}

async function writeHls(ffmpeg: FFmpeg, fetcher: MediaFetcher, media: HlsMedia, prefix: string, notify: Notify): Promise<string> {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...media.segments.map(segment => segment.duration)))}`, '#EXT-X-MEDIA-SEQUENCE:0'];
  const cachedFiles = new Map<string, string>();
  let currentInit = '';
  for (let index = 0; index < media.segments.length; index++) {
    const segment = media.segments[index];
    fetcher.signal?.throwIfAborted();
    if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (segment.init) {
      const key = JSON.stringify(segment.init);
      let name = cachedFiles.get(key);
      if (!name) {
        name = `${prefix}-init-${cachedFiles.size}.mp4`;
        await ffmpeg.writeFile(name, await fetcher.file(segment.init));
        cachedFiles.set(key, name);
      }
      if (currentInit !== name) { lines.push(`#EXT-X-MAP:URI="${name}"`); currentInit = name; }
    } else if (currentInit) {
      throw new Error('초기화 조각이 중간에 사라지는 HLS 목록은 지원하지 않습니다.');
    }
    const name = `${prefix}-${index}.${segment.init ? 'm4s' : 'ts'}`;
    await ffmpeg.writeFile(name, await fetcher.file(segment));
    lines.push(`#EXTINF:${segment.duration},`, name);
    notify({ phase: 'fetch', message: `${prefix === 'audio' ? '오디오' : '영상'} 조각 수집 중`, completed: index + 1, total: media.segments.length });
  }
  lines.push('#EXT-X-ENDLIST');
  const name = `${prefix}.m3u8`;
  await ffmpeg.writeFile(name, new TextEncoder().encode(lines.join('\n') + '\n'));
  return name;
}

async function writeDash(ffmpeg: FFmpeg, fetcher: MediaFetcher, track: DashRepresentation, notify: Notify): Promise<string> {
  const files: RemoteFile[] = track.init ? [track.init, ...track.segments] : track.segments;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let i = 0; i < files.length; i++) {
    const data = await fetcher.file(files[i]);
    chunks.push(data); size += data.byteLength;
    notify({ phase: 'fetch', message: `${track.kind === 'audio' ? '오디오' : '영상'} 조각 수집 중`, completed: i + 1, total: files.length });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const filename = `${track.kind}.${track.mime.includes('webm') ? 'webm' : 'mp4'}`;
  await ffmpeg.writeFile(filename, bytes);
  return filename;
}

function ambiguousInbandGroups(master: HlsMaster): Set<string> {
  const counts = new Map<string, number>();
  for (const audio of master.audios) if (!audio.url) counts.set(audio.groupId, (counts.get(audio.groupId) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([group]) => group));
}

function selectHlsAudio(master: HlsMaster, videoId?: string, audioId?: string) {
  const video = videoId ? master.variants.find(track => track.id === videoId) : highest(master.variants)[0];
  if (!video) throw new Error('선택한 HLS 화질을 찾지 못했습니다. 재생 목록을 다시 선택해 주세요.');
  const choices = master.audios.filter(track => track.groupId === video.audioGroup);
  const ambiguousGroups = ambiguousInbandGroups(master);
  const supported = choices.filter(track => track.url || !ambiguousGroups.has(track.groupId));
  let audio: HlsMaster['audios'][number] | undefined;
  if (audioId) {
    if (audioId === 'embedded') {
      if (video.audioGroup) throw new Error('선택한 화질의 오디오 트랙을 목록에서 선택해 주세요.');
    } else {
      audio = master.audios.find(track => track.id === audioId);
      if (!audio) throw new Error('선택한 HLS 오디오 트랙을 찾지 못했습니다. 재생 목록을 다시 선택해 주세요.');
    }
  } else audio = supported.find(track => track.default) ?? supported[0];
  if (audio && audio.groupId !== video.audioGroup) throw new Error('선택한 화질과 오디오 그룹이 다릅니다. 해당 화질의 오디오 그룹을 선택해 주세요.');
  // A master rendition's order or LANGUAGE does not identify its multiplexed
  // stream index. Never silently turn a named in-band choice into first audio.
  if ((audio && !audio.url && ambiguousGroups.has(audio.groupId)) || (!audio && video.audioGroup && ambiguousGroups.has(video.audioGroup))) {
    throw new Error(ambiguousInbandAudio);
  }
  if (video.audioGroup && !audio) throw new Error('선택한 화질의 오디오 트랙을 찾지 못했습니다.');
  return { video, audio };
}

export async function prepareInputs(ffmpeg: FFmpeg, fetcher: MediaFetcher, request: DownloadRequest, notify: Notify): Promise<{ inputs: string[]; audioInput: number; duration?: number }> {
  if (request.resource.kind === 'hls') {
    const manifest = await latestHls(fetcher, request.resource.url);
    let videoUrl = request.resource.url;
    let audioUrl: string | undefined;
    if (manifest.type === 'master') {
      const { video, audio } = selectHlsAudio(manifest, request.videoId, request.audioId);
      videoUrl = video.url; audioUrl = audio?.url;
    }
    if (request.mode === 'audio' && audioUrl) return { inputs: [await writeHls(ffmpeg, fetcher, await hlsWindows(fetcher, audioUrl), 'audio', notify)], audioInput: 0 };
    const videoFile = await writeHls(ffmpeg, fetcher, await hlsWindows(fetcher, videoUrl), 'video', notify);
    if (!audioUrl) return { inputs: [videoFile], audioInput: 0 };
    const audioFile = await writeHls(ffmpeg, fetcher, await hlsWindows(fetcher, audioUrl), 'audio', notify);
    // A single local master keeps video/audio transport timestamps in the same input clock.
    await ffmpeg.writeFile('master.m3u8', new TextEncoder().encode(`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioFile}"\n#EXT-X-STREAM-INF:BANDWIDTH=20000000,AUDIO="audio"\n${videoFile}\n`));
    return { inputs: ['master.m3u8'], audioInput: 0 };
  }
  if (request.resource.kind === 'dash') {
    const manifest = await latestDash(fetcher, request.resource.url);
    const audio = manifest.representations.find(track => track.id === request.audioId && track.kind === 'audio') ?? highest(manifest.representations.filter(track => track.kind === 'audio'))[0];
    if (!audio) throw new Error('이 DASH 목록에서 오디오를 찾지 못했습니다.');
    if (request.mode === 'audio') return { inputs: [await writeDash(ffmpeg, fetcher, audio, notify)], audioInput: 0, duration: manifest.duration };
    const video = manifest.representations.find(track => track.id === request.videoId && track.kind === 'video') ?? highest(manifest.representations.filter(track => track.kind === 'video'))[0];
    if (!video) throw new Error('이 DASH 목록에서 영상을 찾지 못했습니다.');
    return { inputs: [await writeDash(ffmpeg, fetcher, video, notify), await writeDash(ffmpeg, fetcher, audio, notify)], audioInput: 1, duration: manifest.duration };
  }
  if (request.resource.kind === 'segment') throw new Error('조각을 연결할 재생 목록을 선택해 주세요.');
  notify({ phase: 'fetch', message: '미디어 파일 수집 중' });
  const separate = request.audioId?.startsWith('resource:') ? request.audioId.slice(9) : undefined;
  const primary = request.mode === 'audio' && separate ? separate : request.resource.url;
  await ffmpeg.writeFile('input.bin', await fetcher.file({ url: primary }));
  if (request.mode === 'video' && separate) {
    await ffmpeg.writeFile('audio.bin', await fetcher.file({ url: separate }));
    return { inputs: ['input.bin', 'audio.bin'], audioInput: 1 };
  }
  return { inputs: ['input.bin'], audioInput: 0 };
}

async function saveDownload(url: string, filename: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const id = await chrome.downloads.download({ url, filename, saveAs: true });
  if (signal?.aborted) { await chrome.downloads.cancel(id); signal.throwIfAborted(); }
  await new Promise<void>((resolve, reject) => {
    let checking = false;
    const cleanup = () => { clearInterval(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); void chrome.downloads.cancel(id); reject(new DOMException('취소했습니다.', 'AbortError')); };
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const [download] = await chrome.downloads.search({ id });
        if (download?.state === 'complete') { cleanup(); resolve(); }
        else if (!download || download.state === 'interrupted') { cleanup(); reject(new Error('파일 저장이 취소되었거나 중단되었습니다.')); }
      } catch (error) { cleanup(); reject(error); }
      finally { checking = false; }
    };
    const timer = setInterval(() => { void check(); }, 400);
    signal?.addEventListener('abort', abort, { once: true });
    void check();
  });
  return id;
}

let busy = false;
export async function downloadMedia(request: DownloadRequest, notify: Notify, signal?: AbortSignal): Promise<{ filename: string; downloadId: number }> {
  if (busy) throw new Error('진행 중인 저장이 끝난 후 다시 시도해 주세요.');
  signal?.throwIfAborted();
  busy = true;
  let ffmpeg: FFmpeg | undefined;
  let objectUrl: string | undefined;
  const stop = () => ffmpeg?.terminate();
  const logs: string[] = [];
  try {
    notify({ phase: 'inspect', message: '미디어 처리기 준비 중' });
    const moduleUrl = chrome.runtime.getURL('vendor/ffmpeg/index.js');
    const module = await import(/* @vite-ignore */ moduleUrl) as { FFmpeg: new () => FFmpeg };
    signal?.throwIfAborted();
    ffmpeg = new module.FFmpeg();
    signal?.addEventListener('abort', stop, { once: true });
    ffmpeg.on('log', ({ message }) => { logs.push(message); if (logs.length > 60) logs.shift(); });
    await ffmpeg.load({ classWorkerURL: chrome.runtime.getURL('vendor/ffmpeg/worker.js'), coreURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.js'), wasmURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm') });
    const plan = await prepareInputs(ffmpeg, new MediaFetcher(request.tabId, signal), request, notify);
    signal?.throwIfAborted();
    notify({ phase: 'merge', message: request.mode === 'audio' ? '오디오 추출 중' : '영상과 오디오 병합 중' });
    const inputs = plan.inputs.flatMap(input => input.endsWith('.m3u8') ? ['-allowed_extensions', 'ALL', '-protocol_whitelist', 'file', '-i', input] : ['-protocol_whitelist', 'file', '-i', input]);
    const mapping = request.mode === 'audio' ? ['-map', `${plan.audioInput}:a:0`, '-vn'] : ['-map', '0:v:0', '-map', `${plan.audioInput}:a:0`, '-c:v', 'copy'];
    const args = ['-hide_banner', ...inputs, ...mapping, '-c:a', 'aac', '-b:a', '192k', ...(plan.duration ? ['-t', String(plan.duration)] : []), '-avoid_negative_ts', 'make_zero'];
    let extension = request.mode === 'audio' ? 'm4a' : 'mp4';
    let output = `output.${extension}`;
    let code = await ffmpeg.exec([...args, '-movflags', '+faststart', output], 600_000);
    if (code !== 0 && request.mode === 'video' && !signal?.aborted && !logs.some(line => /matches no streams|does not contain any stream/.test(line))) {
      notify({ phase: 'merge', message: '원본 영상 코덱을 유지하여 MKV로 병합 중' });
      extension = 'mkv'; output = 'output.mkv';
      code = await ffmpeg.exec([...args, output], 600_000);
    }
    signal?.throwIfAborted();
    if (code !== 0) {
      if (logs.some(line => /matches no streams|does not contain any stream/.test(line))) throw new Error('선택한 미디어에 필요한 영상 또는 오디오 트랙이 없습니다. 별도 오디오나 마스터 재생 목록을 선택해 주세요.');
      throw new Error('미디어를 병합하지 못했습니다. 누락된 조각이나 지원하지 않는 코덱이 있는지 확인해 주세요.');
    }
    const data = await ffmpeg.readFile(output);
    if (!(data instanceof Uint8Array) || !data.byteLength) throw new Error('완성된 미디어 파일이 비어 있습니다.');
    const mime = extension === 'm4a' ? 'audio/mp4' : extension === 'mkv' ? 'video/x-matroska' : 'video/mp4';
    objectUrl = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime }));
    const filename = `${safeFilename(request.title)}${request.mode === 'audio' ? '-audio' : ''}.${extension}`;
    notify({ phase: 'save', message: '파일 저장 위치를 선택해 주세요' });
    const downloadId = await saveDownload(objectUrl, filename, signal);
    notify({ phase: 'done', message: `${filename} 저장 완료` });
    return { filename, downloadId };
  } catch (error) {
    signal?.throwIfAborted();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    signal?.removeEventListener('abort', stop);
    ffmpeg?.terminate();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    busy = false;
  }
}
