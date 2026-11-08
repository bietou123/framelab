import { stat } from 'node:fs/promises';
import { fpsValue, projectDuration } from '../shared/model';
import type { ExportSettings, Project, Validation } from '../shared/types';
import type { NativeTools } from './native';
import { probe } from './media';
import { ffmpeg, run, type Progress } from './runner';
import { outputVideoColor } from './color';
export function sameRational(a: string, b: string): boolean {
  const [an, ad] = a.split('/').map(Number), [bn, bd] = b.split('/').map(Number);
  return Number.isFinite(an * bd) && ad > 0 && bd > 0 && an * bd === bn * ad;
}
export interface VerifyContext {
  tools: NativeTools; signal: AbortSignal; hasAudio: boolean; hardwareDecode: boolean;
  phase: (text: string) => void; progress: (p: Progress, duration: number) => void; log: (text: string) => void;
}
export async function validateOutput(filename: string, p: Project, settings: ExportSettings, context: VerifyContext): Promise<Validation> {
  const media = await probe(context.tools, filename, context.signal), v = media.video;
  if (!v) throw new Error('导出文件没有视频流');
  const duration = projectDuration(p), fps = fpsValue(settings.fps), step = 1 / fps;
  const issues: string[] = [], warnings: string[] = [];
  const size = (await stat(filename)).size;
  if (settings.maxBytes !== null && size >= settings.maxBytes) issues.push(`实际大小 ${size} 字节，不满足严格小于 ${settings.maxBytes} 字节`);
  if (v.width !== settings.width || v.height !== settings.height) issues.push(`分辨率不符：${v.width}×${v.height}`);
  if (!sameRational(v.fps || '', settings.fps)) issues.push(`精确帧率不符：${v.fps}，预期 ${settings.fps}`);
  if (Math.abs(media.duration - duration) > Math.max(2 * step, 0.04)) issues.push(`视频时长不符：${media.duration}，预期 ${duration}`);
  if (media.streams.some(s => s.type === 'data' || s.attachedPicture)) issues.push('输出包含多余 DJI 数据流或附带缩略图');
  const color = outputVideoColor(p, settings);
  for (const key of ['colorPrimaries', 'colorTransfer', 'colorSpace'] as const) {
    const expected = color[key];
    if (expected && expected !== 'unknown' && v[key] !== expected) issues.push(`色彩标记不符：${key}=${v[key]}，预期 ${expected}`);
  }
  const audioEnd = media.audio?.duration || 0;
  if (context.hasAudio && !media.audio) issues.push('缺少配乐音轨');
  if (context.hasAudio && audioEnd < duration - 0.04) issues.push(`音轨未覆盖全片：${audioEnd}/${duration} 秒`);
  context.phase('检查逐帧时间戳与拼接边界');
  const pts: number[] = [];
  let buffer = '', previousDts = -Infinity, monotonic = true, packets = 0;
  await run(context.tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,dts_time,duration_time', '-of', 'compact=p=0:nk=0', filename], {
    signal: context.signal, captureLimit: 1000,
    onStdout: chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) {
        const fields = Object.fromEntries(line.split('|').filter(s => s.includes('=')).map(s => { const at = s.indexOf('='); return [s.slice(0, at), s.slice(at + 1)]; }));
        if (!fields.pts_time) continue;
        const pt = Number(fields.pts_time), dts = Number(fields.dts_time);
        if (Number.isFinite(pt)) pts.push(pt);
        if (Number.isFinite(dts)) { if (dts < previousDts - 1e-6) monotonic = false; previousDts = dts; }
        packets++;
      }
    },
  });
  pts.sort((a, b) => a - b);
  let largestGap = 0;
  for (let i = 1; i < pts.length; i++) largestGap = Math.max(largestGap, pts[i] - pts[i - 1]);
  if (!monotonic) issues.push('视频解码时间戳回退');
  if (largestGap > step * 1.6) issues.push(`视频显示时间戳有缺帧间隙：${largestGap} 秒`);
  if (pts.length && (Math.abs(pts[0]) > step || pts.at(-1)! < duration - step * 2)) issues.push('视频时间戳未覆盖完整时间线');
  const boundaries = [...new Set(p.tracks.filter(t => t.kind === 'video' && !t.hidden).flatMap(t => t.clips.filter(c => c.start > 0).map(c => c.start)))];
  const boundaryChecks = boundaries.map(time => {
    const near = pts.filter(pt => Math.abs(pt - time) < step * 8);
    let maximumGap = 0;
    for (let i = 1; i < near.length; i++) maximumGap = Math.max(maximumGap, near[i] - near[i - 1]);
    return { time, maximumGap, monotonic: monotonic && maximumGap <= step * 1.6 && near.length > 0 };
  });
  if (boundaryChecks.some(b => !b.monotonic)) issues.push('拼接边界的时间戳不连续');
  let decoded = false, frames = v.frames || 0;
  if (settings.verifyDecode) {
    context.phase('完整解码校验视频和音频');
    const args = ['-loglevel', 'error', '-xerror', '-err_detect', 'explode'];
    const decode = async (hardware: boolean) => {
      let counted = 0;
      await ffmpeg(context.tools.ffmpeg, [...args, '-threads', hardware ? '1' : String(settings.threads), ...(hardware ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-extra_hw_frames', '8'] : []), '-i', filename, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-fps_mode', 'passthrough', '-f', 'null', '-'], {
        signal: context.signal, onLine: context.log, onProgress: value => { counted = Math.max(counted, value.frame); context.progress(value, duration); },
      });
      return counted;
    };
    try { frames = await decode(context.hardwareDecode); }
    catch (error) {
      if (context.signal.aborted || !context.hardwareDecode) throw error;
      context.log(`硬件解码校验失败，使用软件重新校验：${String(error).slice(-800)}`);
      frames = await decode(false);
    }
    decoded = true;
  } else warnings.push('未执行完整解码；不能据此保证媒体内容未损坏');
  const rawExpected = duration * fps;
  const expectedFrames = Math.abs(rawExpected - Math.round(rawExpected)) < 0.0001 ? Math.round(rawExpected) : Math.ceil(rawExpected);
  if (frames !== expectedFrames) issues.push(`帧数不符：${frames}，预期 ${expectedFrames}`);
  return { passed: issues.length === 0, size, duration: media.duration, frames, width: v.width!, height: v.height!, fps: v.fps || '', videoCodec: v.codec,
    audioCodec: media.audio?.codec, audioEnd, decoded, packets, boundaryChecks, issues, warnings };
}
