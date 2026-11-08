import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { locateNative, capabilities } from '../electron/native';
import { ffmpeg } from '../electron/runner';
import { probe } from '../electron/media';
import { ExportQueue } from '../electron/exporter';
import { ProjectStore } from '../electron/storage';
import { appendMedia, defaultExport, newProject, projectDuration } from '../shared/model';
import type { ExportSettings, Job, Project } from '../shared/types';
import { parseSrt } from '../shared/subtitles';
const root = path.resolve('test-artifacts'); await mkdir(root, { recursive: true });
const work = await mkdtemp(path.join(root, 'native-'));
const tools = await locateNative(), caps = await capabilities(tools);
const first = path.join(work, '片段 1 [原片].mp4'), second = path.join(work, "clip's two.mp4"), portrait = path.join(work, 'portrait.mp4'), music = path.join(work, '配乐.wav');
for (const [file, frames, size, fps] of [[first, '72', '320x180', '60000/1001'], [second, '48', '320x180', '60000/1001'], [portrait, '36', '180x320', '24/1']] as const) {
  await ffmpeg(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}`, '-frames:v', frames, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', file]);
}
await ffmpeg(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.7', '-af', 'adelay=200:all=1,apad=pad_dur=0.2', '-ac', '2', '-c:a', 'pcm_s16le', music]);
const original = await readFile(first);
const store = new ProjectStore(path.join(work, 'profile')); await store.init();
const queue = new ExportQueue(tools, caps, store, event => { if (event.type === 'job' && event.job.stage === 'failed') console.error(event.job.error); });
let p = appendMedia(newProject(), await probe(tools, first)); p = appendMedia(p, await probe(tools, second));
async function runProject(name: string, project: Project, patch: Partial<ExportSettings> = {}) {
  const s = { ...defaultExport(project, path.join(work, `${name}.mp4`)), maxBytes: 4000000, codec: 'h264' as const, preset: 'fast' as const, ...patch };
  const job = await queue.enqueue(project, s); await queue.idle(); const done = queue.jobs.find(j => j.id === job.id)!;
  assert.equal(done.stage, 'completed', done.error); assert.ok(done.validation?.passed); console.log(`PASS ${name}: ${done.validation!.frames} frames, ${done.bytes} bytes`); return done;
}
await runProject('silent splice', p);
const mus = appendMedia(p, await probe(tools, music), true); mus.tracks.find(t => t.kind === 'audio')!.clips[0].crossfade = 0.15;
const soundtrack = await runProject('finite full soundtrack', mus);
assert.ok(soundtrack.validation!.audioEnd >= projectDuration(mus) - 0.04);
await runProject('copy-only replace music', mus, { codec: 'copy', maxBytes: null });
await runProject('software two-pass', p, { encoder: 'software' });
const edited = structuredClone(mus); edited.tracks[0].clips[0].effects.rotation = 90; edited.tracks[0].clips[0].effects.scale = 0.7; edited.tracks[0].clips[0].effects.opacity = 0.8; edited.tracks[0].clips[0].effects.keys.x = [{ at: 0, value: -0.2 }, { at: 1, value: 0.2 }]; edited.tracks[2].clips = parseSrt('1\n00:00:00,100 --> 00:00:01,000\n本地字幕测试');
await runProject('transform keys subtitles', edited);
const mixed = appendMedia(p, await probe(tools, portrait)); await runProject('different fps and portrait', mixed);
const reversed = structuredClone(p); reversed.tracks[0].clips = [reversed.tracks[0].clips[1]]; reversed.tracks[0].clips[0].start = 0; reversed.tracks[0].clips[0].reverse = true; await runProject('bounded reverse', reversed);
const frozen = structuredClone(p); frozen.tracks[0].clips = [frozen.tracks[0].clips[0]]; frozen.tracks[0].clips[0].freeze = 0.4; frozen.tracks[0].clips[0].duration = 1; await runProject('freeze frame', frozen);
const broken = path.join(work, 'broken.mp4'); await writeFile(broken, 'not a media file'); await assert.rejects(probe(tools, broken)); console.log('PASS corrupted media rejected');
await assert.rejects(queue.enqueue(p, defaultExport(p, first)), /原始|已存在/); console.log('PASS original overwrite rejected');
const low = new ExportQueue(tools, caps, store, () => {}, { freeBytes: async () => 1 }); const lowJob = await low.enqueue(p, defaultExport(p, path.join(work, 'low disk.mp4'))); await low.idle(); assert.equal(low.jobs.find(j => j.id === lowJob.id)!.stage, 'failed'); assert.match(low.jobs[0].error!, /磁盘空间不足/); console.log('PASS insufficient disk space');
const long = structuredClone(p); long.tracks[0].clips[0].freeze = 0.3; long.tracks[0].clips[0].duration = 120; long.tracks[0].clips = [long.tracks[0].clips[0]];
const cancelled = await queue.enqueue(long, { ...defaultExport(long, path.join(work, 'cancelled.mp4')), codec: 'h264', encoder: 'software', maxBytes: null });
await new Promise(r => setTimeout(r, 250)); await queue.cancel(cancelled.id); await queue.idle(); assert.equal(queue.jobs.find(j => j.id === cancelled.id)!.stage, 'cancelled'); await assert.rejects(stat(cancelled.output)); console.log('PASS cancel without partial final output');
assert.deepEqual(await readFile(first), original); console.log('PASS originals remain byte-identical');
await writeFile(path.join(root, 'integration-results.json'), JSON.stringify({ at: new Date().toISOString(), native: caps.version, directory: work, jobs: queue.jobs, checks: ['silent', 'finite music', 'copy music', 'software 2-pass', 'transforms', 'subtitles', 'mixed fps', 'portrait', 'reverse', 'freeze', 'corrupted', 'disk full', 'cancel', 'read-only sources'] }, null, 2));
await queue.shutdown(); await store.close();
