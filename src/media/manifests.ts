import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ByteRange, RemoteFile } from '../shared/types.js';

const MAX_SEGMENTS = 10_000;
const MAX_MANIFEST_LENGTH = 8 * 1024 * 1024;

export interface HlsVariant {
  id: string;
  url: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  audioGroup?: string;
}
export interface HlsAudio {
  id: string;
  url?: string;
  groupId: string;
  name: string;
  language?: string;
  default: boolean;
}
export interface HlsSegment extends RemoteFile {
  duration: number;
  init?: RemoteFile;
  discontinuity?: boolean;
}
export interface HlsMaster {
  type: 'master';
  variants: HlsVariant[];
  audios: HlsAudio[];
}
export interface HlsMedia {
  type: 'media';
  segments: HlsSegment[];
  endList: boolean;
  mediaSequence: number;
}
export type HlsManifest = HlsMaster | HlsMedia;

export interface DashRepresentation {
  id: string;
  kind: 'video' | 'audio';
  mime: string;
  codecs?: string;
  bandwidth: number;
  width?: number;
  height?: number;
  language?: string;
  init?: RemoteFile;
  segments: RemoteFile[];
}
export interface DashManifest {
  duration: number;
  representations: DashRepresentation[];
}

function failure(message: string): never {
  throw new Error(message);
}

function manifestSize(text: string): void {
  if (text.length > MAX_MANIFEST_LENGTH) failure('재생 목록이 8 MiB 제한을 초과했습니다.');
}

function remoteUrl(value: string, base: string): string {
  if (!value.trim()) failure('재생 목록에 빈 미디어 주소가 있습니다.');
  let url: URL;
  try { url = new URL(value.trim(), base); }
  catch { return failure('재생 목록에 올바르지 않은 주소가 있습니다.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    failure('HTTP(S) 미디어 주소만 지원합니다.');
  }
  return url.href;
}

function integer(value: string | undefined, label: string, minimum = 0, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined || !/^-?\d+$/.test(value)) failure(`${label} 값이 올바르지 않습니다.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) failure(`${label} 값이 지원 범위를 벗어났습니다.`);
  return parsed;
}

function positiveNumber(value: string, label: string): number {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) failure(`${label} 값이 올바르지 않습니다.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) failure(`${label} 값이 올바르지 않습니다.`);
  return parsed;
}

function checkedSum(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) failure('미디어 시간 또는 바이트 범위가 지원 범위를 벗어났습니다.');
  return result;
}

function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let position = 0;
  while (position < text.length) {
    const match = /^([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\r\n]+))/.exec(text.slice(position));
    if (!match || result[match[1]] !== undefined) failure('HLS 속성 목록이 올바르지 않습니다.');
    result[match[1]] = match[2] ?? match[3];
    position += match[0].length;
    if (position < text.length) {
      if (text[position] !== ',' || position === text.length - 1) failure('HLS 속성 구분자가 올바르지 않습니다.');
      position++;
    }
  }
  return result;
}

function hlsRange(raw: string, url: string, previous?: RemoteFile): ByteRange {
  const match = /^(\d+)(?:@(\d+))?$/.exec(raw);
  if (!match) failure('HLS 바이트 범위가 올바르지 않습니다.');
  const length = integer(match[1], '바이트 길이', 1);
  let offset: number;
  if (match[2] !== undefined) offset = integer(match[2], '바이트 위치');
  else if (previous?.url === url && previous.range) offset = checkedSum(previous.range.offset, previous.range.length);
  else return failure('HLS 암시적 바이트 위치에는 같은 파일의 이전 범위가 필요합니다.');
  checkedSum(offset, length);
  return { offset, length };
}

