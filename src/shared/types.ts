export type MediaKind = 'hls' | 'dash' | 'video' | 'audio' | 'segment';
export interface MediaResource {
  id: string;
  tabId: number;
  url: string;
  kind: MediaKind;
  mime: string;
  firstSeen: number;
  lastSeen: number;
  requests: number;
  size?: number;
  capturedBytes?: number;
}
export interface CaptureState {
  active: boolean;
  bytes: number;
  count: number;
  startedAt?: number;
  error?: string;
}
export interface TabSnapshot {
  tabId: number;
  title: string;
  url: string;
  resources: MediaResource[];
  capture: CaptureState;
}
export interface ByteRange { offset: number; length: number }
export interface RemoteFile { url: string; range?: ByteRange }
export interface CapturedResponse {
  id: string;
  tabId: number;
  url: string;
  /** Earlier HTTP(S) URLs in this response's observed redirect chain. */
  aliases?: string[];
  mime: string;
  status: number;
  contentRange?: string;
  capturedAt: number;
  body: Blob;
}
export type BackgroundRequest =
  | { type: 'snapshot'; tabId: number }
  | { type: 'capture-start'; tabId: number }
  | { type: 'capture-stop'; tabId: number }
  | { type: 'clear'; tabId: number };
export type BackgroundReply = { ok: true; snapshot: TabSnapshot } | { ok: false; error: string };
export interface TrackChoice {
  id: string;
  label: string;
  audioIds?: string[];
}
export interface MediaInspection {
  videos: TrackChoice[];
  audios: TrackChoice[];
  live: boolean;
  note?: string;
}
export interface DownloadRequest {
  tabId: number;
  resource: MediaResource;
  videoId?: string;
  audioId?: string;
  mode: 'video' | 'audio';
  title: string;
}
export interface JobProgress {
  phase: 'inspect' | 'fetch' | 'merge' | 'save' | 'done';
  message: string;
  completed?: number;
  total?: number;
}
