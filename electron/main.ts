import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, protocol, shell, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync, createReadStream, mkdirSync } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { locateNative, capabilities, type NativeTools } from './native';
import { MediaService } from './media';
import { AssetLibrary, DEFAULT_AUDIO, DEFAULT_DATA, ProjectStore } from './storage';
import { ExportQueue } from './exporter';
import { PreviewService } from './previews';
import { serveApp } from './app-protocol';
import { ffmpeg, run } from './runner';
import { validateProject } from '../shared/schema';
import type { BackendEvent, Bootstrap, Capabilities, ExportSettings, Project } from '../shared/types';
const here = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.FRAMELAB_DATA_DIR || DEFAULT_DATA), audio = path.resolve(process.env.FRAMELAB_AUDIO_DIR || DEFAULT_AUDIO);
mkdirSync(data, { recursive: true });
for (const name of ['logs', 'tmp', 'crashes']) mkdirSync(path.join(data, name), { recursive: true });
app.setPath('userData', path.join(data, 'electron-profile'));
app.setPath('sessionData', path.join(data, 'electron-profile'));
app.setPath('logs', path.join(data, 'logs'));
app.setPath('temp', path.join(data, 'tmp'));
app.setPath('crashDumps', path.join(data, 'crashes'));
process.env.TEMP = process.env.TMP = path.join(data, 'tmp');
const startupFile = path.join(data, 'logs', `startup-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`);
function startupLog(event: string, details: unknown = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, details });
  try { appendFileSync(startupFile, `${line}\n`, 'utf8'); } catch (error) { console.error('FrameLab startup log unavailable:', error); }
  console.log(`FrameLab ${line}`);
}
startupLog('main-start', { electron: process.versions.electron, node: process.versions.node, executable: process.execPath, softwareRendering: process.env.FRAMELAB_SOFTWARE_RENDERING === '1' });
process.on('uncaughtExceptionMonitor', error => startupLog('uncaught-exception', { error: error.stack || String(error) }));
crashReporter.start({ productName: 'FrameLab', uploadToServer: false });
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{ scheme: 'framelab', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const test = process.env.FRAMELAB_TEST === '1';
if (process.env.FRAMELAB_SOFTWARE_RENDERING === '1') app.disableHardwareAcceleration();
app.on('child-process-gone', (_event, details) => startupLog('child-process-gone', details));
const store = new ProjectStore(data), library = new AssetLibrary(audio);
let window: BrowserWindow | undefined, tools: NativeTools, caps: Capabilities, media: MediaService, queue: ExportQueue, previews: PreviewService;
let project: Project, recovery: Project | undefined;
let exiting = false;
const allow = new Set<string>();
const key = (filename: string) => path.resolve(filename).toLowerCase();
function emit(event: BackendEvent) {
  if (event.type === 'media') { allow.add(key(event.media.path)); for (const filename of [event.media.thumbnail, event.media.preview]) if (filename) allow.add(key(filename)); }
  if (event.type === 'job' && event.job.stage === 'completed') allow.add(key(event.job.output));
  if (window && !window.isDestroyed()) window.webContents.send('framelab:event', event);
}
function allowProject(p: Project) {
  for (const m of p.media) { if (!m.missing) allow.add(key(m.path)); for (const file of [m.thumbnail, m.preview]) if (file) allow.add(key(file)); }
}
async function initialize() {
  startupLog('project-store-start');
  const state = await store.init(); project = state.project; recovery = state.recovery;
  tools = await locateNative(process.resourcesPath);
  startupLog('native-detected', tools);
  caps = await capabilities(tools);
  startupLog('encoders-detected', caps.encoders.map(({ name, available, reason }) => ({ name, available, reason })));
  media = new MediaService(tools, store.cache, emit);
  project.media = await media.restore(project.media); allowProject(project);
  if (recovery) { recovery.media = await media.restore(recovery.media); allowProject(recovery); }
  const entries = await library.init(); for (const entry of entries) allow.add(key(entry.path));
  queue = new ExportQueue(tools, caps, store, emit); await queue.init();
  for (const job of queue.jobs.filter(j => j.stage === 'completed')) allow.add(key(job.output));
  previews = new PreviewService(tools, store.cache, emit);
  const initialPath = process.argv.find(a => a.startsWith('--project='))?.slice(10);
  if (initialPath) { project = await store.open(initialPath); project.media = await media.restore(project.media); allowProject(project); }
  startupLog('initialization-complete', { media: project.media.length, jobs: queue.jobs.length });
}
let ready: Promise<void>;
function handle(name: string, action: (...args: any[]) => unknown) {
  ipcMain.handle(`framelab:${name}`, async (event: IpcMainInvokeEvent, ...args: any[]) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('IPC 来源无效');
    await ready; return action(...args);
  });
}
function registerIPC() {
  handle('bootstrap', async (): Promise<Bootstrap> => ({ project, recovery, recent: store.recent, library: await library.list(), capabilities: caps, jobs: queue.jobs, paths: { data, audio, cache: store.cache } }));
  handle('import', async (files?: string[]) => {
    if (!files) { const result = await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'], filters: [{ name: '媒体', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mts', 'm2ts', 'mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus', 'wma', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif'] }, { name: '所有文件', extensions: ['*'] }] }); if (result.canceled) return { media: [], errors: [] }; files = result.filePaths; }
    if (!Array.isArray(files) || files.length > 5000 || files.some(f => typeof f !== 'string')) throw new Error('导入文件列表无效');
    const result = await media.register(files); for (const m of result.media) allow.add(key(m.path)); return result;
  });
  handle('preview', (id: string, force?: boolean) => media.ensurePreview(id, Boolean(force)));
  handle('preview-audio', async (p: Project) => { const filename = await previews.soundtrack(p); if (filename) allow.add(key(filename)); return filename; });
  handle('render-frame', async (p: Project, time: number) => { const filename = await previews.frame(p, time); allow.add(key(filename)); return filename; });
  handle('cancel-preview', (kind: string) => { if (kind !== 'audio' && kind !== 'frame') throw new Error('预览类型无效'); return previews.cancel(kind); });
  handle('save', async (p: Project, as?: boolean) => {
    let filename = !as && p.path;
    if (!filename) { const result = await dialog.showSaveDialog(window!, { defaultPath: path.join(data, `${p.name.replace(/[<>:"/\\|?*]/g, '_')}.frameproj`), filters: [{ name: 'FrameLab 项目', extensions: ['frameproj'] }] }); if (result.canceled || !result.filePath) return null; filename = result.filePath; }
    project = await store.save(p, filename); return project;
  });
  handle('open', async (filename?: string) => {
    if (!filename) { const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], defaultPath: data, filters: [{ name: 'FrameLab 项目', extensions: ['frameproj'] }] }); if (result.canceled) return null; filename = result.filePaths[0]; }
    project = await store.open(filename); project.media = await media.restore(project.media); allowProject(project); return project;
  });
  handle('autosave', async (p: Project) => { project = validateProject(p); await store.autosave(project); });
  handle('relink', async (id: string) => {
    const old = project.media.find(m => m.id === id); if (!old) throw new Error('素材不存在');
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], title: `重新定位 ${old.name}` }); if (result.canceled) return null;
    const m = await media.relink(id, result.filePaths[0]); allow.add(key(m.path)); return m;
  });
  handle('assets', () => library.list());
  handle('asset-add', async (filename: string, source: string, license: string) => { if (!allow.has(key(filename))) throw new Error('请先导入此音频'); const entry = await library.add(filename, source, license); allow.add(key(entry.path)); return entry; });
  handle('pick', async (kind: string) => { const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], defaultPath: kind === 'music' ? audio : undefined, filters: kind === 'lut' ? [{ name: 'LUT', extensions: ['cube', '3dl'] }] : [{ name: '音频', extensions: ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus'] }] }); if (result.canceled) return null; return result.filePaths[0]; });
  handle('srt-open', async () => { const r = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'SRT', extensions: ['srt'] }] }); if (r.canceled) return null; if ((await stat(r.filePaths[0])).size > 8000000) throw new Error('SRT 文件超出 8 MB 限制'); return { path: r.filePaths[0], text: await readFile(r.filePaths[0], 'utf8') }; });
  handle('srt-save', async (text: string) => { if (typeof text !== 'string' || text.length > 8000000) throw new Error('字幕内容无效'); const r = await dialog.showSaveDialog(window!, { defaultPath: path.join(data, `${project.name}-subtitles.srt`), filters: [{ name: 'SRT', extensions: ['srt'] }] }); if (r.canceled || !r.filePath) return null; await writeFile(r.filePath, text, 'utf8'); return r.filePath; });
  handle('export-dialog', async (name: string) => { const r = await dialog.showSaveDialog(window!, { defaultPath: path.join(path.dirname(project.path || data), `${name.replace(/[<>:"/\\|?*]/g, '_')}-export.mp4`), filters: [{ name: 'MP4', extensions: ['mp4'] }] }); return r.canceled ? null : r.filePath || null; });
  handle('enqueue', (p: Project, s: ExportSettings) => queue.enqueue(p, s)); handle('cancel', (id: string) => queue.cancel(id)); handle('retry', (id: string, smaller?: boolean) => queue.retry(id, smaller));
  handle('reveal', (filename: string) => { if (!allow.has(key(filename)) && ![data, audio, store.cache].includes(path.resolve(filename)) && !queue.jobs.some(j => j.logPath === filename)) throw new Error('路径未注册'); shell.showItemInFolder(filename); });
  handle('transcribe', async (p: Project) => {
    if (!caps.speech.available) throw new Error(caps.speech.reason);
    const speechProject = validateProject(structuredClone(p)); speechProject.tracks = speechProject.tracks.map(t => ({ ...t, clips: t.clips.filter(c => !c.loop) }));
    const mixed = await previews.soundtrack(speechProject, 'speech'); if (!mixed) throw new Error('没有可识别的音轨');
    const base = path.join(store.cache, `transcribe-${crypto.randomUUID()}`), wav = `${base}.wav`;
    emit({ type: 'status', text: '本地语音识别：准备 16 kHz 单声道音频' });
    await ffmpeg(tools.ffmpeg, ['-y', '-i', mixed, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    emit({ type: 'status', text: '正在运行本地 whisper.cpp' });
    await run(process.env.FRAMELAB_WHISPER_CLI!, ['-m', process.env.FRAMELAB_WHISPER_MODEL!, '-f', wav, '-l', 'auto', '-osrt', '-of', base, '-t', '4'], { onLine: text => emit({ type: 'status', text: text.slice(-300) }) });
    const filename = `${base}.srt`; return { text: await readFile(filename, 'utf8'), path: filename };
  });
}
async function serveMedia(request: Request): Promise<Response> {
  const filename = new URL(request.url).searchParams.get('path');
  if (!filename || !allow.has(key(filename))) return new Response('Not registered', { status: 403 });
  try {
    const info = await stat(filename); if (!info.isFile()) return new Response('Not a file', { status: 404 });
    const type = ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' } as Record<string, string>)[path.extname(filename).toLowerCase()] || 'application/octet-stream';
    const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
    let start = 0, end = info.size - 1, status = 200;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
      if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      else if (match[2]) start = Math.max(0, info.size - Number(match[2]));
      if (start > end || start >= info.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = String(end - start + 1);
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    const stream = createReadStream(filename, { start, end, highWaterMark: 64 * 1024 });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
  } catch { return new Response('Unavailable', { status: 404 }); }
}
// Awaiting whenReady at module scope prevents Electron from completing ESM startup.
app.whenReady().then(async () => {
  startupLog('electron-ready');
  Menu.setApplicationMenu(null);
  protocol.handle('framelab', request => {
    const url = new URL(request.url);
    if (url.hostname === 'app') return serveApp(request, path.join(here, '../dist'));
    if (url.hostname === 'local' && url.pathname === '/media') return serveMedia(request);
    return new Response(null, { status: 404 });
  });
  ready = initialize();
  void ready.catch(error => { startupLog('initialization-failed', { error: String(error) }); emit({ type: 'status', text: `初始化失败：${String(error)}` }); });
  registerIPC();
  window = new BrowserWindow({ width: 1480, height: 960, minWidth: 760, minHeight: 580, title: 'FrameLab', backgroundColor: '#151719', show: !test,
    ...(test ? { x: -12000, y: -12000, skipTaskbar: true } : {}),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  // An offscreen shown window keeps Chromium producing frames for pixel tests.
  if (test) window.once('ready-to-show', () => window?.showInactive());
  startupLog('window-created');
  window.webContents.on('render-process-gone', (_event, details) => startupLog('render-process-gone', details));
  window.webContents.on('preload-error', (_event, filename, error) => startupLog('preload-error', { filename, error: String(error) }));
  window.webContents.on('did-fail-load', (_event, code, description, url, mainFrame) => startupLog('did-fail-load', { code, description, url, mainFrame }));
  window.webContents.on('did-finish-load', () => startupLog('did-finish-load', { url: window?.webContents.getURL() }));
  window.webContents.on('unresponsive', () => startupLog('renderer-unresponsive'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== window?.webContents.getURL()) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (process.env.FRAMELAB_DEV_URL) await window.loadURL(process.env.FRAMELAB_DEV_URL); else await window.loadURL('framelab://app/index.html');
  startupLog('workbench-loaded');
}).catch(error => { startupLog('startup-failed', { error: String(error) }); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (exiting) return;
  event.preventDefault(); exiting = true;
  void (async () => { try { await ready; await previews?.shutdown(); await queue?.shutdown(); await media?.shutdown(); await store.close(); } catch { /* Initialization errors must still allow exit. */ } finally { app.quit(); } })();
});
