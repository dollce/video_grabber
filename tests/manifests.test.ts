import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDash, parseHls } from '../src/media/manifests.js';

const hlsUrl = 'https://media.example.test/path/master.m3u8?signature=private';
const mpdUrl = 'https://media.example.test/path/manifest.mpd';

test('HLS master preserves quoted CODECS and associated audio groups', () => {
  const result = parseHls(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="한국어, 원본",LANGUAGE="ko",DEFAULT=YES,URI="audio/ko.m3u8?token=abc"
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="sound"
video/high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360
/video/low.m3u8
`, hlsUrl);
  assert.equal(result.type, 'master');
  if (result.type !== 'master') return;
  assert.equal(result.variants[0].url, 'https://media.example.test/path/video/high.m3u8');
  assert.equal(result.variants[0].codecs, 'avc1.640028,mp4a.40.2');
  assert.equal(result.variants[0].height, 1080);
  assert.equal(result.variants[0].audioGroup, 'sound');
  assert.equal(result.audios[0].name, '한국어, 원본');
  assert.equal(result.audios[0].default, true);
  assert.equal(result.audios[0].url, 'https://media.example.test/path/audio/ko.m3u8?token=abc');
});

test('HLS media resolves initialization and consecutive byte ranges without dropping timeline info', () => {
  const result = parseHls(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:45
#EXT-X-MAP:URI="combined.mp4",BYTERANGE="120@0"
#EXTINF:4.25,
#EXT-X-BYTERANGE:100@120
combined.mp4
#EXTINF:3.75,
#EXT-X-BYTERANGE:200
combined.mp4
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="next-init.mp4"
#EXTINF:1.5,
next.m4s
#EXT-X-ENDLIST
`, hlsUrl);
  assert.equal(result.type, 'media');
  if (result.type !== 'media') return;
  assert.equal(result.mediaSequence, 45);
  assert.equal(result.endList, true);
  assert.equal(result.segments[0].duration, 4.25);
  assert.deepEqual(result.segments[0].init?.range, { offset: 0, length: 120 });
  assert.deepEqual(result.segments[1].range, { offset: 220, length: 200 });
  assert.equal(result.segments[2].discontinuity, true);
  assert.equal(result.segments[2].init?.url, 'https://media.example.test/path/next-init.mp4');
});

test('HLS keeps the live window and permits unencrypted METHOD=NONE', () => {
  const result = parseHls('\uFEFF#EXTM3U\r\n#EXT-X-KEY:METHOD=NONE\r\n#EXTINF:2,\r\nchunk.ts\r\n', hlsUrl);
  assert.equal(result.type, 'media');
  if (result.type === 'media') assert.equal(result.endList, false);
});

test('HLS rejects wrong, truncated, encrypted, mixed and ambiguous byte range playlists', () => {
  const invalid = [
    '<html>login</html>',
    '#EXTM3U',
    '#EXTM3U\n#EXTINF:2,',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100',
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:2,\nfile.ts',
    '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES\n#EXT-X-STREAM-INF:BANDWIDTH=100\nv.m3u8',
    '#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:10\nchunk.mp4',
    '#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:10@0\na.mp4\n#EXTINF:2,\n#EXT-X-BYTERANGE:10\nb.mp4',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nv.m3u8\n#EXTINF:2,\nchunk.ts',
    '#EXTM3U\n#EXTINF:2,\nfile:///etc/passwd',
    '#EXTM3U\n#EXTINF:2,\n#EXT-X-GAP\nchunk.ts',
    '#EXTM3U\n#EXT-X-SKIP:SKIPPED-SEGMENTS=3\n#EXTINF:2,\nchunk.ts',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,BANDWIDTH=200\nv.m3u8',
    '#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:2@9007199254740990\nfile.mp4',
  ];
  for (const text of invalid) assert.throws(() => parseHls(text, hlsUrl), /./, text);
});