/** RFC 8216 master/media playlists. A live result is the supplied playlist window. */
export function parseHls(text: string, url: string): HlsManifest {
  manifestSize(text);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') failure('올바른 HLS 재생 목록이 아닙니다.');
  const variants: HlsVariant[] = [];
  const audios: HlsAudio[] = [];
  const segments: HlsSegment[] = [];
  let pendingVariant: Record<string, string> | undefined;
  let duration: number | undefined;
  let pendingRange: string | undefined;
  let init: RemoteFile | undefined;
  let discontinuity = false;
  let endList = false;
  let mediaSequence = 0;
  let sequenceSeen = false;
  let mediaTags = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const attr = attributes(line.slice(line.indexOf(':') + 1));
      if (attr.METHOD !== 'NONE') failure('암호화된 HLS 스트림은 이번 버전에서 지원하지 않습니다.');
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (pendingVariant) failure('HLS 화질 항목의 주소가 없습니다.');
      pendingVariant = attributes(line.slice(18));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attr = attributes(line.slice(13));
      if (attr.TYPE === 'AUDIO') {
        if (!attr['GROUP-ID'] || !attr.NAME) failure('HLS 오디오 그룹 정보가 없습니다.');
        audios.push({ id: `audio-${audios.length}`, url: attr.URI ? remoteUrl(attr.URI, url) : undefined,
          groupId: attr['GROUP-ID'], name: attr.NAME, language: attr.LANGUAGE, default: attr.DEFAULT === 'YES' });
      }
    } else if (line.startsWith('#EXTINF:')) {
      if (duration !== undefined) failure('HLS 조각 주소가 없습니다.');
      duration = positiveNumber(line.slice(8).split(',')[0], 'HLS 조각 길이');
      mediaTags = true;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (pendingRange) failure('HLS 바이트 범위가 중복되었습니다.');
      pendingRange = line.slice(17);
      mediaTags = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attr = attributes(line.slice(11));
      if (!attr.URI) failure('HLS 초기화 조각 주소가 없습니다.');
      const initUrl = remoteUrl(attr.URI, url);
      init = { url: initUrl, range: attr.BYTERANGE ? hlsRange(attr.BYTERANGE, initUrl, init) : undefined };
      mediaTags = true;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
      mediaTags = true;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      if (sequenceSeen || segments.length) failure('HLS 미디어 순서 태그가 올바르지 않습니다.');
      mediaSequence = integer(line.slice(22), 'HLS 미디어 순서');
      sequenceSeen = true;
      mediaTags = true;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
      mediaTags = true;
    } else if (line === '#EXT-X-GAP' || line.startsWith('#EXT-X-SKIP:')) {
      failure('누락 조각 또는 델타 업데이트가 있는 HLS 목록은 지원하지 않습니다. 전체 목록을 다시 수집해 주세요.');
    } else if (!line.startsWith('#')) {
      const resolved = remoteUrl(line, url);
      if (pendingVariant) {
        const attr = pendingVariant;
        let width: number | undefined;
        let height: number | undefined;
        if (attr.RESOLUTION) {
          const match = /^(\d+)x(\d+)$/.exec(attr.RESOLUTION);
          if (!match) failure('HLS 해상도가 올바르지 않습니다.');
          width = integer(match[1], '가로 해상도', 1);
          height = integer(match[2], '세로 해상도', 1);
        }
        variants.push({ id: `video-${variants.length}`, url: resolved,
          bandwidth: integer(attr.BANDWIDTH, 'HLS 대역폭', 1), width, height,
          codecs: attr.CODECS, audioGroup: attr.AUDIO });
        pendingVariant = undefined;
      } else {
        if (duration === undefined) failure('길이 정보가 없는 HLS 조각입니다.');
        if (endList) failure('HLS 종료 태그 뒤에 조각이 있습니다.');
        const range = pendingRange ? hlsRange(pendingRange, resolved, segments.at(-1)) : undefined;
        segments.push({ url: resolved, duration, range, init, discontinuity: discontinuity || undefined });
        if (segments.length > MAX_SEGMENTS) failure('HLS 조각 수가 10,000개 제한을 초과했습니다.');
        duration = undefined;
        pendingRange = undefined;
        discontinuity = false;
      }
    }
    if (variants.length + audios.length > 1000) failure('HLS 트랙 수가 지원 범위를 초과했습니다.');
  }
  if (pendingVariant || duration !== undefined || pendingRange) failure('HLS 재생 목록이 중간에 잘렸습니다.');
  if (variants.length || audios.length) {
    if (mediaTags || segments.length || !variants.length) failure('HLS 마스터 목록과 미디어 목록이 섞였거나 비어 있습니다.');
    return { type: 'master', variants, audios };
  }
  if (!segments.length) failure('HLS 목록에 다운로드할 조각이 없습니다.');
  checkedSum(mediaSequence, segments.length);
  return { type: 'media', segments, endList, mediaSequence };
}

