import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendMedia, defaultEffects, evaluateKeys, fpsValue, mediaClip, moveClip, newProject, newTrack, projectDuration, reorder, snapFrame, splitClip } from '../shared/model';
import { bitrateBudget } from '../shared/budget';
import { parseSrt, exportSrt, makeAss } from '../shared/subtitles';
import { validateProject, validateSettings } from '../shared/schema';
import { defaultExport } from '../shared/model';
import { parseProgress } from '../electron/runner';
import { atempo, silenceBounds } from '../electron/audio';
import { sameRational } from '../electron/validation';
import { buildVideoGraph, copyCompatibility, keyExpression } from '../electron/graph';
import { colorFilter, outputVideoColor } from '../electron/color';
import type { Media } from '../shared/types';
const media: Media = { id: 'one', path: 'D:\\test clip.mp4', name: 'test clip.mp4', kind: 'video', duration: 10949 * 1001 / 60000, size: 3760889327, modified: 1, streams: [],
  video: { index: 0, type: 'video', codec: 'h264', profile: 'High', width: 4096, height: 2160, fps: '60000/1001', pixFmt: 'yuv420p', timeBase: '1/60000', extradataHash: 'SHA256:abc', bitRate: 160000000 }, format: 'mp4', bitRate: 160000000, hdr: false };