test('HLS caps segment expansion and rejects dangerous numeric sizes', () => {
  assert.throws(() => parseHls('#EXTM3U\n' + '#EXTINF:1,\nc.ts\n'.repeat(10001), hlsUrl), /10,000/);
  assert.throws(() => parseHls('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9007199254740991\n#EXTINF:1,\nc.ts', hlsUrl), /범위/);
});

function mpd(content: string, attrs = 'mediaPresentationDuration="PT10S"'): string {
  return `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" ${attrs}><Period>${content}</Period></MPD>`;
}

test('DASH inherits BaseURL/template attributes and expands formatted numbers', () => {
  const result = parseDash(`<MPD type="static" mediaPresentationDuration="PT5S">
  <BaseURL>assets/</BaseURL><Period>
    <SegmentTemplate timescale="1000" duration="2000" startNumber="7" initialization="$RepresentationID$-init.mp4"/>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.640028"><BaseURL>video/</BaseURL>
      <SegmentTemplate media="$RepresentationID$-$Bandwidth$-$Number%05d$.m4s"/>
      <Representation id="v1" bandwidth="1200000" width="1280" height="720"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="ko"><BaseURL>audio/</BaseURL>
      <SegmentTemplate media="$Number$.m4s"/>
      <Representation id="a1" bandwidth="128000"/>
    </AdaptationSet>
  </Period></MPD>`, mpdUrl);
  assert.equal(result.duration, 5);
  assert.equal(result.representations.length, 2);
  assert.equal(result.representations[0].id, '0:v1');
  assert.equal(result.representations[0].height, 720);
  assert.equal(result.representations[0].init?.url, 'https://media.example.test/path/assets/video/v1-init.mp4');
  assert.deepEqual(result.representations[0].segments.map(item => item.url), [
    'https://media.example.test/path/assets/video/v1-1200000-00007.m4s',
    'https://media.example.test/path/assets/video/v1-1200000-00008.m4s',
    'https://media.example.test/path/assets/video/v1-1200000-00009.m4s',
  ]);
  assert.equal(result.representations[1].kind, 'audio');
  assert.equal(result.representations[1].language, 'ko');
});

test('DASH timeline handles negative repeats bounded by next t or Period end', () => {
  const result = parseDash(mpd(`<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1">
    <SegmentTemplate timescale="1" media="chunk-$$-$Time$-$Number$.m4s" initialization="init.mp4">
      <SegmentTimeline><S t="0" d="2" r="-1"/><S t="6" d="1" r="-1"/></SegmentTimeline>
    </SegmentTemplate>
  </Representation></AdaptationSet>`), mpdUrl);
  assert.deepEqual(result.representations[0].segments.map(item => item.url.split('/').at(-1)),
    ['chunk-$-0-1.m4s', 'chunk-$-2-2.m4s', 'chunk-$-4-3.m4s', 'chunk-$-6-4.m4s',
      'chunk-$-7-5.m4s', 'chunk-$-8-6.m4s', 'chunk-$-9-7.m4s']);
});

test('DASH SegmentList preserves initialization and inclusive media ranges', () => {
  const result = parseDash(mpd(`<AdaptationSet mimeType="audio/mp4" lang="en">
    <Representation id="a" bandwidth="128000"><BaseURL>sound.mp4</BaseURL>
      <SegmentList><Initialization range="0-99"/>
        <SegmentURL mediaRange="100-299"/><SegmentURL media="other.mp4" mediaRange="0-499"/>
      </SegmentList>
    </Representation></AdaptationSet>`), mpdUrl);
  const track = result.representations[0];
  assert.deepEqual(track.init, { url: 'https://media.example.test/path/sound.mp4', range: { offset: 0, length: 100 } });
  assert.deepEqual(track.segments[0], { url: 'https://media.example.test/path/sound.mp4', range: { offset: 100, length: 200 } });
  assert.equal(track.segments[1].url, 'https://media.example.test/path/other.mp4');
});

