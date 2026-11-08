import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { locateNative, capabilities } from '../electron/native';
import { probe } from '../electron/media';
import { ExportQueue } from '../electron/exporter';
import { AssetLibrary, DEFAULT_AUDIO, DEFAULT_DATA, ProjectStore } from '../electron/storage';
import { appendMedia, defaultExport, newProject, projectDuration } from '../shared/model';
const downloads = path.join(os.homedir(), 'Downloads');
const first = process.env.FRAMELAB_ACCEPT_FIRST || path.join(downloads, 'source-a.mp4');
const second = process.env.FRAMELAB_ACCEPT_SECOND || path.join(downloads, 'source-b.mp4');
const sourceMusic = process.env.FRAMELAB_ACCEPT_MUSIC || path.join(downloads, 'music.m4a');
const output = process.env.FRAMELAB_ACCEPT_OUT || path.join(downloads, 'FrameLab-acceptance.mp4');
const tools = await locateNative(), caps = await capabilities(tools);
const library = new AssetLibrary(process.env.FRAMELAB_AUDIO_DIR || DEFAULT_AUDIO); await library.init();
const music = await library.add(sourceMusic, 'local', '授权未确认；仅为本地素材，不随程序分发', '用户提供的本地音频文件；公开发布前需自行取得授权。');
const store = new ProjectStore(DEFAULT_DATA); await store.init();
let p = appendMedia(newProject(), await probe(tools, first)); p = appendMedia(p, await probe(tools, second));
assert.equal(p.width, 4096); assert.equal(p.height, 2160); assert.equal(p.fps, '60000/1001'); assert.equal(Math.round(projectDuration(p) * 60000 / 1001), 17484);
assert.ok(p.tracks[0].clips[0].duration > 182 && p.tracks[0].clips[0].duration < 183);
p = appendMedia(p, await probe(tools, music.path), true); p.name = 'Acceptance · 3分02秒在前';
p = await store.save(p, path.join(store.root, 'acceptance.frameproj')); await store.autosave(p);
let last = '', lastAt = 0;
const queue = new ExportQueue(tools, caps, store, event => {
  if (event.type !== 'job') return;
  const j = event.job;
  if (j.phase !== last || Date.now() - lastAt > 2500 || ['completed', 'failed'].includes(j.stage)) {
    console.log(JSON.stringify({ stage: j.stage, phase: j.phase, percent: j.percent?.toFixed(1), speed: j.speed, eta: j.eta && Math.round(j.eta), bytes: j.bytes, encoder: j.encoder, elapsed: j.elapsed, error: j.error })); last = j.phase; lastAt = Date.now();
  }
});
const job = await queue.enqueue(p, defaultExport(p, output)); await queue.idle();
const done = queue.jobs.find(j => j.id === job.id)!;
await mkdir('test-artifacts', { recursive: true });
await writeFile('test-artifacts/acceptance-results.json', JSON.stringify({ at: new Date().toISOString(), project: p.path, job: done }, null, 2));
assert.equal(done.stage, 'completed', done.error); assert.ok(done.validation!.passed); assert.equal(done.validation!.frames, 17484); assert.ok(done.bytes < 1000000000); assert.equal(done.validation!.fps, '60000/1001'); assert.ok(done.validation!.decoded);
await queue.shutdown(); await store.close(); console.log(`PASS acceptance export: ${output}, ${done.bytes} bytes, ${done.validation!.frames} frames`);