test('rational frame rate remains exact for 17484 frames', () => {
  assert.equal(fpsValue('60000/1001'), 60000 / 1001);
  assert.equal(snapFrame(17484 * 1001 / 60000, '60000/1001'), 291.6914);
  assert.ok(sameRational('120000/2002', '60000/1001'));
  assert.ok(!sameRational('60/1', '60000/1001'));
});
test('decimal-byte size budget deducts audio, overhead and margin', () => {
  const budget = bitrateBudget(291.6914, 1000000000, 192, null);
  assert.ok(budget.videoKbps > 26000 && budget.videoKbps < 27000);
  assert.ok(budget.estimatedBytes < 1000000000);
  assert.equal(budget.audioBits, 192000 * 291.6914);
  assert.throws(() => bitrateBudget(0, 1e9, 192, null));
  assert.throws(() => bitrateBudget(300, 1000000, 192, null));
});
test('source specs are adopted on first insertion', () => {
  const p = appendMedia(newProject(), media);
  assert.equal(p.width, 4096); assert.equal(p.height, 2160); assert.equal(p.fps, '60000/1001');
  assert.equal(p.tracks[0].clips[0].start, 0);
});
test('reorder packs the long clip first without mutating inputs', () => {
  let p = appendMedia(newProject(), media);
  p = appendMedia(p, { ...media, id: 'two', duration: 6535 * 1001 / 60000 });
  const ids = p.tracks[0].clips.map(c => c.id);
  const next = reorder(p, p.tracks[0].id, ids.toReversed());
  assert.equal(p.tracks[0].clips[0].assetId, 'one');
  assert.equal(next.tracks[0].clips[0].assetId, 'two');
  assert.equal(projectDuration(next), 291.6914);
});
test('split preserves source mapping and key interpolation', () => {
  const p = appendMedia(newProject(), media); p.tracks[0].clips[0].effects.keys.x = [{ at: 0, value: 0 }, { at: 10, value: 1 }];
  const next = splitClip(p, p.tracks[0].clips[0].id, 5);
  const [left, right] = next.tracks[0].clips;
  assert.ok(Math.abs(right.sourceStart - left.duration) < 1e-9);
  assert.ok(Math.abs(evaluateKeys(right.effects.keys.x, 0, 0) - left.duration / 10) < 1e-8);
  assert.equal(p.tracks[0].clips.length, 1);
});
test('locked tracks reject moves and splits', () => {
  const p = appendMedia(newProject(), media); p.tracks[0].locked = true;
  assert.equal(splitClip(p, p.tracks[0].clips[0].id, 10), p);
  assert.equal(moveClip(p, p.tracks[0].clips[0].id, p.tracks[0].id, 5, true), p);
});
test('video duration is not extended by endless music settings', () => {
  const p = appendMedia(newProject(), media); const music = newTrack('audio'); music.clips.push({ ...mediaClip(media), duration: 9999, loop: true }); p.tracks.push(music);
  assert.equal(projectDuration(p), media.duration);
});
test('progress is parsed from actual FFmpeg values', () => {
  assert.deepEqual(parseProgress({ frame: '100', out_time_us: '4000000', speed: '2.50x', total_size: '12345', progress: 'continue' }), { frame: 100, seconds: 4, speed: 2.5, bytes: 12345, end: false });
  assert.equal(parseProgress({ out_time: '00:01:02.500', speed: 'N/A' }).seconds, 62.5);
});
test('only leading and trailing silence are removed', () => {
  assert.deepEqual(silenceBounds('silence_start: 0\nsilence_end: 2\nsilence_start: 4\nsilence_end: 5\nsilence_start: 18\nsilence_end: 20', 20), { start: 2, end: 18 });
  assert.deepEqual(silenceBounds('silence_start: 19', 20), { start: 0, end: 19 });
});
test('speed filters stay in supported atempo range', () => { assert.deepEqual(atempo(8), ['atempo=2', 'atempo=2', 'atempo=2']); assert.deepEqual(atempo(0.125), ['atempo=0.5', 'atempo=0.5', 'atempo=0.5']); });
test('SRT import/export retains multiline text and time ranges', () => {
  const text = '1\n00:00:01,020 --> 00:00:03,400\n第一行\n第二行\n';
  const clips = parseSrt(text); assert.equal(clips[0].start, 1.02); assert.equal(exportSrt(clips), text);
  assert.throws(() => parseSrt('1\n00:00:03,000 --> 00:00:01,000\ninvalid'));
});
test('project schema rejects out-of-bounds effects and duplicate clip IDs', () => {
  const p = appendMedia(newProject(), media); assert.ok(validateProject(p));
  p.tracks[0].clips[0].effects.opacity = 5; assert.throws(() => validateProject(p));
  p.tracks[0].clips[0].effects = defaultEffects(); p.tracks[0].clips.push(structuredClone(p.tracks[0].clips[0])); assert.throws(() => validateProject(p));
});
test('export settings reject shell-like encoder identifiers and odd dimensions', () => {
  const s = defaultExport(newProject(), 'D:\\out.mp4'); assert.ok(validateSettings(s));
  assert.throws(() => validateSettings({ ...s, encoder: 'nvenc; exit' })); assert.throws(() => validateSettings({ ...s, width: 1919 }));
});
test('copy mode explicitly rejects edits and target sizes that need compression', () => {
  const p = appendMedia(newProject(), media), s = defaultExport(p, 'D:\\out.mp4');
  assert.ok(copyCompatibility(p, s).compatible);
  p.tracks[0].clips[0].effects.rotation = 90; assert.ok(!copyCompatibility(p, s).compatible);
});
test('simple splice graph excludes extra streams and preserves per-source frames', () => {
  const p = appendMedia(newProject(), media), c = p.tracks[0].clips[0];
  const graph = buildVideoGraph(p, defaultExport(p, 'D:\\out.mp4'), [{ clip: c, media, path: media.path }]);
  assert.ok(graph.simple); assert.match(graph.graph, /end_frame=10949/); assert.match(graph.graph, /concat=n=1:v=1:a=0/);
});
test('composited HDR conversion tags frames as BT.709 before encoding', () => {
  const hdr: Media = { ...media, hdr: true, video: { ...media.video!, colorPrimaries: 'bt2020', colorTransfer: 'smpte2084', colorSpace: 'bt2020nc', colorRange: 'tv' } };
  const p = appendMedia(newProject(), hdr), c = p.tracks[0].clips[0];
  const s = { ...defaultExport(p, 'D:\\out.mp4'), hdr: 'sdr' as const };
  const graph = buildVideoGraph(p, s, [{ clip: c, media: hdr, path: hdr.path }]);
  assert.match(graph.graph, /tonemap=tonemap=hable/);
  assert.match(graph.graph, /setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited\[outv\]/);
  assert.deepEqual(outputVideoColor(p, s), { colorPrimaries: 'bt709', colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv' });
});
test('unused and hidden HDR media do not relabel an SDR timeline', () => {
  const sdr: Media = { ...media, video: { ...media.video!, colorPrimaries: 'bt709', colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv' } };
  let p = appendMedia(newProject(), sdr);
  const hdr: Media = { ...media, id: 'unused-hdr', hdr: true, video: { ...media.video!, colorPrimaries: 'bt2020', colorTransfer: 'smpte2084', colorSpace: 'bt2020nc' } };
  p.media.unshift(hdr);
  assert.equal(outputVideoColor(p, { hdr: 'preserve' }).colorTransfer, 'bt709');
  const hidden = newTrack('video'); hidden.hidden = true; hidden.clips.push(mediaClip(hdr)); p.tracks.unshift(hidden);
  assert.equal(outputVideoColor(p, { hdr: 'sdr' }).colorPrimaries, 'bt709');
  assert.equal(colorFilter({}), undefined);
  assert.equal(colorFilter({ colorRange: 'pc' }), 'setparams=range=full');
});
test('keyframe expressions use ordered bounded interpolation', () => { assert.equal(evaluateKeys([{ at: 0, value: 1 }, { at: 2, value: 3 }], 1, 0), 2); assert.match(keyExpression([{ at: 0, value: 0 }, { at: 1, value: 1 }], 0), /if\(/); });
test('ASS generation avoids subtitle formatting injection', () => {
  const p = newProject(); p.tracks[2].clips = parseSrt('1\n00:00:00,000 --> 00:00:01,000\n{\\pos(0,0)}文本');
  const ass = makeAss(p); assert.ok(ass.includes('文本')); assert.ok(!ass.includes('{\\pos(0,0)}'));
});
test('ASS centisecond rounding carries across seconds, minutes and hours', () => {
  const p = newProject();
  p.tracks[2].clips = parseSrt('1\n00:00:00,999 --> 00:00:02,999\nsecond\n\n2\n00:00:59,996 --> 00:01:01,999\nminute\n\n3\n00:59:59,996 --> 01:00:01,999\nhour');
  const ass = makeAss(p);
  assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:03\.00/);
  assert.match(ass, /Dialogue: 0,0:01:00\.00,0:01:02\.00/);
  assert.match(ass, /Dialogue: 0,1:00:00\.00,1:00:02\.00/);
});
