import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from './runner';
import type { Capabilities, Encoder } from '../shared/types';
export interface NativeTools { ffmpeg: string; ffprobe: string }
export async function locateNative(resources?: string): Promise<NativeTools> {
  const bins = [
    process.env.FRAMELAB_NATIVE_DIR,
    resources && path.join(resources, 'native'),
    path.resolve('native', 'bin'),
    path.resolve('native'),
  ].filter((p): p is string => Boolean(p));
  for (const bin of bins) {
    try { const ffmpeg = path.join(bin, 'ffmpeg.exe'), ffprobe = path.join(bin, 'ffprobe.exe'); await access(ffmpeg); await access(ffprobe); return { ffmpeg, ffprobe }; } catch { /* Try the next explicitly configured directory. */ }
  }
  throw new Error('未找到本机 FFmpeg 和 FFprobe，请运行 npm run setup:native 或设置 FRAMELAB_NATIVE_DIR');
}
export async function capabilities(tools: NativeTools): Promise<Capabilities> {
  const version = (await run(tools.ffmpeg, ['-version'])).stdout.split('\n')[0].trim();
  const list = (await run(tools.ffmpeg, ['-hide_banner', '-encoders'])).stdout;
  const candidates: [string, Encoder['codec'], string][] = [
    ['h264_nvenc', 'h264', 'NVIDIA'], ['hevc_nvenc', 'hevc', 'NVIDIA'], ['av1_nvenc', 'av1', 'NVIDIA'],
    ['h264_qsv', 'h264', 'Intel'], ['hevc_qsv', 'hevc', 'Intel'], ['av1_qsv', 'av1', 'Intel'],
    ['h264_amf', 'h264', 'AMD'], ['hevc_amf', 'hevc', 'AMD'], ['av1_amf', 'av1', 'AMD'],
    ['libx264', 'h264', 'CPU'], ['libx265', 'hevc', 'CPU'], ['libsvtav1', 'av1', 'CPU'], ['libaom-av1', 'av1', 'CPU'],
  ];
  const encoders: Encoder[] = [];
  for (const [name, codec, vendor] of candidates) {
    if (!new RegExp(`\\b${name}\\b`).test(list)) continue;
    const encoder: Encoder = { name, codec, vendor, hardware: vendor !== 'CPU', available: false };
    try {
      await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30', '-frames:v', '3', '-an', '-c:v', name, '-threads', '2', '-f', 'null', '-'], { timeout: 20000 });
      encoder.available = true;
    } catch (error) { encoder.reason = String(error).slice(-600); }
    encoders.push(encoder);
  }
  let fonts: string[] = ['Microsoft YaHei', 'Arial', 'SimHei'];
  try {
    const names = await readdir(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    fonts = [...new Set([...fonts, ...names.filter(n => /\.(ttf|otf)$/i.test(n)).map(n => n.replace(/\.[^.]+$/, ''))])];
  } catch { /* Standard Windows fonts remain selectable. */ }
  let speech: Capabilities['speech'] = { available: false, reason: '未配置本地语音识别执行器；已有模型文件不等于可用识别服务' };
  const cli = process.env.FRAMELAB_WHISPER_CLI, model = process.env.FRAMELAB_WHISPER_MODEL;
  if (cli && model) {
    try { await access(cli); await access(model); speech = { available: true, model, reason: '本地 whisper.cpp' }; }
    catch { speech.reason = '配置的语音识别执行器或模型文件不存在'; }
  }
  return { ...tools, version, encoders, speech, fonts };
}
