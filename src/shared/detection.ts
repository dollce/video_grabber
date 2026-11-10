import type { MediaKind } from './types';

/** Metadata classification only: never treats an arbitrary page response as media. */
export function classifyMedia(url: string, contentType = ''): MediaKind | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (/\.(?:m3u8|m3u)$/.test(path) || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(mime)) return 'hls';
  if (/\.mpd$/.test(path) || mime === 'application/dash+xml') return 'dash';
  // A segment must not appear as an independently downloadable movie.
  if (/\.(?:m4s|cmfv|cmfa|ts)$/.test(path) || ['video/mp2t', 'audio/mp2t', 'video/iso.segment', 'audio/iso.segment'].includes(mime)) return 'segment';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (/\.(?:m4a|aac|mp3|ogg|oga|opus|flac|wav)$/.test(path)) return 'audio';
  if (/\.(?:mp4|m4v|webm|mov|mkv)$/.test(path)) return 'video';
  return undefined;
}

export function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32768) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

export function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry && typeof entry[1] === 'string' ? entry[1] : undefined;
}

export function parseContentRange(value: string | undefined): { start: number; end: number; total?: number } | undefined {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return undefined;
  const start = Number(match[1]), end = Number(match[2]);
  const total = match[3] === '*' ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || (total !== undefined && (!Number.isSafeInteger(total) || total <= end))) return undefined;
  return { start, end, total };
}