test('DASH standalone BaseURL and XML entity escaping work without a template', () => {
  const result = parseDash(mpd(`<AdaptationSet mimeType="video/mp4"><Representation id="v">
    <BaseURL>movie.mp4?a=1&amp;b=2</BaseURL></Representation></AdaptationSet>`), mpdUrl);
  assert.deepEqual(result.representations[0].segments, [{ url: 'https://media.example.test/path/movie.mp4?a=1&b=2' }]);
});

test('DASH rejects unsupported dynamic, multi-period, SegmentBase and protected media', () => {
  const invalid = [
    '<html>login</html>',
    '<MPD type="dynamic"><Period/></MPD>',
    '<MPD mediaPresentationDuration="PT5S"><Period/><Period/></MPD>',
    mpd('<AdaptationSet mimeType="video/mp4"><Representation id="v"><SegmentBase/></Representation></AdaptationSet>'),
    mpd('<AdaptationSet mimeType="video/mp4"><ContentProtection/><Representation id="v"><BaseURL>movie.mp4</BaseURL></Representation></AdaptationSet>'),
    mpd('<AdaptationSet mimeType="video/mp4"><Representation id="v"><BaseURL>file:///tmp/video.mp4</BaseURL></Representation></AdaptationSet>'),
    '<!DOCTYPE MPD [<!ENTITY x "expanded">]>' + mpd('<AdaptationSet/>'),
    '<MPD><Period></MPD>',
    mpd('<AdaptationSet mimeType="video/mp4"><Representation id="v"/></AdaptationSet>'),
  ];
  for (const text of invalid) assert.throws(() => parseDash(text, mpdUrl), /./, text);
});

test('DASH rejects missing template fields, unsafe numbers, timeline gaps and huge repeat expansion', () => {
  const template = (body: string, attrs = '') => mpd(`<AdaptationSet mimeType="video/mp4"><Representation id="v">
    <SegmentTemplate media="$Time$.m4s" ${attrs}>${body}</SegmentTemplate>
    </Representation></AdaptationSet>`);
  assert.throws(() => parseDash(template('', 'duration="0"'), mpdUrl));
  assert.throws(() => parseDash(template('', 'duration="1" timescale="9007199254740992"'), mpdUrl));
  assert.throws(() => parseDash(template('<SegmentTimeline><S d="1" r="10001"/></SegmentTimeline>'), mpdUrl), /10,000/);
  assert.throws(() => parseDash(template('<SegmentTimeline><S d="2"/><S t="3" d="2"/></SegmentTimeline>'), mpdUrl), /시간표/);
  assert.throws(() => parseDash(template('<SegmentTimeline><S d="2" r="-1"/><S d="2"/></SegmentTimeline>'), mpdUrl), /시작 시간/);
  assert.throws(() => parseDash(template('<SegmentTimeline><S d="2" r="-1"/><S t="5" d="2"/></SegmentTimeline>'), mpdUrl), /겹칩니다/);
  assert.throws(() => parseDash(template('', 'duration="1" presentationTimeOffset="2"'), mpdUrl), /오프셋/);
  assert.throws(() => parseDash(template('<SegmentTimeline><S t="2" d="2"/></SegmentTimeline>', 'presentationTimeOffset="2"'), mpdUrl), /오프셋/);
  assert.throws(() => parseDash(template('<SegmentTimeline><S t="2" d="2"/></SegmentTimeline>'), mpdUrl), /0초/);
  assert.throws(() => parseDash(mpd(`<AdaptationSet mimeType="video/mp4"><Representation id="v">
    <SegmentList presentationTimeOffset="2"><SegmentURL media="chunk.m4s"/></SegmentList>
  </Representation></AdaptationSet>`), mpdUrl), /오프셋/);
  assert.throws(() => parseDash(mpd(`<AdaptationSet mimeType="video/mp4"><Representation id="v">
    <SegmentTemplate media="$Number%0999d$.m4s" duration="2"/>
  </Representation></AdaptationSet>`), mpdUrl), /자리 수/);
});
