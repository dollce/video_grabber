let hls;
let mediaSource;
const video = document.querySelector('#video');
const audio = document.querySelector('#audio');
const status = document.querySelector('#status');
async function append(buffer, bytes) {
  await new Promise((resolve, reject) => {
    buffer.addEventListener('updateend', resolve, { once: true });
    buffer.addEventListener('error', reject, { once: true });
    buffer.appendBuffer(bytes);
  });
}
async function playDash() {
  const manifest = await (await fetch('/stream.mpd')).text();
  const doc = new DOMParser().parseFromString(manifest, 'application/xml');
  mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  await new Promise(resolve => mediaSource.addEventListener('sourceopen', resolve, { once: true }));
  // Register both tracks before the first init segment advances the media element state.
  const tracks = [...doc.querySelectorAll('Representation')].map(representation => {
    const mime = representation.getAttribute('mimeType') ?? representation.parentElement.getAttribute('mimeType');
    return { representation, buffer: mediaSource.addSourceBuffer(`${mime}; codecs="${representation.getAttribute('codecs')}"`) };
  });
  for (const { representation, buffer } of tracks) {
    const template = representation.querySelector('SegmentTemplate');
    const expand = (text, number) => text.replaceAll('$RepresentationID$', representation.id).replace(/\$Number(?:%0(\d+)d)?\$/g, (_, width) => String(number).padStart(Number(width || 0), '0'));
    await append(buffer, await (await fetch('/' + expand(template.getAttribute('initialization'), 0))).arrayBuffer());
    let count = 0;
    for (const entry of template.querySelectorAll('S')) count += Number(entry.getAttribute('r') || 0) + 1;
    const start = Number(template.getAttribute('startNumber') || 1);
    for (let index = 0; index < count; index++) await append(buffer, await (await fetch('/' + expand(template.getAttribute('media'), start + index))).arrayBuffer());
  }
  mediaSource.endOfStream();
  await video.play();
}
document.querySelector('#play').addEventListener('click', async () => {
  hls?.destroy(); hls = undefined;
  video.pause(); audio.pause();
  status.textContent = '재생 준비 중';
  try {
    const mode = document.querySelector('#mode').value;
    if (['hls', 'fmp4', 'range'].includes(mode)) {
      hls = new Hls();
      hls.loadSource(mode === 'hls' ? '/master.m3u8' : mode === 'fmp4' ? '/master-fmp4.m3u8' : '/range.m3u8');
      hls.attachMedia(video);
      await new Promise((resolve, reject) => { hls.on(Hls.Events.MANIFEST_PARSED, resolve); hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) reject(new Error(data.details)); }); });
      await video.play();
    } else if (mode === 'dash') await playDash();
    else {
      video.src = mode === 'separate' ? '/video-only.mp4' : '/direct.mp4';
      if (mode === 'separate') { audio.src = '/audio.m4a'; await audio.play(); }
      await video.play();
    }
    status.textContent = '재생 중';
  } catch (error) { status.textContent = `오류: ${error.message}`; }
});
