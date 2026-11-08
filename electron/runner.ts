import { spawn } from 'node:child_process';
export interface Progress { frame: number; seconds: number; speed: number; bytes: number; end: boolean }
export class ProcessFailure extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string, readonly args: string[]) { super(message); this.name = 'ProcessFailure'; }
}
export class Cancelled extends Error { constructor() { super('已取消'); this.name = 'Cancelled'; } }
export function parseProgress(values: Record<string, string>): Progress {
  const timestamp = values.out_time?.split(':').map(Number) || [];
  const seconds = Number(values.out_time_us || values.out_time_ms) / 1_000_000 || (timestamp.length === 3 ? timestamp[0] * 3600 + timestamp[1] * 60 + timestamp[2] : 0);
  return { frame: Math.max(0, Number(values.frame) || 0), seconds: Math.max(0, seconds), speed: parseFloat(values.speed) || 0, bytes: Math.max(0, Number(values.total_size) || 0), end: values.progress === 'end' };
}
export interface RunOptions {
  signal?: AbortSignal; onProgress?: (p: Progress) => void; onLine?: (line: string) => void;
  onStdout?: (chunk: string) => void; cwd?: string; timeout?: number; captureLimit?: number;
}
export async function run(exe: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw new Cancelled();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { shell: false, windowsHide: true, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const limit = options.captureLimit ?? 4_000_000;
    let stdout = '', stderr = '', outBuffer = '', errBuffer = '';
    const values: Record<string, string> = {};
    let timedOut = false;
    const abort = () => child.kill();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = options.timeout ? setTimeout(() => { timedOut = true; child.kill(); }, options.timeout) : undefined;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      options.onStdout?.(chunk);
      stdout = (stdout + chunk).slice(-limit);
      if (options.onProgress) {
        outBuffer += chunk;
        const lines = outBuffer.split(/\r?\n/); outBuffer = lines.pop() || '';
        for (const line of lines) {
          const index = line.indexOf('=');
          if (index < 0) continue;
          values[line.slice(0, index)] = line.slice(index + 1);
          if (line.startsWith('progress=')) options.onProgress(parseProgress(values));
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-limit); errBuffer += chunk;
      const lines = errBuffer.split(/\r?\n/); errBuffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) options.onLine?.(line.trim());
    });
    const cleanup = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (errBuffer.trim()) options.onLine?.(errBuffer.trim());
      if (options.signal?.aborted) reject(new Cancelled());
      else if (timedOut) reject(new ProcessFailure('处理超时', code, stderr, args));
      else if (code !== 0) reject(new ProcessFailure(`FFmpeg/FFprobe 退出代码 ${code}: ${stderr.slice(-2400)}`, code, stderr, args));
      else resolve({ stdout, stderr });
    });
  });
}
export function ffmpeg(exe: string, args: string[], options: RunOptions = {}) {
  return run(exe, ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-stats_period', '0.5', '-progress', 'pipe:1', ...args], options);
}