type XmlNode = Record<string, unknown>;
function node(value: unknown): XmlNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : {};
}
function children(value: XmlNode, name: string): XmlNode[] {
  const child = value[name];
  if (child === undefined) return [];
  return (Array.isArray(child) ? child : [child]).map(node);
}
function one(value: XmlNode, name: string): XmlNode | undefined {
  const found = children(value, name);
  if (found.length > 1) failure(`DASH ${name} 항목이 중복되었습니다.`);
  return found[0];
}
function attribute(value: XmlNode, name: string): string | undefined {
  const result = value[`@_${name}`];
  return result === undefined ? undefined : String(result);
}
function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const content = node(value)['#text'];
    return content === undefined ? undefined : String(content);
  }
  return undefined;
}
function baseUrl(parent: string, value: XmlNode): string {
  const base = value.BaseURL;
  if (base === undefined) return parent;
  const first = Array.isArray(base) ? base[0] : base;
  const content = textValue(first);
  if (!content) failure('DASH BaseURL이 비어 있습니다.');
  return remoteUrl(content, parent);
}
function isoDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) failure('DASH 재생 시간이 올바르지 않습니다.');
  const result = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 +
    Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER || result < 0) failure('DASH 재생 시간이 지원 범위를 벗어났습니다.');
  return result;
}
function dashRange(raw: string | undefined): ByteRange | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)-(\d+)$/.exec(raw);
  if (!match) failure('DASH 바이트 범위가 올바르지 않습니다.');
  const offset = integer(match[1], 'DASH 바이트 위치');
  const end = integer(match[2], 'DASH 바이트 끝', offset);
  const length = checkedSum(end - offset, 1);
  checkedSum(offset, length);
  return { offset, length };
}

type Addressing = { kind: 'SegmentTemplate' | 'SegmentList' | 'SegmentBase'; value: XmlNode };
function addressing(parent: Addressing | undefined, value: XmlNode): Addressing | undefined {
  const types = ['SegmentTemplate', 'SegmentList', 'SegmentBase'] as const;
  const present = types.filter(name => value[name] !== undefined);
  if (present.length > 1) failure('DASH 조각 주소 지정 방식이 중복되었습니다.');
  if (!present.length) return parent;
  const kind = present[0];
  const own = one(value, kind)!;
  return { kind, value: parent?.kind === kind ? { ...parent.value, ...own } : own };
}

interface TemplateValues { RepresentationID?: string; Bandwidth: number; Number?: number; Time?: number }
function expandTemplate(template: string, values: TemplateValues): string {
  let result = '';
  for (let i = 0; i < template.length;) {
    if (template[i] !== '$') { result += template[i++]; continue; }
    if (template[i + 1] === '$') { result += '$'; i += 2; continue; }
    const match = /^\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/.exec(template.slice(i));
    if (!match) failure('지원하지 않는 DASH 주소 템플릿입니다.');
    const key = match[1] as keyof TemplateValues;
    const value = values[key];
    if (value === undefined || (key === 'RepresentationID' && match[2])) failure('DASH 주소 템플릿 값이 없습니다.');
    const width = match[2] ? integer(match[2], 'DASH 숫자 자리 수', 1) : 0;
    if (width > 20) failure('DASH 숫자 자리 수가 지원 범위를 초과했습니다.');
    result += String(value).padStart(width, '0');
    i += match[0].length;
  }
  return result;
}

