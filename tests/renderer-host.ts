import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from 'playwright';
import { capabilities, type NativeTools } from '../electron/native';
import { MediaService } from '../electron/media';
import { AssetLibrary, ProjectStore } from '../electron/storage';
import { ExportQueue } from '../electron/exporter';
import { PreviewService } from '../electron/previews';
import { validateProject } from '../shared/schema';
import type { BackendEvent, EditorAPI } from '../shared/types';

// This test-only host uses the real native services. It does not test Electron IPC,
// its sandbox, OS dialogs or the packaged application's startup.
export async function rendererHost(work: string, tools: NativeTools) {
  const store = new ProjectStore(path.join(work, 'profile'));
  const library = new AssetLibrary(path.join(work, 'library'));
  const state = await store.init(), caps = await capabilities(tools);
  let project = state.project;
  await library.init();
  const streams = new Set<ServerResponse>(), allowed = new Set<string>();
  const key = (filename: string) => path.resolve(filename).toLowerCase();
  const allow = (filename?: string) => { if (filename) allowed.add(key(filename)); };
  const emit = (event: BackendEvent) => {
    if (event.type === 'media') for (const filename of [event.media.path, event.media.thumbnail, event.media.preview]) allow(filename);
    if (event.type === 'job' && event.job.stage === 'completed') allow(event.job.output);
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const media = new MediaService(tools, store.cache, emit);
  const previews = new PreviewService(tools, store.cache, emit);
  const queue = new ExportQueue(tools, caps, store, emit); await queue.init();
  let openFiles: string[] = [], saveFile: string | undefined;
  const requireSave = () => { if (!saveFile) throw new Error('No test save-dialog selection'); return saveFile; };
  type NativeAPI = Omit<EditorAPI, 'filePath' | 'mediaUrl' | 'onEvent'>;
  const api: NativeAPI = {
    bootstrap: async () => ({ project, recovery: state.recovery, recent: store.recent, library: await library.list(), capabilities: caps, jobs: structuredClone(queue.jobs), paths: { data: store.root, audio: library.root, cache: store.cache } }),
    importMedia: async files => { const result = await media.register(files || openFiles); result.media.forEach(m => allow(m.path)); return result; },
    ensurePreview: (id, force) => media.ensurePreview(id, force),
    previewAudio: async p => { const filename = await previews.soundtrack(p); allow(filename || undefined); return filename; },
    renderFrame: async (p, time) => { const filename = await previews.frame(p, time); allow(filename); return filename; },
    cancelPreview: kind => previews.cancel(kind),
    autosave: async p => { project = validateProject(p); await store.autosave(project); },
    saveProject: async (p, as) => { project = await store.save(p, !as && p.path || requireSave()); return project; },
    openProject: async filename => { project = await store.open(filename || openFiles[0]); project.media = await media.restore(project.media); project.media.forEach(m => { allow(m.path); allow(m.thumbnail); allow(m.preview); }); return project; },
    relink: async id => { const found = await media.relink(id, openFiles[0]); allow(found.path); return found; },
    addAsset: async (filename, source, license) => { if (!allowed.has(key(filename))) throw new Error('Media not imported'); const entry = await library.add(filename, source, license); allow(entry.path); return entry; },
    refreshAssets: () => library.list(), pickFile: async () => openFiles[0] || null,
    importSrt: async () => openFiles[0] ? { path: openFiles[0], text: await readFile(openFiles[0], 'utf8') } : null,
    exportSrt: async text => { const filename = requireSave(); await writeFile(filename, text, 'utf8'); return filename; },
    transcribe: async () => { throw new Error('Local speech recognition is not exercised by renderer tests'); },
    exportDialog: async () => requireSave(),
    enqueue: (p, s) => queue.enqueue(p, s), cancel: id => queue.cancel(id), retry: (id, smaller) => queue.retry(id, smaller),
    reveal: async () => { throw new Error('OS file-manager integration is not exercised by renderer tests'); },
  };
  const token = randomUUID(), dist = path.resolve('dist');
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg' };
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (['/api', '/events', '/media'].includes(url.pathname) && url.searchParams.get('token') !== token) { res.writeHead(403).end(); return; }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
    }
    if (url.pathname === '/api' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 32_000_000) throw new Error('Test request too large'); }
      const { name, args } = JSON.parse(body);
      if (!Object.hasOwn(api, name) || !Array.isArray(args)) throw new Error('Invalid test API method');
      const result = await (api[name as keyof NativeAPI] as (...values: any[]) => unknown)(...args);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result })); return;
    }
    let filename: string;
    if (url.pathname === '/media') {
      filename = url.searchParams.get('path') || '';
      if (!allowed.has(key(filename))) { res.writeHead(403).end(); return; }
    } else {
      filename = path.resolve(dist, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!filename.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
    }
    const info = await stat(filename), headers: Record<string, string> = { 'Content-Type': mime[path.extname(filename).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    let start = 0, end = info.size - 1, status = 200;
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!range) { res.writeHead(416).end(); return; }
      start = Number(range[1]); end = Math.min(end, range[2] ? Number(range[2]) : end);
      if (start > end) { res.writeHead(416).end(); return; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = String(end - start + 1); res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end(); else createReadStream(filename, { start, end }).pipe(res);
  })().catch(error => { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test host failed to listen');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    open: (files: string[]) => { openFiles = files; }, save: (filename: string) => { saveFile = filename; },
    async connect(page: Page) {
      // A source string keeps tsx/esbuild's function-name helpers out of the page.
      await page.addInitScript({ content: `(() => {
        const token = ${JSON.stringify(token)};
        const call = async (name, ...args) => {
          const response = await fetch('/api?token=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }) });
          const json = await response.json(); if (!response.ok) throw new Error(json.error); return json.result;
        };
        const api = {};
        for (const name of ['bootstrap', 'importMedia', 'ensurePreview', 'previewAudio', 'renderFrame', 'cancelPreview', 'autosave', 'saveProject', 'openProject', 'relink', 'addAsset', 'refreshAssets', 'pickFile', 'importSrt', 'exportSrt', 'transcribe', 'exportDialog', 'enqueue', 'cancel', 'retry', 'reveal']) api[name] = (...args) => call(name, ...args);
        api.mediaUrl = filename => '/media?token=' + token + '&path=' + encodeURIComponent(filename);
        api.filePath = () => { throw new Error('OS file drops require Electron'); };
        api.onEvent = listener => { const source = new EventSource('/events?token=' + token); source.onmessage = e => listener(JSON.parse(e.data)); return () => source.close(); };
        Object.defineProperty(window, 'framelab', { value: api });
      })();` });
      await page.goto(origin);
    },
    async close() { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await previews.shutdown(); await queue.shutdown(); await media.shutdown(); await store.close(); },
  };
}
