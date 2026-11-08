import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { run, ffmpeg, Cancelled } from './runner';
import type { NativeTools } from './native';
import type { BackendEvent, Media, MediaStream, Rational } from '../shared/types';
import { fpsValue } from '../shared/model';
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const number = (value: unknown): number | undefined => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : undefined; };
export function normalizeStream(s: Record<string, any>): MediaStream {
  const rotation = s.side_data_list?.find((d: Record<string, unknown>) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate;
  return { index: s.index, type: s.codec_type, codec: s.codec_name || 'unknown', profile: s.profile,
    width: s.width, height: s.height, fps: fpsValue(s.avg_frame_rate || '0/1') ? s.avg_frame_rate as Rational : s.r_frame_rate,
    timeBase: s.time_base, pixFmt: s.pix_fmt, duration: number(s.duration), frames: number(s.nb_frames) || number(s.nb_read_frames),
    bitRate: number(s.bit_rate), sampleRate: number(s.sample_rate), channels: s.channels, channelLayout: s.channel_layout,
    colorSpace: s.color_space, colorTransfer: s.color_transfer, colorPrimaries: s.color_primaries, colorRange: s.color_range,
    extradataHash: s.extradata_hash, attachedPicture: Boolean(s.disposition?.attached_pic), rotation: number(Math.abs(Number(rotation))) !== undefined ? Number(rotation) || 0 : 0,
    language: s.tags?.language, sideData: s.side_data_list };
}
export async function probe(tools: NativeTools, filename: string, signal?: AbortSignal): Promise<Media> {
  const absolute = path.resolve(filename);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error('不是普通媒体文件');
  const result = await run(tools.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-show_data_hash', 'sha256', '-of', 'json', absolute], { signal, timeout: 30000 });
  const json = JSON.parse(result.stdout);
  const streams = (json.streams || []).map(normalizeStream) as MediaStream[];
  const video = streams.find(s => s.type === 'video' && !s.attachedPicture), audio = streams.find(s => s.type === 'audio');
  const image = imageExtensions.has(path.extname(absolute).toLowerCase());
  if (!video && !audio) throw new Error('文件没有可用的视频或音频流');
  const duration = image ? 5 : (video?.frames && video.fps && fpsValue(video.fps) ? video.frames / fpsValue(video.fps) : video?.duration || number(json.format?.duration) || audio?.duration || 0);
  if (!image && !(duration > 0)) throw new Error('媒体时长无效，文件可能损坏');
  return { id: createHash('sha256').update(`${absolute.toLowerCase()}|${info.size}|${info.mtimeMs}`).digest('hex').slice(0, 24), path: absolute,
    name: path.basename(absolute), kind: image ? 'image' : video ? 'video' : 'audio', size: info.size, modified: info.mtimeMs, duration, streams, video, audio,
    format: json.format?.format_name || '', bitRate: number(json.format?.bit_rate) || 0, hdr: ['smpte2084', 'arib-std-b67'].includes(video?.colorTransfer || ''), previewState: 'source' };
}
export class MediaService {
  readonly media = new Map<string, Media>();
  private tasks: (() => Promise<void>)[] = [];
  private running = false;
  private proxyPending = new Set<string>();
  private controller = new AbortController();
  private pumping: Promise<void> = Promise.resolve();
  constructor(readonly tools: NativeTools, readonly cache: string, readonly emit: (event: BackendEvent) => void) {}
  async register(files: string[]): Promise<{ media: Media[]; errors: { path: string; error: string }[] }> {
    const results: Media[] = [], errors: { path: string; error: string }[] = [];
    for (const filename of [...new Set(files)]) {
      try { const media = await probe(this.tools, filename, this.controller.signal); this.media.set(media.id, media); results.push(media); this.tasks.push(() => this.derivatives(media)); }
      catch (error) { errors.push({ path: filename, error: String(error) }); }
    }
    this.startPump(); return { media: results, errors };
  }
  async restore(media: Media[]): Promise<Media[]> {
    const result: Media[] = [];
    for (const old of media) {
      try {
        const current = await probe(this.tools, old.path, this.controller.signal);
        current.id = old.id;
        const unchanged = current.size === old.size && current.modified === old.modified;
        for (const key of ['thumbnail', 'preview'] as const) if (unchanged && old[key]) { try { await access(old[key]!); current[key] = old[key]; } catch { /* Regenerate only owned derivatives. */ } }
        if (unchanged) current.waveform = old.waveform;
        current.previewState = current.preview ? 'ready' : 'source';
        this.media.set(current.id, current); result.push(current);
        this.tasks.push(() => this.derivatives(current));
      } catch { result.push({ ...old, missing: true }); }
    }
    this.startPump(); return result;
  }
  async relink(id: string, filename: string): Promise<Media> {
    const replacement = await probe(this.tools, filename, this.controller.signal);
    replacement.id = id;
    this.media.set(id, replacement);
    this.tasks.push(() => this.derivatives(replacement));
    this.startPump();
    return replacement;
  }
  private startPump() { if (!this.running && !this.controller.signal.aborted) this.pumping = this.pump(); }
  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.tasks.length && !this.controller.signal.aborted) {
      try { await this.tasks.shift()!(); } catch (error) { if (!(error instanceof Cancelled)) this.emit({ type: 'status', text: `素材缓存失败：${String(error).slice(-400)}` }); }
    }
    this.running = false;
  }
  private async derivatives(m: Media) {
    await mkdir(this.cache, { recursive: true });
    if (m.video && !m.thumbnail) {
      const thumbnail = path.join(this.cache, `${m.id}.jpg`);
      await ffmpeg(this.tools.ffmpeg, ['-y', '-threads', '2', '-ss', String(Math.min(1, m.duration / 4)), '-i', m.path, '-map', `0:${m.video.index}`, '-frames:v', '1', '-vf', 'scale=360:202:force_original_aspect_ratio=decrease', '-q:v', '3', thumbnail], { signal: this.controller.signal });
      m.thumbnail = thumbnail;
    }
    if (m.audio && !m.waveform) {
      const peaks: number[] = [];
      const samplesPerPeak = Math.max(1, Math.ceil(m.duration * 1000 / 800));
      let samples = 0, peak = 0, carry = Buffer.alloc(0);
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        if (this.controller.signal.aborted) { reject(new Cancelled()); return; }
        const child = spawn(this.tools.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '2', '-i', m.path, '-map', `0:${m.audio!.index}`, '-vn', '-ac', '1', '-ar', '1000', '-f', 'f32le', 'pipe:1'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        const abort = () => child.kill();
        this.controller.signal.addEventListener('abort', abort, { once: true });
        const cleanup = () => this.controller.signal.removeEventListener('abort', abort);
        let error = '';
        child.stderr.on('data', b => error = (error + b).slice(-1000));
        child.stdout.on('data', (b: Buffer) => {
          const data = carry.length ? Buffer.concat([carry, b]) : b;
          const available = Math.floor(data.length / 4) * 4;
          for (let i = 0; i < available; i += 4) { peak = Math.max(peak, Math.abs(data.readFloatLE(i))); if (++samples >= samplesPerPeak) { peaks.push(peak); samples = 0; peak = 0; } }
          carry = Buffer.from(data.subarray(available));
        });
        child.on('error', error => { cleanup(); reject(error); });
        child.on('close', code => { cleanup(); if (this.controller.signal.aborted) reject(new Cancelled()); else if (code === 0) resolve(); else reject(new Error(error)); });
      });
      if (samples) peaks.push(peak);
      m.waveform = peaks;
      await writeFile(path.join(this.cache, `${m.id}.waveform.json`), JSON.stringify(peaks));
    }
    this.emit({ type: 'media', media: { ...m } });
  }
  async ensurePreview(id: string, force = false) {
    const media = this.media.get(id);
    if (!media || media.kind === 'image' || (media.preview && !force) || this.proxyPending.has(id)) return;
    const audioOnly = media.kind === 'audio';
    const needsProxy = force || (audioOnly ? ['wmav1', 'wmav2', 'wmapro', 'wmalossless', 'alac'].includes(media.audio?.codec || '') : ['hevc', 'av1', 'prores', 'dnxhd'].includes(media.video?.codec || '') || (media.video?.width || 0) > 1920);
    if (!needsProxy) return;
    media.previewState = 'pending'; this.proxyPending.add(id); this.emit({ type: 'media', media: { ...media } });
    this.tasks.push(async () => {
      try {
        await mkdir(this.cache, { recursive: true });
        const output = path.join(this.cache, `${id}.proxy.${audioOnly ? 'm4a' : 'mp4'}`);
        let vf = 'scale=960:540:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p';
        if (media.hdr) vf = 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,' + vf;
        await ffmpeg(this.tools.ffmpeg, ['-y', '-threads', '4', '-i', media.path, ...(audioOnly ? ['-map', `0:${media.audio!.index}`, '-vn'] : ['-map', `0:${media.video!.index}`, '-map', '0:a:0?', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25']), '-sn', '-dn', '-c:a', 'aac', '-b:a', '96k', '-t', String(media.duration), '-movflags', '+faststart', output], { signal: this.controller.signal, onProgress: p => this.emit({ type: 'status', text: `预览代理 ${media.name}：${Math.min(100, p.seconds / media.duration * 100).toFixed(1)}%` }) });
        media.preview = output; media.previewState = 'ready'; media.previewError = undefined;
      } catch (error) { media.previewState = 'failed'; media.previewError = `预览转换失败，源文件并未被判定为损坏：${String(error).slice(-400)}`; }
      finally { this.proxyPending.delete(id); this.emit({ type: 'media', media: { ...media } }); }
    });
    this.startPump();
  }
  async shutdown() { this.controller.abort(); this.tasks = []; await this.pumping; }
}
