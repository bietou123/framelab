import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

export async function serveApp(request: Pick<Request, 'url' | 'method'>, directory: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'framelab:' || url.hostname !== 'app' || url.port || url.username || url.password) return new Response(null, { status: 403 });
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (/[\x00-\x1f\\:]/.test(pathname)) return new Response(null, { status: 403 });
    const root = path.resolve(directory), filename = path.resolve(root, `.${pathname}`), relative = path.relative(root, filename);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return new Response(null, { status: 403 });
    const type = types[path.extname(filename).toLowerCase()];
    if (!type) return new Response(null, { status: 404 });
    const info = await stat(filename);
    if (!info.isFile()) return new Response(null, { status: 404 });
    const headers = {
      'Content-Type': type, 'Content-Length': String(info.size), 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': path.extname(filename).toLowerCase() === '.html' ? 'no-store' : 'private, max-age=3600',
    };
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(await readFile(filename)), { headers });
  } catch { return new Response(null, { status: 404 }); }
}
