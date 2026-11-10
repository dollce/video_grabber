import type { ByteRange, CapturedResponse } from '../shared/types';

export function parseContentRange(value?: string): { start: number; end: number; total: number } | undefined {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) return;
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return;
  return { start, end, total };
}

// Return only a complete byte interval. A cached HTTP 206 is never a complete file by itself.
export async function bytesFromCaptured(records: CapturedResponse[], range?: ByteRange): Promise<Uint8Array | undefined> {
  const newest = [...records].sort((a, b) => b.capturedAt - a.capturedAt);
  const full = newest.find(record => record.status === 200 && !record.contentRange);
  if (full && (!range || full.body.size >= range.offset + range.length)) {
    return new Uint8Array(await (range ? full.body.slice(range.offset, range.offset + range.length) : full.body).arrayBuffer());
  }
  const parts = newest.flatMap(record => {
    const interval = parseContentRange(record.contentRange);
    return interval && record.status === 206 && record.body.size === interval.end - interval.start + 1
      ? [{ record, interval }] : [];
  });
  if (!parts.length) return;
  const total = parts[0].interval.total;
  const start = range?.offset ?? 0;
  const end = range ? range.offset + range.length : total;
  if (end > total) return;
  const chunks: Blob[] = [];
  let cursor = start;
  while (cursor < end) {
    const part = parts.find(part => part.interval.total === total && part.interval.start <= cursor && part.interval.end >= cursor);
    if (!part) return;
    const next = Math.min(end, part.interval.end + 1);
    chunks.push(part.record.body.slice(cursor - part.interval.start, next - part.interval.start));
    cursor = next;
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

export function safeFilename(value: string): string {
  return value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100) || 'video';
}
