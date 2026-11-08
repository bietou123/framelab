import { access, copyFile, link, mkdir, readFile, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { BackendEvent, Capabilities, Encoder, ExportSettings, Job, Project } from '../shared/types';
import { fpsValue, projectDuration } from '../shared/model';
import { bitrateBudget } from '../shared/budget';
import { validateProject, validateSettings } from '../shared/schema';
import { makeAss } from '../shared/subtitles';
import type { NativeTools } from './native';
import { probe } from './media';
import { audioInputs, concatEscape, prepareAudio } from './audio';
import { buildVideoGraph, copyCompatibility, f, type VideoInput } from './graph';
import { Cancelled, ffmpeg, type Progress } from './runner';
import { validateOutput } from './validation';
import { outputVideoColor, visibleVideoMedia } from './color';
import { atomicJson, type ProjectStore } from './storage';
interface Plan { project: Project; settings: ExportSettings }
export interface QueueOptions { freeBytes?: (directory: string) => Promise<number | null> }
export function encodingOptions(encoder: string, settings: ExportSettings, kbps: number, pass?: number): string[] {
  const speed = settings.preset;
  const bitrate = ['-b:v', `${kbps}k`, '-maxrate', `${Math.ceil(kbps * 1.01)}k`, '-bufsize', `${kbps * 2}k`];
  if (encoder.endsWith('_nvenc')) return ['-c:v', encoder, '-preset', { fast: 'p1', balanced: 'p5', quality: 'p7' }[speed], '-tune', 'hq', '-rc', 'vbr', ...bitrate,
    '-multipass', speed === 'fast' ? 'disabled' : 'fullres', '-rc-lookahead', speed === 'fast' ? '0' : '32', '-spatial-aq', '1', '-temporal-aq', '1', '-aq-strength', '8', '-bf', '3', '-b_ref_mode', 'middle'];
  if (encoder.endsWith('_qsv')) return ['-c:v', encoder, '-preset', { fast: 'veryfast', balanced: 'medium', quality: 'veryslow' }[speed], ...bitrate];
  if (encoder.endsWith('_amf')) return ['-c:v', encoder, '-quality', { fast: 'speed', balanced: 'balanced', quality: 'quality' }[speed], '-rc', 'vbr_peak', ...bitrate];
  if (encoder === 'libx264') return ['-c:v', encoder, '-preset', { fast: 'veryfast', balanced: 'medium', quality: 'slow' }[speed], ...bitrate, ...(pass ? ['-pass', String(pass), '-passlogfile', 'video-pass'] : [])];
  if (encoder === 'libx265') return ['-c:v', encoder, '-preset', { fast: 'veryfast', balanced: 'medium', quality: 'slow' }[speed], ...bitrate, '-x265-params', `pools=${settings.threads}:frame-threads=2:log-level=error${pass ? `:pass=${pass}:stats=video-pass.log` : ''}`];
  return ['-c:v', encoder, '-preset', speed === 'quality' ? '5' : speed === 'balanced' ? '8' : '11', '-b:v', `${kbps}k`];
}
export class ExportQueue {
  readonly jobs: Job[] = [];
  private plans = new Map<string, Plan>();
  private controller?: AbortController;
  private activeId?: string;
  private running = false;
  private persistence: Promise<void> = Promise.resolve();
  private saveTimer?: NodeJS.Timeout;
  constructor(readonly tools: NativeTools, readonly caps: Capabilities, readonly store: ProjectStore, readonly emit: (event: BackendEvent) => void, readonly options: QueueOptions = {}) {}
  async init() {
    try {
      const stored = JSON.parse(await readFile(path.join(this.store.root, 'queue.json'), 'utf8')) as Job[];
      for (const job of stored.slice(-40)) {
        const plan = JSON.parse(await readFile(path.join(this.store.root, `plan-${job.id}.json`), 'utf8')) as Plan;
        this.plans.set(job.id, plan);
        if (!['completed', 'failed', 'cancelled'].includes(job.stage)) { job.stage = 'failed'; job.error = '应用退出时导出未完成，可从头重试；不支持断点续导'; job.phase = '导出被中断'; job.percent = null; }
        this.jobs.push(job);
      }
    } catch { /* An empty queue is valid on first launch. */ }
  }
  private publish(job: Job) {
    if (job.startedAt && !job.finishedAt) job.elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
    this.emit({ type: 'job', job: structuredClone(job) });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.persist(); }, 800);
  }
  private persist() {
    this.persistence = this.persistence.then(() => atomicJson(path.join(this.store.root, 'queue.json'), this.jobs.slice(-40))).catch(error => this.emit({ type: 'status', text: `队列记录保存失败：${String(error)}` }));
  }
  async enqueue(projectValue: Project, settingsValue: ExportSettings): Promise<Job> {
    let project = validateProject(structuredClone(projectValue));
    const settings = validateSettings(settingsValue);
    settings.path = path.resolve(settings.path);
    if (path.extname(settings.path).toLowerCase() !== '.mp4') throw new Error('当前导出容器为 MP4');
    await this.protectOutput(settings.path, project);
    if (this.jobs.some(j => j.output.toLowerCase() === settings.path.toLowerCase() && !['failed', 'cancelled', 'completed'].includes(j.stage))) throw new Error('同一路径已经有排队任务');
    const ids = new Set(project.tracks.filter(t => !t.hidden).flatMap(t => t.clips.map(c => c.assetId)).filter(Boolean));
    for (let i = 0; i < project.media.length; i++) if (ids.has(project.media[i].id)) {
      const old = project.media[i], current = await probe(this.tools, old.path);
      current.id = old.id; project.media[i] = current;
    }
    if (!project.tracks.some(t => t.kind === 'video' && !t.hidden && t.clips.length)) throw new Error('至少需要一个视频或图片片段');
    for (const t of project.tracks) for (const c of t.clips) {
      if (t.kind !== 'video' || t.hidden) continue;
      const m = project.media.find(m => m.id === c.assetId)!;
      if (!m.video) throw new Error(`视频轨素材没有画面：${c.name}`);
      if (m.kind === 'video' && c.freeze === null && c.sourceStart + c.duration * c.rate > m.duration + 1 / fpsValue(m.video.fps || project.fps)) throw new Error(`片段超出源素材时长：${c.name}`);
      if (c.freeze !== null && c.freeze >= m.duration) throw new Error(`定格位置超过素材时长：${c.name}`);
    }
    if (settings.codec === 'copy') {
      const check = copyCompatibility(project, settings);
      if (!check.compatible) throw new Error(check.reasons.join('\n'));
      if (settings.maxBytes && check.estimatedVideoBytes >= settings.maxBytes) throw new Error(`无损拼接预计视频已超过 ${(check.estimatedVideoBytes / 1e9).toFixed(2)} GB，限体积导出必须重编码`);
    } else if (visibleVideoMedia(project).some(m => m.hdr) && settings.hdr !== 'sdr') throw new Error('当前 HDR 重编码未验证完整元数据保留；请选择兼容的无损拼接，或明确勾选 HDR 转 SDR');
    const job: Job = { id: crypto.randomUUID(), projectName: project.name, output: settings.path, stage: 'queued', phase: '等待队列', percent: null,
      mediaSeconds: 0, speed: 0, eta: null, bytes: 0, createdAt: new Date().toISOString(), elapsed: 0, log: [], settings };
    const plan = { project, settings };
    this.jobs.push(job); this.plans.set(job.id, plan);
    await atomicJson(path.join(this.store.root, `plan-${job.id}.json`), plan);
    this.publish(job); this.persist(); void this.pump(); return structuredClone(job);
  }
  private async protectOutput(filename: string, p: Project) {
    if (p.media.some(m => path.resolve(m.path).toLowerCase() === filename.toLowerCase())) throw new Error('不能覆盖原始素材');
    try { await access(filename); throw new Error('输出文件已存在，请选择新文件名'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await access(path.dirname(filename));
  }
  async cancel(id: string) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.stage)) return;
    if (this.activeId === id) { job.phase = '正在取消并清理临时输出'; this.publish(job); this.controller?.abort(); }
    else { job.stage = 'cancelled'; job.phase = '已取消'; job.finishedAt = new Date().toISOString(); job.percent = null; this.publish(job); }
  }
  async retry(id: string, smaller = false): Promise<Job> {
    const plan = this.plans.get(id), previous = this.jobs.find(j => j.id === id);
    if (!plan || !previous || !['failed', 'cancelled', 'completed'].includes(previous.stage)) throw new Error('任务尚未结束，不能重试');
    const settings = structuredClone(plan.settings);
    if (smaller) { if (settings.codec === 'copy') settings.codec = 'hevc'; settings.videoKbps = Math.floor((previous.budget?.videoKbps || settings.videoKbps || 16000) * 0.94); }
    try { await access(settings.path); settings.path = settings.path.replace(/\.mp4$/i, `-${Date.now()}.mp4`); } catch { /* Reuse the requested name only if no artifact exists. */ }
    return this.enqueue(plan.project, settings);
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    while (true) {
      const job = this.jobs.find(j => j.stage === 'queued');
      if (!job) break;
      this.activeId = job.id; this.controller = new AbortController();
      await this.execute(job, this.plans.get(job.id)!, this.controller.signal);
      this.activeId = undefined; this.controller = undefined;
    }
    this.running = false; this.persist();
  }
  private async execute(job: Job, plan: Plan, signal: AbortSignal) {
    const { project: p, settings: s } = plan;
    const work = path.resolve(this.store.exports, job.id), temp = path.join(path.dirname(s.path), `.framelab-${job.id}.partial.mp4`);
    let stream: WriteStream | undefined;
    job.startedAt = new Date().toISOString();
    const log = (text: string) => { job.log.push(text); if (job.log.length > 150) job.log.shift(); stream?.write(`${new Date().toISOString()} ${text}\n`); };
    const phase = (stage: Job['stage'], text: string, percent: number | null = null) => { job.stage = stage; job.phase = text; job.percent = percent; job.mediaSeconds = 0; job.speed = 0; job.eta = null; this.publish(job); log(text); };
    const progress = (value: Progress, duration: number) => {
      job.mediaSeconds = value.seconds; job.speed = value.speed; job.percent = Math.min(100, value.seconds * 100 / duration);
      job.bytes = value.bytes || job.bytes; job.eta = value.speed > 0 ? Math.max(0, duration - value.seconds) / value.speed : null;
      this.publish(job);
    };
    try {
      phase('preparing', '检查素材、目标体积和磁盘空间');
      await this.protectOutput(s.path, p);
      await mkdir(work, { recursive: true });
      await writeFile(path.join(work, 'owner.json'), JSON.stringify({ tool: 'FrameLab', id: job.id }));
      job.logPath = path.join(this.store.logs, `${job.id}.log`);
      stream = createWriteStream(job.logPath, { flags: 'a' }); stream.on('error', error => { job.log.push(`日志写入失败：${error.message}`); });
      const duration = projectDuration(p), hasAudio = audioInputs(p).length > 0;
      job.budget = bitrateBudget(duration, s.maxBytes, hasAudio ? s.audioKbps : 0, s.videoKbps);
      log(`时长 ${f(duration)} 秒；码率预算 ${job.budget.videoKbps} kbps；目标 ${s.maxBytes ?? '不限'} 字节；非无损重编码 ${s.codec !== 'copy'}`);
      const copiedSize = s.codec === 'copy' ? copyCompatibility(p, s).estimatedVideoBytes : 0;
      const reserve = Math.max(copiedSize, job.budget.estimatedBytes) * 2.15 + (hasAudio ? duration * 192000 * 4 : 0) + 128_000_000;
      for (const directory of [...new Set([path.dirname(s.path), work])]) {
        let free: number | null = null;
        try { if (this.options.freeBytes) free = await this.options.freeBytes(directory); else { const disk = await statfs(directory); free = disk.bavail * disk.bsize; } }
        catch { log(`无法读取 ${directory} 的剩余空间，仍会捕获真实磁盘写入错误`); }
        if (free !== null && free < reserve) throw new Error(`磁盘空间不足：需要约 ${(reserve / 1e9).toFixed(2)} GB，可用 ${(free / 1e9).toFixed(2)} GB`);
      }
      const audio = await prepareAudio(p, { tools: this.tools, work, settings: s, signal, log, phase: text => phase('preparing', text), progress });
      const video = path.join(work, 'video.mp4');
      if (s.codec === 'copy') {
        phase('encoding', '直接无损拼接视频流'); job.encoder = 'copy';
        const clips = p.tracks.find(t => t.kind === 'video' && !t.hidden && t.clips.length)!.clips;
        const list = path.join(work, 'video.ffconcat');
        await writeFile(list, ['ffconcat version 1.0', ...[...clips].sort((a, b) => a.start - b.start).map(c => `file '${concatEscape(p.media.find(m => m.id === c.assetId)!.path)}'`)].join('\n') + '\n');
        const firstVideo = p.media.find(m => m.id === [...clips].sort((a, b) => a.start - b.start)[0].assetId)!.video!;
        await ffmpeg(this.tools.ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', `0:${firstVideo.index}`, '-an', '-sn', '-dn', '-c:v', 'copy', '-map_metadata', '-1', '-t', f(duration), video], { signal, cwd: work, onLine: log, onProgress: value => progress(value, duration) });
      } else {
        const inputs: VideoInput[] = [];
        for (const track of p.tracks.filter(t => t.kind === 'video' && !t.hidden)) for (const c of [...track.clips].sort((a, b) => a.start - b.start)) {
          const media = p.media.find(m => m.id === c.assetId)!;
          const input: VideoInput = { clip: c, media, path: media.path };
          if (c.reverse && media.kind === 'video' && c.freeze === null) {
            input.path = await this.reverse(input, work, signal, log, (text, percent) => phase('preparing', text, percent)); input.reversed = true;
          }
          if (c.effects.lut) {
            if (!/\.(cube|3dl)$/i.test(c.effects.lut)) throw new Error('LUT 仅支持 .cube 和 .3dl');
            if ((await stat(c.effects.lut)).size > 32_000_000) throw new Error('LUT 超过 32 MB 资源限制');
            input.lutFile = `lut-${inputs.length}${path.extname(c.effects.lut).toLowerCase()}`; await copyFile(c.effects.lut, path.join(work, input.lutFile));
          }
          inputs.push(input);
        }
        let subtitles: string | undefined;
        if (p.tracks.some(t => t.kind === 'subtitle' && !t.hidden && t.clips.length)) { subtitles = 'subtitles.ass'; await writeFile(path.join(work, subtitles), makeAss({ ...p, width: s.width, height: s.height }), 'utf8'); }
        const graph = buildVideoGraph(p, s, inputs, subtitles);
        const graphFile = path.join(work, 'video-graph.txt'); await writeFile(graphFile, graph.graph);
        const encoder = this.chooseEncoder(s);
        const software = this.caps.encoders.find(e => e.codec === s.codec && !e.hardware && e.available);
        const encode = async (selected: Encoder, decode: 'software' | 'auto') => {
          job.encoder = selected.name;
          const args: string[] = ['-y', '-filter_complex_threads', String(Math.min(s.threads, 4))];
          for (const input of inputs) {
            args.push('-threads', String(s.threads), '-noautorotate');
            if (decode === 'auto' && input.media.kind === 'video') args.push('-hwaccel', 'auto');
            if (input.media.kind === 'image') args.push('-loop', '1', '-framerate', s.fps);
            args.push('-i', input.path);
          }
          args.push('-/filter_complex', graphFile, '-map', graph.output, '-an', '-sn', '-dn', '-map_metadata', '-1', '-threads', String(s.threads), '-r', s.fps, '-fps_mode', 'cfr', '-t', f(duration), '-pix_fmt', 'yuv420p');
          const color = outputVideoColor(p, s);
          for (const [key, flag] of [['colorPrimaries', '-color_primaries'], ['colorTransfer', '-color_trc'], ['colorSpace', '-colorspace'], ['colorRange', '-color_range']] as const) {
            const value = color[key];
            if (value && value !== 'unknown') args.push(flag, value);
          }
          if (s.codec === 'hevc') args.push('-tag:v', 'hvc1');
          const twoPass = !selected.hardware && s.maxBytes !== null && ['libx264', 'libx265'].includes(selected.name);
          for (const pass of twoPass ? [1, 2] : [0]) {
            phase('encoding', `${selected.name} ${twoPass ? `第 ${pass}/2 遍编码` : '编码'}${decode === 'auto' ? ' · 自动解码' : ' · 软件解码'}`, 0);
            const output = twoPass && pass === 1 ? ['-f', 'null', '-'] : [video];
            await ffmpeg(this.tools.ffmpeg, [...args, ...encodingOptions(selected.name, s, job.budget!.videoKbps, pass || undefined), ...output], { signal, cwd: work, onLine: log, onProgress: value => progress(value, duration) });
          }
        };
        try { await encode(encoder, s.decode); }
        catch (error) {
          if (signal.aborted) throw error;
          if (s.decode === 'auto') {
            log(`自动解码失败，独立回退软件解码：${String(error).slice(-1200)}`);
            try { await encode(encoder, 'software'); }
            catch (second) { if (signal.aborted || !encoder.hardware || !software) throw second; log(`硬件编码失败，软件编码回退：${String(second).slice(-1200)}`); await encode(software, 'software'); }
          } else if (encoder.hardware && software) { log(`硬件编码失败，软件编码回退：${String(error).slice(-1200)}`); await encode(software, 'software'); }
          else throw error;
        }
      }
      phase('packaging', '封装 MP4 · faststart · 只保留视频和所需音频');
      await ffmpeg(this.tools.ffmpeg, ['-y', '-i', video, ...(audio ? ['-i', audio] : []), '-map', '0:v:0', ...(audio ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', `${s.audioKbps}k`, '-ar', String(s.audioSampleRate)] : ['-an']), '-c:v', 'copy', '-sn', '-dn', '-map_metadata', '-1', ...(s.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-t', f(duration), '-movflags', '+faststart', temp], { signal, cwd: work, onLine: log, onProgress: value => progress(value, duration) });
      job.bytes = (await stat(temp)).size;
      phase('verifying', '检查体积、规格、时间戳与音轨');
      job.validation = await validateOutput(temp, p, s, { tools: this.tools, signal, hasAudio: Boolean(audio), hardwareDecode: this.caps.encoders.some(e => e.vendor === 'NVIDIA' && e.available), log,
        phase: text => phase('verifying', text), progress });
      this.publish(job);
      if (!job.validation.passed) throw new Error(job.validation.issues.join('\n') + '\n可使用降低 6% 码率重试；原始素材保持不变');
      if (signal.aborted) throw new Cancelled();
      await this.protectOutput(s.path, p);
      await link(temp, s.path); await unlink(temp);
      job.stage = 'completed'; job.phase = s.verifyDecode ? '导出和完整校验完成' : '导出完成 · 未做完整解码'; job.percent = 100; job.bytes = job.validation.size;
      log(`已验证并提交成品：${s.path}；${job.bytes} 字节；${job.validation.frames} 帧`);
    } catch (error) {
      job.stage = signal.aborted || error instanceof Cancelled ? 'cancelled' : 'failed';
      job.phase = job.stage === 'cancelled' ? '已取消，原素材未修改' : '导出失败'; job.error = job.stage === 'failed' ? String(error) : undefined; job.percent = null;
      log(`${job.phase}：${String(error)}`);
    } finally {
      job.finishedAt = new Date().toISOString(); job.elapsed = (Date.now() - Date.parse(job.startedAt!)) / 1000;
      if (stream) await new Promise<void>(resolve => stream!.end(resolve));
      try { await unlink(temp); } catch { /* Only this job's owned temporary file is addressed. */ }
      try {
        const owner = JSON.parse(await readFile(path.join(work, 'owner.json'), 'utf8'));
        const parent = path.resolve(this.store.exports) + path.sep;
        if (work.startsWith(parent) && owner.tool === 'FrameLab' && owner.id === job.id) await rm(work, { recursive: true, force: true });
      } catch (error) { job.log.push(`临时目录清理信息：${String(error).slice(-500)}`); }
      this.publish(job); this.persist();
    }
  }
  private chooseEncoder(s: ExportSettings): Encoder {
    const list = this.caps.encoders.filter(e => e.available && e.codec === s.codec);
    const choice = s.encoder === 'auto' ? list.find(e => e.hardware) || list.find(e => !e.hardware) : s.encoder === 'software' ? list.find(e => !e.hardware) : list.find(e => e.name === s.encoder);
    if (!choice) throw new Error(`当前设备没有可用的 ${s.codec} 编码器`);
    return choice;
  }
  private async reverse(input: VideoInput, work: string, signal: AbortSignal, log: (text: string) => void, phase: (text: string, percent: number) => void): Promise<string> {
    const fps = fpsValue(input.media.video!.fps || '30/1'), totalFrames = Math.round(input.clip.duration * input.clip.rate * fps), startFrame = Math.round(input.clip.sourceStart * fps);
    const chunks = Math.ceil(totalFrames / 16), files: string[] = [];
    for (let i = 0; i < chunks; i++) {
      const end = totalFrames - i * 16, count = Math.min(16, end), begin = startFrame + end - count;
      phase(`有界倒放：${input.clip.name} · ${i + 1}/${chunks}`, i * 100 / chunks);
      const piece = path.join(work, `reverse-${input.clip.id}-${i}.mkv`);
      await ffmpeg(this.tools.ffmpeg, ['-y', '-threads', '2', '-ss', f(begin / fps), '-noautorotate', '-i', input.media.path, '-map', `0:${input.media.video!.index}`, '-vf', `trim=end_frame=${count},setpts=PTS-STARTPTS,reverse,setpts=N/(${fps}*TB)`, '-frames:v', String(count), '-an', '-sn', '-dn', '-c:v', 'ffv1', '-level', '3', '-g', '1', '-threads', '2', piece], { signal, onLine: log });
      files.push(piece);
    }
    const list = path.join(work, `reverse-${input.clip.id}.ffconcat`), output = path.join(work, `reverse-${input.clip.id}.mkv`);
    await writeFile(list, ['ffconcat version 1.0', ...files.map(file => `file '${concatEscape(file)}'`)].join('\n') + '\n');
    await ffmpeg(this.tools.ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-c:v', 'copy', output], { signal, onLine: log });
    return output;
  }
  async idle(): Promise<void> { while (this.running || this.jobs.some(j => j.stage === 'queued')) await new Promise(r => setTimeout(r, 100)); await this.persistence; }
  async shutdown() { if (this.controller) this.controller.abort(); await this.idle(); if (this.saveTimer) clearTimeout(this.saveTimer); this.persist(); await this.persistence; }
}
