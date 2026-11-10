import { getCapturedResponses } from '../shared/capture-store';
import type { RemoteFile } from '../shared/types';
import { bytesFromCaptured, parseContentRange } from './bytes';

export const MAX_JOB_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
/** Relative references belong to the response URL, which may differ after redirects. */
export interface ManifestSnapshot { text: string; url: string }
interface MediaResponse { bytes: Uint8Array; url: string }
export class MediaFetcher {
  bytes = 0;
  constructor(readonly tabId: number, readonly signal?: AbortSignal) {}

  async file(file: RemoteFile): Promise<Uint8Array> {
    this.signal?.throwIfAborted();
    const cached = await bytesFromCaptured(await getCapturedResponses(this.tabId, file.url), file.range);
    if (cached) return this.account(cached);
    return this.account((await this.network(file)).bytes);
  }

  async manifests(url: string): Promise<ManifestSnapshot[]> {
    const captured = await getCapturedResponses(this.tabId, url);
    const snapshots: ManifestSnapshot[] = [];
    for (const record of captured) {
      // Captured records already use Network.responseReceived's final response URL.
      if (record.status === 200 && record.body.size <= MAX_MANIFEST_BYTES) snapshots.push({ text: await record.body.text(), url: record.url });
    }
    try {
      const latest = await this.network({ url }, MAX_MANIFEST_BYTES);
      snapshots.push({ text: new TextDecoder().decode(latest.bytes), url: latest.url });
    } catch (error) {
      this.signal?.throwIfAborted();
      if (!snapshots.length) throw error;
    }
    const unique = new Map<string, ManifestSnapshot>();
    for (const snapshot of snapshots) {
      const key = JSON.stringify([snapshot.url, snapshot.text]);
      // Keep the newest occurrence last so latest-manifest selection remains
      // correct even when a playlist returns to an earlier captured body.
      unique.delete(key);
      unique.set(key, snapshot);
    }
    return [...unique.values()];
  }

  private account(data: Uint8Array): Uint8Array {
    this.bytes += data.byteLength;
    if (this.bytes > MAX_JOB_BYTES) throw new Error('한 번에 저장할 수 있는 원본 크기는 512 MiB입니다. 더 짧은 구간을 수집해 주세요.');
    return data;
  }

  private async network(file: RemoteFile, limit = MAX_JOB_BYTES - this.bytes): Promise<MediaResponse> {
    const url = new URL(file.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('HTTP(S) 미디어 주소만 지원합니다.');
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.signal?.throwIfAborted();
      try {
        const timeout = AbortSignal.timeout(45_000);
        const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
        const response = await fetch(url, {
          credentials: 'include', signal, cache: 'no-store',
          headers: file.range ? { Range: `bytes=${file.range.offset}-${file.range.offset + file.range.length - 1}` } : {},
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`미디어 요청 실패 (HTTP ${response.status}). 원본 페이지에서 수집을 시작하고 다시 재생해 주세요.`);
        }
        const effectiveUrl = new URL(response.url || url.href);
        if (!['http:', 'https:'].includes(effectiveUrl.protocol) || effectiveUrl.username || effectiveUrl.password) {
          await response.body?.cancel();
          throw new Error('HTTP(S) 미디어 주소만 지원합니다.');
        }
        const length = Number(response.headers.get('content-length'));
        if (length > limit) {
          await response.body?.cancel();
          throw new Error(`미디어 크기 제한을 초과했습니다 (${Math.round(limit / 1024 / 1024)} MiB 남음).`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('미디어 응답이 비어 있습니다.');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error('미디어 크기 제한을 초과했습니다. 더 짧은 구간을 수집해 주세요.');
            chunks.push(value);
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        if (response.status === 206) {
          const range = parseContentRange(response.headers.get('content-range') ?? undefined);
          const wanted = file.range ?? { offset: 0, length: range?.total ?? 0 };
          if (!range || range.start !== wanted.offset || bytes.length !== wanted.length || range.end + 1 !== wanted.offset + wanted.length) {
            throw new Error('서버가 요청한 바이트 구간과 다른 데이터를 반환했습니다.');
          }
          return { bytes, url: effectiveUrl.href };
        }
        if (file.range) {
          if (bytes.length < file.range.offset + file.range.length) throw new Error('미디어 바이트 구간이 파일 크기를 벗어났습니다.');
          return { bytes: bytes.slice(file.range.offset, file.range.offset + file.range.length), url: effectiveUrl.href };
        }
        return { bytes, url: effectiveUrl.href };
      } catch (error) { lastError = error; this.signal?.throwIfAborted(); }
    }
    throw lastError;
  }
}
