import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { capabilities, locateNative } from '../electron/native';
import { Cancelled, ffmpeg } from '../electron/runner';
import { MediaService, probe } from '../electron/media';
import { prepareAudio } from '../electron/audio';
import { ExportQueue } from '../electron/exporter';
import { PreviewService } from '../electron/previews';
import { ProjectStore } from '../electron/storage';
import { appendMedia, defaultExport, newProject, newTrack, projectDuration } from '../shared/model';
import type { ExportSettings, Project } from '../shared/types';

const root = path.resolve('test-artifacts');
await mkdir(root, { recursive: true });
const work = await mkdtemp(path.join(root, 'features-')), tools = await locateNative(), caps = await capabilities(tools);
const store = new ProjectStore(path.join(work, 'profile'));
await store.init();
const queue = new ExportQueue(tools, caps, store, () => {});
let audioStarted: (() => void) | undefined;
const previews = new PreviewService(tools, store.cache, event => {
  if (event.type === 'status' && event.text.includes('准备有限时长音频')) audioStarted?.();
});
const checks: string[] = [];
let failure: string | undefined;
const passed = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
async function output(name: string, project: Project, patch: Partial<ExportSettings> = {}) {
  const settings = { ...defaultExport(project, path.join(work, `${name}.mp4`)), codec: 'h264' as const, encoder: 'software', preset: 'fast' as const,
    maxBytes: null, videoKbps: 1500, threads: 2, ...patch };
  const queued = await queue.enqueue(project, settings);
  await queue.idle();
  const result = queue.jobs.find(j => j.id === queued.id)!;
  assert.equal(result.stage, 'completed', result.error);
  assert.ok(result.validation?.passed && result.validation.decoded);
  return result.output;
}
async function imageAt(filename: string, time: number) {
  const image = path.join(work, `pixel-${checks.length}-${time}.png`);
  await ffmpeg(tools.ffmpeg, ['-y', '-threads', '2', '-ss', String(time), '-i', filename, '-map', '0:v:0', '-frames:v', '1', image]);
  return image;
}
async function pixel(filename: string, x = 160, y = 90) {
  const { data, info } = await sharp(filename).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [...data.subarray(at, at + 3)];
}
const isRed = (rgb: number[]) => rgb[0] > 190 && rgb[1] < 40 && rgb[2] < 40;
const isBlue = (rgb: number[]) => rgb[2] > 190 && rgb[0] < 40 && rgb[1] < 40;
async function volume(filename: string, start: number, length = 0.2) {
  const result = await ffmpeg(tools.ffmpeg, ['-loglevel', 'info', '-ss', String(start), '-t', String(length), '-i', filename, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(result.stderr);
  assert.ok(match, result.stderr);
  return Number(match[1]);
}
try {
  const red = path.join(work, 'red.mp4'), blue = path.join(work, 'blue.mp4'), grey = path.join(work, 'grey.mp4');
  for (const [filename, color] of [[red, 'red'], [blue, 'blue'], [grey, 'gray']] as const) {
    await ffmpeg(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24:d=4`, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '2', filename]);
  }
  const tone = path.join(work, 'tone.wav'), paddedTone = path.join(work, 'padded-tone.wav');
  await ffmpeg(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-ac', '2', tone]);
  await ffmpeg(tools.ffmpeg, ['-y', '-i', tone, '-af', 'adelay=200:all=1,apad=pad_dur=0.2', paddedTone]);
  const originals = [red, blue, grey, tone, paddedTone];
  const hashes = await Promise.all(originals.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')));
  const base = appendMedia(newProject(), await probe(tools, red));

  const slowed = appendMedia(base, await probe(tools, tone));
  const audioClip = slowed.tracks.find(t => t.kind === 'audio')!.clips[0];
  audioClip.duration = 4; audioClip.rate = 0.5; audioClip.loop = false; audioClip.trimSilence = false;
  audioClip.effects.fadeIn = 0; audioClip.effects.fadeOut = 0;
  const audioWork = path.join(work, 'slow-audio'); await mkdir(audioWork);
  const mixed = await prepareAudio(slowed, { tools, work: audioWork, settings: defaultExport(slowed, ''), signal: new AbortController().signal,
    phase: () => {}, progress: () => {}, log: () => {} });
  assert.ok(mixed); assert.ok(Math.abs((await probe(tools, mixed)).duration - 4) < 0.02);
  const tailDb = await volume(mixed, 3.5);
  assert.ok(tailDb > -35, `Slowed audio tail is silent: ${tailDb} dB`);
  passed('slowed audio is audible near its actual timeline end');
  const slowExport = await output('slow-audio-export', slowed);
  assert.ok(await volume(slowExport, 3.5) > -35);
  passed('slowed soundtrack survives final AAC packaging');

  const looped = appendMedia(base, await probe(tools, paddedTone), true);
  const loop = looped.tracks.find(t => t.kind === 'audio')!.clips[0];
  loop.crossfade = 0.2; loop.effects.fadeIn = 0; loop.effects.fadeOut = 0;
  const finite = await previews.soundtrack(looped); assert.ok(finite);
  assert.ok(Math.abs((await probe(tools, finite)).duration - projectDuration(looped)) < 0.02);
  for (const time of [0.03, 1.76, 1.84, 3.6, 3.75]) assert.ok(await volume(finite, time, 0.08) > -35, `Silent finite loop at ${time}`);
  passed('trimmed crossfade loops have finite duration and audible joins');

  const started = new Promise<void>(resolve => { audioStarted = resolve; });
  const interrupted = previews.soundtrack(slowed).then(() => null, error => error);
  await started;
  const changed = structuredClone(slowed); changed.tracks.find(t => t.kind === 'audio')!.clips[0].effects.volumeDb = -6;
  const replacement = previews.soundtrack(changed);
  assert.ok(await interrupted instanceof Cancelled);
  const replacementFile = await replacement; assert.ok(replacementFile);
  const replacementDb = await volume(replacementFile, 3.5);
  assert.ok(Math.abs(replacementDb - tailDb + 6) < 1, `${replacementDb} vs ${tailDb}`);
  audioStarted = undefined;
  const visualEdit = structuredClone(changed); visualEdit.tracks[0].clips[0].effects.rotation = 90;
  assert.equal(await previews.soundtrack(visualEdit), replacementFile);
  passed('superseded native audio work is cancelled and unchanged audio stays cached');

  const pip = appendMedia(base, await probe(tools, blue));
  const overlay = pip.tracks[0].clips.pop()!; overlay.start = 0; overlay.effects.scale = 0.5;
  const top = newTrack('video'); top.clips.push(overlay); pip.tracks.push(top);
  const pipFile = await output('picture-in-picture', pip), pipImage = await imageAt(pipFile, 0.5);
  assert.ok(isRed(await pixel(pipImage, 30, 30))); assert.ok(isBlue(await pixel(pipImage)));
  passed('multitrack picture-in-picture has correct foreground and background pixels');

  const keyed = structuredClone(pip);
  keyed.tracks.at(-1)!.clips[0].effects.keys.x = [{ at: 0, value: -0.5 }, { at: 2, value: 0.5 }];
  const keyedFile = await output('position-keys', keyed);
  assert.ok(isBlue(await pixel(await imageAt(keyedFile, 0.1), 40, 90)));
  assert.ok(isRed(await pixel(await imageAt(keyedFile, 2.5), 40, 90)));
  passed('position keyframes visibly move the overlay');
  const opacity = structuredClone(pip);
  opacity.tracks.at(-1)!.clips[0].effects.keys.opacity = [{ at: 0, value: 0 }, { at: 2, value: 1 }];
  const opacityFile = await output('opacity-keys', opacity);
  const blend = await pixel(await imageAt(opacityFile, 1));
  assert.ok(blend[0] > 70 && blend[2] > 70 && blend[1] < 30, String(blend));
  passed('opacity keyframes create a real blended image');

  const dissolve = appendMedia(base, await probe(tools, blue));
  dissolve.tracks[0].clips[0].duration = 2;
  dissolve.tracks[0].clips[1].start = 1; dissolve.tracks[0].clips[1].duration = 2;
  dissolve.tracks[0].clips[1].transition = { type: 'dissolve', duration: 1 };
  const dissolveFile = await output('dissolve', dissolve);
  assert.ok(isRed(await pixel(await imageAt(dissolveFile, 0.5))));
  const midpoint = await pixel(await imageAt(dissolveFile, 1.5));
  assert.ok(midpoint[0] > 70 && midpoint[2] > 70 && midpoint[1] < 30, String(midpoint));
  assert.ok(isBlue(await pixel(await imageAt(dissolveFile, 2.5))));
  const exact = await previews.frame(dissolve, 1.5), exactRgb = await pixel(exact);
  assert.ok(exactRgb.every((channel, i) => Math.abs(channel - midpoint[i]) < 15), `${exactRgb} vs ${midpoint}`);
  passed('overlapping dissolve renders a real blend and agrees with exact preview');

  const frames = await Promise.allSettled([previews.frame(dissolve, 0.2), previews.frame(dissolve, 0.7), previews.frame(dissolve, 2.2)]);
  for (const frame of frames.slice(0, 2)) assert.ok(frame.status === 'rejected' && frame.reason instanceof Cancelled);
  assert.equal(frames[2].status, 'fulfilled');
  assert.equal(await previews.frame(dissolve, 1.5), exact);
  const files = await readdir(store.cache);
  assert.ok(!files.some(file => /^(?:audio-preview|frame)-work-/.test(file)), files.join(','));
  assert.ok((await stat(exact)).size > 100);
  passed('latest-frame cancellation cleans owned workspaces and retains completed cache');

  const lut = path.join(work, 'red blue swap.cube');
  const cube = ['TITLE "Red blue swap"', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube.push(`${b} ${g} ${r}`);
  await writeFile(lut, cube.join('\n') + '\n');
  const graded = structuredClone(base); graded.tracks[0].clips[0].effects.lut = lut;
  const lutFile = await output('lut-color', graded);
  assert.ok(isBlue(await pixel(await imageAt(lutFile, 0.5))));
  assert.ok(isBlue(await pixel(await previews.frame(graded, 0.5))));
  passed('3D LUT changes actual export and exact-preview pixels');
  const desaturated = structuredClone(base); desaturated.tracks[0].clips[0].effects.saturation = 0; desaturated.tracks[0].clips[0].effects.exposure = 0.3;
  const desaturatedFile = await output('color-controls', desaturated), greyRgb = await pixel(await imageAt(desaturatedFile, 0.5));
  assert.ok(Math.max(...greyRgb) - Math.min(...greyRgb) < 15 && greyRgb[0] > 50, String(greyRgb));
  const warm = appendMedia(newProject(), await probe(tools, grey)); warm.tracks[0].clips[0].effects.temperature = 1;
  const warmFile = await output('white-balance', warm), warmRgb = await pixel(await imageAt(warmFile, 0.5));
  assert.ok(warmRgb[0] > warmRgb[2] + 30, String(warmRgb));
  passed('exposure, saturation and white balance visibly affect pixels');
  const cool = structuredClone(warm); cool.tracks[0].clips[0].effects.temperature = -1;
  const coolFile = await output('cool-white-balance', cool), coolRgb = await pixel(await imageAt(coolFile, 0.5));
  assert.ok(coolRgb[2] > coolRgb[0] + 30, String(coolRgb));
  for (const [project, expected] of [[warm, warmRgb], [cool, coolRgb]] as const) {
    const previewRgb = await pixel(await previews.frame(project, 0.5));
    assert.ok(previewRgb.every((channel, i) => Math.abs(channel - expected[i]) < 15), `${previewRgb} vs ${expected}`);
  }
  passed('warm and cool white balance affect midtones and match exact preview');

  const hdrFile = path.join(work, 'pq-hdr.mp4');
  await ffmpeg(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=24:d=1', '-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'pools=2:log-level=error:colorprim=9:transfer=16:colormatrix=9', '-threads', '2', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', hdrFile]);
  const hdr = appendMedia(newProject(), await probe(tools, hdrFile));
  assert.equal(hdr.media[0].video?.colorTransfer, 'smpte2084'); assert.equal(hdr.media[0].video?.colorPrimaries, 'bt2020');
  assert.ok(hdr.media[0].hdr);
  await assert.rejects(queue.enqueue(hdr, { ...defaultExport(hdr, path.join(work, 'unapproved-hdr.mp4')), codec: 'h264', hdr: 'preserve' }), /HDR/);
  const sdrFile = await output('explicit-hdr-to-sdr', hdr, { hdr: 'sdr' }), sdr = await probe(tools, sdrFile);
  assert.equal(sdr.video?.colorTransfer, 'bt709'); assert.equal(sdr.video?.colorPrimaries, 'bt709'); assert.equal(sdr.video?.colorSpace, 'bt709');
  assert.ok(!sdr.hdr && (await pixel(await imageAt(sdrFile, 0.4)))[0] > 70);
  passed('HDR conversion requires explicit selection and outputs decoded BT.709 SDR');

  const service = new MediaService(tools, path.join(work, 'relink-cache'), () => {});
  try {
    const missing = { ...base.media[0], path: path.join(work, 'does-not-exist.mp4') };
    assert.ok((await service.restore([missing]))[0].missing);
    const relinked = await service.relink(missing.id, red);
    assert.equal(relinked.id, missing.id); assert.equal(relinked.path, red); assert.ok(!relinked.missing); assert.equal(relinked.video?.fps, '24/1');
    passed('missing source can be relinked without changing clip asset IDs');
  } finally { await service.shutdown(); }
  assert.deepEqual(await Promise.all(originals.map(async file => createHash('sha256').update(await readFile(file)).digest('hex'))), hashes);
  passed('feature tests leave all source files byte-identical');
} catch (error) { failure = error instanceof Error ? error.stack || error.message : String(error); throw error; }
finally {
  await previews.shutdown(); await queue.shutdown(); await store.close();
  await writeFile(path.join(root, 'feature-results.json'), JSON.stringify({ at: new Date().toISOString(), native: caps.version, directory: work, checks, failure, jobs: queue.jobs }, null, 2));
}
