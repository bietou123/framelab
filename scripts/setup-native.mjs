import { mkdir, readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import https from 'node:https';
function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FrameLab-native-setup/0.1' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
        response.resume();
        resolve(request(new URL(response.headers.location, url).href, redirects + 1));
      } else if (response.statusCode === 200) resolve(response);
      else { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); }
    });
    req.setTimeout(90000, () => req.destroy(new Error('Download timeout')));
    req.on('error', reject);
  });
}
const root = path.resolve(process.env.FRAMELAB_NATIVE_ROOT || 'native');
await mkdir(root, { recursive: true });
const version = '8.0.1';
const url = `https://github.com/GyanD/codexffmpeg/releases/download/${version}/ffmpeg-${version}-essentials_build.zip`;
const expected = 'e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673';
const zip = path.join(root, 'ffmpeg-release-essentials.zip');
const response = await request(url);
let received = 0;
let last = Date.now();
const total = Number(response.headers['content-length'] || 0);
const stream = response;
stream.on('data', b => { received += b.length; if (Date.now() - last > 1500) { console.log(`Native FFmpeg download: ${received}/${total} bytes (${total ? (received * 100 / total).toFixed(1) : '?'}%)`); last = Date.now(); } });
await pipeline(stream, createWriteStream(zip));
const hash = createHash('sha256');
for await (const b of createReadStream(zip)) hash.update(b);
const sha256 = hash.digest('hex');
if (expected !== sha256) throw new Error(`SHA256 mismatch: ${sha256}`);
await writeFile(path.join(root, 'source.json'), JSON.stringify({ url, sha256, downloadedAt: new Date().toISOString() }, null, 2));
const extracted = path.join(root, 'distribution', version);
await new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:FRAMELAB_ZIP -DestinationPath $env:FRAMELAB_NATIVE_EXTRACT -Force'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, FRAMELAB_ZIP: zip, FRAMELAB_NATIVE_EXTRACT: extracted } });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Expand-Archive: ${code}`)));
});
const { readdir } = await import('node:fs/promises');
const folder = (await readdir(extracted)).find(n => n.startsWith('ffmpeg-'));
if (!folder) throw new Error('Unexpected distribution structure');
const bin = path.join(root, 'bin');
await mkdir(bin, { recursive: true });
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) await copyFile(path.join(extracted, folder, 'bin', name), path.join(bin, name));
const license = await readFile(path.join(extracted, folder, 'LICENSE'));
await writeFile(path.join(bin, 'FFmpeg-LICENSE.txt'), license);
console.log(`Native tools installed: ${bin}; verified ${sha256}; ${(await stat(zip)).size} bytes`);
