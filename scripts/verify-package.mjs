import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar');
const directory = path.join(root, 'release', 'win-unpacked');
const artifacts = path.join(root, 'test-artifacts');
await mkdir(artifacts, { recursive: true });
const work = await mkdtemp(path.join(artifacts, 'package-'));
const checks = [], checksums = {};
const passed = label => { checks.push(label); console.log(`PASS ${label}`); };
const digest = data => createHash('sha256').update(data).digest('hex');
async function hash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`${path.basename(executable)} exited ${code}: ${stderr}`)); });
  });
}
let failure;
try {
  for (const filename of ['FrameLab.exe', 'resources/app.asar', 'resources/native/ffmpeg.exe', 'resources/native/ffprobe.exe',
    'resources/native/FFmpeg-LICENSE.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'icudtl.dat', 'resources.pak']) {
    assert.ok((await stat(path.join(directory, filename))).size > 0, filename);
  }
  const executable = await open(path.join(directory, 'FrameLab.exe'), 'r');
  try { const header = Buffer.alloc(2); await executable.read(header, 0, 2, 0); assert.equal(header.toString(), 'MZ'); }
  finally { await executable.close(); }
  passed('Windows executable, runtime, native tools and license notices are present');

  const archive = path.join(directory, 'resources', 'app.asar');
  const extract = filename => asar.extractFile(archive, path.normalize(filename));
  const entries = asar.listPackage(archive).map(entry => entry.replaceAll('\\', '/'));
  assert.ok(!entries.some(entry => /(?:^|\/)(?:\.local-data|test-artifacts|VideoAssets)(?:\/|$)/i.test(entry) || /\.(?:mp4|mov|mp3|m4a|wav|flac|frameproj)$/i.test(entry)), 'Personal media or live application state must not ship');
  passed('Application archive excludes personal media, asset library and live state');

  const bundled = JSON.parse(extract('package.json').toString('utf8'));
  const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(bundled.version, source.version); assert.equal(bundled.main, 'dist-electron/main.js');
  for (const filename of ['dist-electron/main.js', 'dist-electron/preload.cjs', 'dist/index.html', 'README.md', 'TEST_REPORT.md', 'ARCHITECTURE.md', 'THIRD_PARTY.md', 'LICENSE']) {
    assert.equal(digest(extract(filename)), digest(await readFile(path.join(root, filename))), `Stale packaged file: ${filename}`);
  }
  for (const entry of entries.filter(entry => /^\/dist\/assets\/[^/]+\.(?:js|css)$/.test(entry))) {
    const filename = entry.slice(1);
    assert.equal(digest(extract(filename)), digest(await readFile(path.join(root, filename))), `Stale renderer asset: ${filename}`);
  }
  passed('Packaged main, preload, renderer and documentation match the current build');

  const main = extract('dist-electron/main.js').toString('utf8');
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.doesNotMatch(main, /appendSwitch\(["']no-sandbox["']/);
  passed('Production window config retains sandbox and isolation; static check is not secure-start acceptance');

  for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'FFmpeg-LICENSE.txt']) {
    const filename = path.join(directory, 'resources', 'native', name);
    const original = path.join(root, 'native', 'bin', name);
    checksums[name] = await hash(filename);
    assert.equal(checksums[name], await hash(original), `Native bundle mismatch: ${name}`);
  }
  checksums['FrameLab.exe'] = await hash(path.join(directory, 'FrameLab.exe'));
  checksums['app.asar'] = await hash(archive);
  passed('Native binaries and accompanying FFmpeg license match the pinned local tools');

  const output = path.join(work, 'bundled-native.mp4');
  await run(path.join(directory, 'resources/native/ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24',
    '-frames:v', '6', '-an', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', output]);
  const info = JSON.parse(await run(path.join(directory, 'resources/native/ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
  assert.equal(info.streams.length, 1); assert.equal(info.streams[0].width, 64); assert.equal(info.streams[0].height, 64);
  assert.equal(info.streams[0].r_frame_rate, '24/1'); assert.equal(Number(info.streams[0].nb_frames), 6);
  await run(path.join(directory, 'resources/native/ffmpeg.exe'), ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-']);
  passed('Bundled FFmpeg encodes and fully decodes real media; bundled FFprobe reads exact specifications');
} catch (error) {
  failure = error.stack || String(error);
  process.exitCode = 1;
  console.error(failure);
} finally {
  await writeFile(path.join(artifacts, 'package-results.json'), JSON.stringify({ at: new Date().toISOString(), mode: 'package-integrity-and-native-smoke',
    secureStartupVerified: false, directory, work, checks, checksums, failure }, null, 2));
}
