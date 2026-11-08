import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BackendEvent, Project } from '../shared/types';
import { defaultExport, evaluateKeys, fpsValue, projectDuration } from '../shared/model';
import { validateProject } from '../shared/schema';
import type { NativeTools } from './native';
import { audioInputs, prepareAudio } from './audio';
import { buildVideoGraph, type VideoInput } from './graph';
import { makeAss } from '../shared/subtitles';
import { Cancelled, ffmpeg } from './runner';
type Lane = 'audio' | 'frame' | 'speech';
interface PreviewTask { signature: string; controller: AbortController; promise: Promise<unknown> }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export class PreviewService {
  private tasks = new Map<Lane, PreviewTask>();
  private closing = false;
  constructor(readonly tools: NativeTools, readonly cache: string, readonly emit: (event: BackendEvent) => void) {}
  private latest<T>(lane: Lane, signature: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Cancelled());
    const previous = this.tasks.get(lane);
    if (previous?.signature === signature && !previous.controller.signal.aborted) return previous.promise as Promise<T>;
    previous?.controller.abort();
    const controller = new AbortController();
    // Wait for the previous process and its cleanup before starting this lane again.
    const promise = (previous?.promise || Promise.resolve()).catch(() => {}).then(async () => {
      if (controller.signal.aborted) throw new Cancelled();
      const result = await action(controller.signal);
      if (controller.signal.aborted) throw new Cancelled();
      return result;
    });
    const task = { signature, controller, promise };
    this.tasks.set(lane, task);
    const finished = () => { if (this.tasks.get(lane) === task) this.tasks.delete(lane); };
    void promise.then(finished, finished);
    return promise;
  }
  private async workspace<T>(kind: string, action: (work: string) => Promise<T>): Promise<T> {
    const root = path.resolve(this.cache);
    await mkdir(root, { recursive: true });
    const work = await mkdtemp(path.join(root, `${kind}-work-`)), id = path.basename(work);
    await writeFile(path.join(work, 'owner.json'), JSON.stringify({ tool: 'FrameLab', id }));
    try { return await action(work); }
    finally {
      try {
        const owner = JSON.parse(await readFile(path.join(work, 'owner.json'), 'utf8'));
        if (path.dirname(work) === root && owner.tool === 'FrameLab' && owner.id === id) await rm(work, { recursive: true, force: true });
      } catch (error) { this.emit({ type: 'status', text: `预览临时目录清理失败：${String(error).slice(-300)}` }); }
    }
  }
  async soundtrack(value: Project, lane: 'audio' | 'speech' = 'audio'): Promise<string | null> {
    const project = validateProject(value);
    const signature = hash({ version: 2, duration: projectDuration(project), inputs: audioInputs(project).map(({ clip: c, media: m }) => ({
      source: [m.id, m.path, m.size, m.modified, m.audio!.index],
      timing: [c.start, c.duration, c.sourceStart, c.rate, c.reverse, c.loop, c.crossfade, c.trimSilence],
      effects: [c.effects.volumeDb, c.effects.fadeIn, c.effects.fadeOut, c.effects.denoise, c.effects.keys.volumeDb],
    })) });
    return this.latest(lane, signature, async signal => {
      const output = path.join(this.cache, `mix-${signature}.wav`);
      try { await access(output); return output; } catch { /* Generate a bounded native soundtrack. */ }
      return this.workspace('audio-preview', async work => {
        const prepared = await prepareAudio(project, { tools: this.tools, work, settings: defaultExport(project, ''), signal,
          log: () => {}, phase: text => this.emit({ type: 'status', text: `音频预览：${text}` }), progress: (p, duration) => this.emit({ type: 'status', text: `音频预览 ${Math.min(100, p.seconds * 100 / duration).toFixed(1)}%` }) });
        if (signal.aborted) throw new Cancelled();
        if (prepared) await rename(prepared, output);
        return prepared ? output : null;
      });
    });
  }
  async frame(value: Project, time: number): Promise<string> {
    const p = validateProject(structuredClone(value));
    if (!Number.isFinite(time) || time < 0 || time > projectDuration(p)) throw new Error('预览位置无效');
    const signature = hash({ version: 2, time, width: p.width, height: p.height, fps: p.fps, style: p.subtitleStyle,
      tracks: p.tracks.filter(t => t.kind !== 'audio').map(t => [t.hidden, t.clips]), files: p.media.map(m => [m.id, m.path, m.modified]) });
    return this.latest('frame', signature, async signal => {
      const cached = path.join(this.cache, `frame-${signature}.jpg`);
      try { await access(cached); return cached; } catch { /* Render from the originals into an owned workspace. */ }
      return this.workspace('frame', async work => {
        const inputs: VideoInput[] = [], args: string[] = ['-y', '-filter_complex_threads', '2'];
        const step = 1 / fpsValue(p.fps);
        for (const track of p.tracks) {
          track.clips = track.hidden ? [] : track.clips.filter(c => c.start <= time && time < c.start + c.duration);
          for (const clip of track.clips) {
            const local = time - clip.start;
            if (track.kind === 'subtitle') { clip.start = 0; clip.duration = step; continue; }
            if (track.kind !== 'video') continue;
            const m = p.media.find(m => m.id === clip.assetId);
            if (!m?.video || m.missing) throw new Error(`预览素材缺失：${clip.name}`);
            const sourceTime = clip.freeze ?? (clip.sourceStart + (clip.reverse ? Math.max(0, clip.duration - local - step) : local) * clip.rate);
            args.push('-threads', '2', '-noautorotate');
            if (m.kind === 'image') args.push('-loop', '1', '-framerate', p.fps); else args.push('-ss', String(Math.max(0, Math.min(sourceTime, m.duration - step))));
            args.push('-i', m.path);
            for (const key of ['x', 'y', 'scale', 'opacity', 'volumeDb'] as const) clip.effects[key] = evaluateKeys(clip.effects.keys[key], local, clip.effects[key]);
            if (clip.transition.type === 'dissolve' && clip.transition.duration) clip.effects.opacity *= Math.min(1, local / clip.transition.duration);
            clip.effects.keys = {}; clip.transition = { type: 'none', duration: 0 }; clip.start = 0; clip.duration = step; clip.sourceStart = 0; clip.freeze = m.kind === 'image' ? null : 0; clip.rate = 1; clip.reverse = false;
            const input: VideoInput = { clip, media: m, path: m.path };
            if (clip.effects.lut) {
              if (!/\.(cube|3dl)$/i.test(clip.effects.lut) || (await stat(clip.effects.lut)).size > 32_000_000) throw new Error('LUT 必须为不超过 32 MB 的 .cube 或 .3dl 文件');
              input.lutFile = `lut-${inputs.length}${path.extname(clip.effects.lut).toLowerCase()}`;
              await copyFile(clip.effects.lut, path.join(work, input.lutFile));
            }
            inputs.push(input);
          }
        }
        let ass: string | undefined;
        if (p.tracks.some(t => t.kind === 'subtitle' && t.clips.length)) { ass = 'subtitles.ass'; await writeFile(path.join(work, ass), makeAss(p)); }
        const ratio = Math.min(1, 1280 / p.width, 720 / p.height);
        const settings = { ...defaultExport(p, ''), width: Math.max(2, Math.floor(p.width * ratio / 2) * 2), height: Math.max(2, Math.floor(p.height * ratio / 2) * 2), hdr: 'sdr' as const };
        if (ass) await writeFile(path.join(work, ass), makeAss({ ...p, width: settings.width, height: settings.height, subtitleStyle: { ...p.subtitleStyle, size: p.subtitleStyle.size * ratio } }));
        const graph = buildVideoGraph(p, settings, inputs, ass);
        const output = path.join(work, 'preview.jpg');
        await ffmpeg(this.tools.ffmpeg, [...args, '-filter_complex', graph.graph, '-map', graph.output, '-frames:v', '1', '-q:v', '2', output], { cwd: work, signal });
        if (signal.aborted) throw new Cancelled();
        await rename(output, cached);
        return cached;
      });
    });
  }
  async cancel(lane: 'audio' | 'frame') { const task = this.tasks.get(lane); task?.controller.abort(); await task?.promise.catch(() => {}); }
  async shutdown() {
    this.closing = true;
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map(task => task.promise));
  }
}