function timelinePoints(template: XmlNode, duration: number): Array<{ time: number; number: number }> {
  const timescale = integer(attribute(template, 'timescale'), 'DASH timescale', 1, 1);
  const startNumber = integer(attribute(template, 'startNumber'), 'DASH 시작 번호', 0, 1);
  const offset = integer(attribute(template, 'presentationTimeOffset'), 'DASH 시간 오프셋', 0, 0);
  if (offset !== 0) failure('DASH 시간 오프셋은 아직 지원하지 않습니다.');
  const end = offset + duration * timescale;
  if (!Number.isFinite(end) || end > Number.MAX_SAFE_INTEGER) failure('DASH 조각 시간이 지원 범위를 초과했습니다.');
  const points: Array<{ time: number; number: number }> = [];
  let number = startNumber;
  const timeline = one(template, 'SegmentTimeline');
  const push = (time: number) => {
    if (points.length >= MAX_SEGMENTS) failure('DASH 조각 수가 10,000개 제한을 초과했습니다.');
    points.push({ time, number });
    number = checkedSum(number, 1);
  };
  if (!timeline) {
    const step = integer(attribute(template, 'duration'), 'DASH 조각 길이', 1);
    // Simple addressing has sample times (Number - startNumber) * duration.
    const count = Math.ceil(duration * timescale / step);
    if (count > MAX_SEGMENTS) failure('DASH 조각 수가 10,000개 제한을 초과했습니다.');
    for (let i = 0; i < count; i++) push(i * step);
    return points;
  }
  const entries = children(timeline, 'S');
  if (!entries.length) failure('DASH 시간표가 비어 있습니다.');
  let cursor = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const specifiedTime = attribute(entry, 't');
    if (specifiedTime !== undefined) {
      const time = integer(specifiedTime, 'DASH 조각 시간');
      if (i === 0 && time !== 0) failure('0초에서 시작하지 않는 DASH 시간표는 아직 지원하지 않습니다.');
      if (i > 0 && time !== cursor) failure('시간이 겹치거나 누락된 DASH 시간표는 지원하지 않습니다.');
      cursor = time;
    }
    const step = integer(attribute(entry, 'd'), 'DASH 조각 길이', 1);
    const repeat = integer(attribute(entry, 'r'), 'DASH 반복 수', -1, 0);
    let count = repeat + 1;
    if (repeat === -1) {
      const nextTime = i + 1 < entries.length ? attribute(entries[i + 1], 't') : undefined;
      if (i + 1 < entries.length && nextTime === undefined) failure('DASH 무한 반복 뒤에는 명시적 시작 시간이 필요합니다.');
      const boundary = nextTime === undefined ? end : integer(nextTime, 'DASH 다음 조각 시간');
      if (boundary <= cursor) failure('DASH 반복 종료 시간이 올바르지 않습니다.');
      count = Math.ceil((boundary - cursor) / step);
      if (nextTime !== undefined && (boundary - cursor) % step !== 0) failure('DASH 반복 조각 시간이 겹칩니다.');
    }
    if (count > MAX_SEGMENTS || points.length + count > MAX_SEGMENTS) failure('DASH 조각 수가 10,000개 제한을 초과했습니다.');
    for (let repeatIndex = 0; repeatIndex < count; repeatIndex++) {
      const next = checkedSum(cursor, step);
      // Include only segments overlapping the requested Period.
      if (next > offset && cursor < end) push(cursor);
      else number = checkedSum(number, 1);
      cursor = next;
    }
  }
  if (!points.length) failure('DASH 재생 구간에 해당하는 조각이 없습니다.');
  return points;
}

function representationFiles(address: Addressing | undefined, base: string, values: TemplateValues, duration: number):
  Pick<DashRepresentation, 'init' | 'segments'> {
  if (!address) return { segments: [{ url: base }] };
  if (address.kind === 'SegmentBase') failure('DASH SegmentBase 인덱스 방식은 아직 지원하지 않습니다.');
  const value = address.value;
  if (integer(attribute(value, 'presentationTimeOffset'), 'DASH 시간 오프셋', 0, 0) !== 0) {
    failure('DASH 시간 오프셋은 아직 지원하지 않습니다.');
  }
  if (address.kind === 'SegmentList') {
    const initialization = one(value, 'Initialization');
    const init = initialization ? {
      url: attribute(initialization, 'sourceURL') ? remoteUrl(attribute(initialization, 'sourceURL')!, base) : base,
      range: dashRange(attribute(initialization, 'range')),
    } : undefined;
    const entries = children(value, 'SegmentURL');
    if (!entries.length || entries.length > MAX_SEGMENTS) failure('DASH 조각 목록이 비어 있거나 10,000개 제한을 초과했습니다.');
    const segments = entries.map(entry => {
      const media = attribute(entry, 'media');
      const range = dashRange(attribute(entry, 'mediaRange'));
      if (!media && !range) failure('DASH 조각 주소가 없습니다.');
      return { url: media ? remoteUrl(media, base) : base, range };
    });
    return { init, segments };
  }
  const media = attribute(value, 'media');
  if (!media) failure('DASH 조각 주소 템플릿이 없습니다.');
  const initialization = attribute(value, 'initialization');
  const init = initialization ? { url: remoteUrl(expandTemplate(initialization, values), base) } : undefined;
  const segments = timelinePoints(value, duration).map(point => ({
    url: remoteUrl(expandTemplate(media, { ...values, Number: point.number, Time: point.time }), base),
  }));
  return { init, segments };
}

