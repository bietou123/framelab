import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Clip, ExportSettings, Media, Project } from '../shared/types';
import { projectDuration } from '../shared/model';
import { f, keyExpression } from './graph';
import type { NativeTools } from './native';
import { ffmpeg, type Progress } from './runner';
export const concatEscape = (filename: string) => filename.replace(/\\/g, '/').replace(/'/g, "'\\''");
export interface AudioInput { clip: Clip; media: Media }
export function audioInputs(p: Project): AudioInput[] {
  const inputs: AudioInput[] = [];
  for (const track of p.tracks) {
    if (track.muted || track.hidden || track.kind === 'subtitle') continue;
    if (track.kind === 'video' && !p.includeSourceAudio) continue;
    for (const clip of track.clips) {
      const media = p.media.find(m => m.id === clip.assetId);
      if (media?.audio && clip.start < projectDuration(p) && clip.freeze === null) inputs.push({ clip, media });
    }
  }
  return inputs;
}
export function silenceBounds(stderr: string, duration: number): { start: number; end: number } {
  const events = [...stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)].map(m => ({ kind: m[1], time: Number(m[2]) }));
  let start = 0, end = duration;
  if (events[0]?.kind === 'start' && events[0].time <= 0.04) start = events.find(e => e.kind === 'end')?.time ?? duration;
  const last = events.at(-1);
  if (last?.kind === 'start') end = last.time;
  if (last?.kind === 'end' && last.time >= duration - 0.04) end = events.at(-2)?.kind === 'start' ? events.at(-2)!.time : duration;
  return { start: Math.min(duration, Math.max(0, start)), end: Math.min(duration, Math.max(start, end)) };
}
export function atempo(rate: number): string[] {
  const filters: string[] = [];
  while (rate > 2.000001) { filters.push('atempo=2'); rate /= 2; }
  while (rate < 0.499999) { filters.push('atempo=0.5'); rate *= 2; }
  if (Math.abs(rate - 1) > 1e-8) filters.push(`atempo=${f(rate)}`);
  return filters;
}
export interface AudioContext {
  tools: NativeTools; work: string; settings: ExportSettings; signal: AbortSignal;
  phase: (text: string, percent?: number | null) => void;
  progress: (p: Progress, duration: number) => void; log: (line: string) => void;
}
export async function prepareAudio(p: Project, context: AudioContext): Promise<string | null> {
  const inputs = audioInputs(p);
  if (!inputs.length) return null;
  const duration = projectDuration(p), rate = context.settings.audioSampleRate;
  const files: { path: string; clip: Clip; duration: number }[] = [];
  const options = (d: number) => ({ signal: context.signal, cwd: context.work, onLine: context.log, onProgress: (v: Progress) => context.progress(v, d) });
  for (let i = 0; i < inputs.length; i++) {
    const { clip: c, media: m } = inputs[i];
    const length = Math.min(c.duration, duration - c.start);
    if (length <= 0) continue;
    let available = Math.min(m.duration - c.sourceStart, c.loop ? m.duration : length * c.rate);
    if (available <= 0) throw new Error(`音频入点超过素材时长：${c.name}`);
    let begin = c.sourceStart;
    if (c.trimSilence) {
      context.phase(`检测首尾静音 ${i + 1}/${inputs.length}：${c.name}`);
      const detected = await ffmpeg(context.tools.ffmpeg, ['-loglevel', 'info', '-threads', '2', '-ss', f(begin), '-t', f(available), '-i', m.path, '-map', `0:${m.audio!.index}`, '-af', 'silencedetect=n=-45dB:d=0.2', '-vn', '-f', 'null', '-'], options(available));
      const bounds = silenceBounds(detected.stderr, available);
      if (bounds.end - bounds.start < 0.05) throw new Error(`音频整段为静音：${c.name}`);
      begin += bounds.start; available = bounds.end - bounds.start;
      context.log(`首尾静音裁除：${c.name}，保留源片 ${f(begin)} 至 ${f(begin + available)} 秒`);
    }
    context.phase(`准备有限时长音频 ${i + 1}/${inputs.length}：${c.name}`);
    const clean = path.join(context.work, `audio-${i}-clean.wav`);
    const filters = ['aresample=' + rate, 'aformat=sample_fmts=flt:channel_layouts=stereo'];
    if (c.reverse) filters.push('areverse');
    filters.push(...atempo(c.rate));
    if (c.effects.denoise) filters.push('afftdn=nf=-25');
    const cleanDuration = available / c.rate;
    // Bound the source before reverse/tempo; the output limit is in timeline time.
    await ffmpeg(context.tools.ffmpeg, ['-y', '-threads', '2', '-ss', f(begin), '-t', f(available), '-i', m.path, '-map', `0:${m.audio!.index}`, '-t', f(cleanDuration), '-vn', '-af', filters.join(','), '-c:a', 'pcm_s16le', clean], options(cleanDuration));
    let source = clean;
    const inputArgs: string[] = [];
    if (c.loop && length > cleanDuration) {
      const crossfade = Math.min(c.crossfade, cleanDuration / 3);
      const period = cleanDuration - crossfade;
      const cycles = Math.ceil((length - period) / period) + 1;
      if (cycles > 100000) throw new Error('音频过短，需要的循环次数超出资源限制');
      const lines = ['ffconcat version 1.0', `file '${concatEscape(clean)}'`, `outpoint ${f(crossfade ? period : cleanDuration)}`];
      if (crossfade > 0.005) {
        context.phase(`生成 ${f(crossfade)} 秒交叉淡化循环单元：${c.name}`);
        const unit = path.join(context.work, `audio-${i}-unit.wav`);
        const graph = `[0:a]asplit=2[a][b];[a][b]acrossfade=d=${f(crossfade)}:c1=tri:c2=tri,atrim=start=${f(period)}:end=${f(2 * period)},asetpts=PTS-STARTPTS[unit]`;
        await ffmpeg(context.tools.ffmpeg, ['-y', '-i', clean, '-filter_complex', graph, '-map', '[unit]', '-c:a', 'pcm_s16le', unit], options(period));
        for (let j = 0; j < cycles; j++) lines.push(`file '${concatEscape(unit)}'`);
      } else for (let j = 0; j < cycles; j++) lines.push(`file '${concatEscape(clean)}'`);
      source = path.join(context.work, `audio-${i}-loop.ffconcat`);
      await writeFile(source, lines.join('\n') + '\n', 'utf8');
      inputArgs.push('-f', 'concat', '-safe', '0');
      context.log(`配乐循环有界：最多 ${cycles + 1} 个单元，明确截断至 ${f(length)} 秒`);
    }
    const output = path.join(context.work, `audio-${i}-finite.wav`);
    const volume = keyExpression(c.effects.keys.volumeDb, c.effects.volumeDb);
    const effects = [`apad=whole_dur=${f(length)}`, `atrim=duration=${f(length)}`, 'asetpts=N/SR/TB', `volume='pow(10,(${volume})/20)':eval=frame`];
    if (c.effects.fadeIn > 0) effects.push(`afade=t=in:st=0:d=${f(Math.min(c.effects.fadeIn, length))}`);
    if (c.effects.fadeOut > 0) { const fade = Math.min(c.effects.fadeOut, length); effects.push(`afade=t=out:st=${f(length - fade)}:d=${f(fade)}`); }
    await ffmpeg(context.tools.ffmpeg, ['-y', ...inputArgs, '-i', source, '-t', f(length), '-af', effects.join(','), '-c:a', 'pcm_s16le', output], options(length));
    files.push({ path: output, clip: c, duration: length });
  }
  context.phase('混合音轨并限制全片时长');
  const args = files.flatMap(file => ['-i', file.path]);
  const graph = files.map((file, i) => `[${i}:a]adelay=${Math.round(file.clip.start * 1000)}:all=1[a${i}]`);
  graph.push(`${files.map((_, i) => `[a${i}]`).join('')}amix=inputs=${files.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0,apad=whole_dur=${f(duration)},atrim=duration=${f(duration)},asetpts=N/SR/TB[outa]`);
  const mixed = path.join(context.work, 'soundtrack.wav');
  await ffmpeg(context.tools.ffmpeg, ['-y', ...args, '-filter_complex', graph.join(';'), '-map', '[outa]', '-ar', String(rate), '-ac', '2', '-c:a', 'pcm_s16le', '-t', f(duration), mixed], options(duration));
  return mixed;
}