/** Static, single-Period MPDs; unsupported addressing fails instead of concatenating guessed URLs. */
export function parseDash(text: string, url: string): DashManifest {
  manifestSize(text);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) failure('DASH XML 문서 형식 선언과 엔터티는 지원하지 않습니다.');
  if (XMLValidator.validate(text) !== true) failure('올바른 DASH XML 문서가 아닙니다.');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
    removeNSPrefix: true, trimValues: true, processEntities: true }).parse(text) as XmlNode;
  const mpd = one(parsed, 'MPD');
  if (!mpd) failure('DASH MPD가 없습니다.');
  if (attribute(mpd, 'type') && attribute(mpd, 'type') !== 'static') failure('실시간 DASH는 아직 지원하지 않습니다.');
  const periods = children(mpd, 'Period');
  if (periods.length !== 1) failure('DASH는 하나의 Period를 가진 목록만 지원합니다.');
  const period = periods[0];
  const start = isoDuration(attribute(period, 'start')) ?? 0;
  if (start !== 0) failure('0초에서 시작하지 않는 DASH Period는 아직 지원하지 않습니다.');
  const duration = isoDuration(attribute(period, 'duration')) ?? isoDuration(attribute(mpd, 'mediaPresentationDuration'));
  if (!duration || duration <= 0) failure('DASH 전체 재생 시간이 없습니다.');
  const mpdBase = baseUrl(remoteUrl(url, url), mpd);
  const periodBase = baseUrl(mpdBase, period);
  const periodAddress = addressing(addressing(undefined, mpd), period);
  const representations: DashRepresentation[] = [];
  let totalSegments = 0;
  let adaptationIndex = 0;
  for (const adaptation of children(period, 'AdaptationSet')) {
    const adaptationBase = baseUrl(periodBase, adaptation);
    const adaptationAddress = addressing(periodAddress, adaptation);
    let representationIndex = 0;
    for (const representation of children(adaptation, 'Representation')) {
      const mime = attribute(representation, 'mimeType') ?? attribute(adaptation, 'mimeType') ?? '';
      const contentType = attribute(representation, 'contentType') ?? attribute(adaptation, 'contentType');
      const kind = contentType === 'audio' || mime.startsWith('audio/') ? 'audio' :
        contentType === 'video' || mime.startsWith('video/') ? 'video' : undefined;
      if (!kind) continue;
      if (adaptation.ContentProtection !== undefined || representation.ContentProtection !== undefined || mpd.ContentProtection !== undefined) {
        failure('암호화된 DASH 스트림은 이번 버전에서 지원하지 않습니다.');
      }
      const originalId = attribute(representation, 'id');
      const id = `${adaptationIndex}:${originalId ?? representationIndex}`;
      if (representations.some(item => item.id === id)) failure('DASH 트랙 ID가 중복되었습니다.');
      const bandwidth = integer(attribute(representation, 'bandwidth'), 'DASH 대역폭', 0, 0);
      const widthValue = attribute(representation, 'width') ?? attribute(adaptation, 'width');
      const heightValue = attribute(representation, 'height') ?? attribute(adaptation, 'height');
      const base = baseUrl(adaptationBase, representation);
      const address = addressing(adaptationAddress, representation);
      if (!address && base === url) failure('DASH 미디어 파일 주소가 없습니다.');
      const files = representationFiles(address, base, { RepresentationID: originalId, Bandwidth: bandwidth }, duration);
      totalSegments += files.segments.length;
      if (totalSegments > 50_000) failure('DASH 전체 조각 수가 50,000개 제한을 초과했습니다.');
      representations.push({ id, kind, mime: mime || `${kind}/mp4`, bandwidth,
        codecs: attribute(representation, 'codecs') ?? attribute(adaptation, 'codecs'),
        width: widthValue === undefined ? undefined : integer(widthValue, 'DASH 가로 해상도', 1),
        height: heightValue === undefined ? undefined : integer(heightValue, 'DASH 세로 해상도', 1),
        language: attribute(representation, 'lang') ?? attribute(adaptation, 'lang'), ...files });
      if (representations.length > 1000) failure('DASH 트랙 수가 지원 범위를 초과했습니다.');
      representationIndex++;
    }
    adaptationIndex++;
  }
  if (!representations.length) failure('DASH 목록에 영상 또는 오디오 트랙이 없습니다.');
  return { duration, representations };
}
