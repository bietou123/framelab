import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron, chromium, type Browser, type ElectronApplication, type Page, type Locator } from 'playwright';
import sharp from 'sharp';
import { locateNative } from '../electron/native';
import { ffmpeg } from '../electron/runner';
import type { Job, Project } from '../shared/types';
import { rendererHost } from './renderer-host';

const root = path.resolve('test-artifacts'); await mkdir(root, { recursive: true });
const work = await mkdtemp(path.join(root, 'e2e-')), tools = await locateNative();
const first = path.join(work, '片段 1 [原片] 59.94.mp4');
const second = path.join(work, "clip's two HEVC.mp4"), music = path.join(work, '配乐.wav');
for (const [file, frames, codec] of [[first, '240', 'libx264'], [second, '120', 'libx265']] as const) {
  await ffmpeg(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60000/1001', '-frames:v', frames, '-an', '-c:v', codec, '-preset', 'ultrafast', '-threads', '2', ...(codec === 'libx265' ? ['-x265-params', 'pools=2:log-level=error'] : []), '-pix_fmt', 'yuv420p', file]);
}
await ffmpeg(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.2', '-af', 'adelay=150:all=1,apad=pad_dur=0.15', '-ac', '2', music]);
const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const originals = [await hash(first), await hash(second), await hash(music)];
const checks: string[] = [], errors: string[] = [], consoleErrors: string[] = [], processLogs: string[] = [];
const screenshots: { width: number; height: number; zoom: number; deviceScaleFactor: number; pixelWidth: number; pixelHeight: number }[] = [];
function passed(label: string) { checks.push(label); console.log(`PASS ${label}`); }
const browserMode = process.argv.includes('--renderer');
const diagnostic = process.argv.includes('--diagnostic');
const softwareRenderer = process.argv.includes('--software-renderer');
const packaged = Boolean(process.env.FRAMELAB_E2E_EXECUTABLE);
assert.ok(!browserMode || !diagnostic, 'Renderer and Electron diagnostic modes must remain separate');
assert.ok(!softwareRenderer || (!browserMode && !diagnostic), 'Software rendering must retain the Electron sandbox');
const mode = browserMode ? 'renderer-native-services' : diagnostic ? 'electron-diagnostic-no-sandbox' : softwareRenderer ? 'electron-software-renderer' : packaged ? 'electron-packaged' : 'electron';
const resultPath = path.join(root, browserMode ? 'renderer-results.json' : diagnostic ? 'e2e-diagnostic-results.json' : softwareRenderer ? 'e2e-software-results.json' : packaged ? 'e2e-packaged-results.json' : 'e2e-results.json');
async function startupLogs() {
  const directory = path.join(work, 'profile', 'logs');
  const files = await readdir(directory).catch(() => [] as string[]);
  return Promise.all(files.filter(name => name.startsWith('startup-') && name.endsWith('.jsonl')).map(async name => ({ file: name, text: await readFile(path.join(directory, name), 'utf8') })));
}
let desktop: ElectronApplication | undefined, page: Page | undefined, browser: Browser | undefined;
let testBrowser: { executable: string; version: string } | undefined;
let host: Awaited<ReturnType<typeof rendererHost>> | undefined;
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'));
env.FRAMELAB_TEST = '1'; env.FRAMELAB_DATA_DIR = path.join(work, 'profile'); env.FRAMELAB_AUDIO_DIR = path.join(work, 'library');
delete env.NODE_PATH; delete env.FRAMELAB_DEV_URL;
delete env.FRAMELAB_SOFTWARE_RENDERING;
if (softwareRenderer) env.FRAMELAB_SOFTWARE_RENDERING = '1';
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await read(); if (accepts(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}; ${JSON.stringify(last).slice(-1500)}`);
}
const project = () => page!.evaluate(async () => (await window.framelab.bootstrap()).project);
const jobs = () => page!.evaluate(async () => (await window.framelab.bootstrap()).jobs);
const waitProject = (accepts: (p: Project) => boolean, label: string) => until(project, accepts, label);
async function filesDialog(files: string[]) {
  if (host) { host.open(files); return; }
  await desktop!.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog;
  }, files);
}
async function saveDialog(filename: string) {
  if (host) { host.save(filename); return; }
  await desktop!.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog; }, filename);
}
async function range(locator: Locator, value: number) {
  await locator.evaluate((element, n) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(n));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function number(label: string, value: number) {
  const input = page!.getByRole('spinbutton', { name: label, exact: true });
  await input.fill(String(value)); await input.press('Tab');
}
async function imagePixels(buffer: Buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let colorful = 0;
  for (let i = 0; i < data.length; i += info.channels * 5) {
    if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 35) colorful++;
  }
  return { colorful, hash: createHash('sha256').update(buffer).digest('hex') };
}
async function pixels() {
  return imagePixels(await page!.locator('.preview-content').screenshot());
}
try {
  if (browserMode) {
    host = await rendererHost(work, tools);
    const candidates = process.env.FRAMELAB_TEST_BROWSER ? [process.env.FRAMELAB_TEST_BROWSER] : [chromium.executablePath(),
      ...(process.platform === 'win32' ? [
        path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      ] : [])];
    let executablePath: string | undefined;
    for (const candidate of candidates) if ((await stat(candidate).catch(() => null))?.isFile()) { executablePath = candidate; break; }
    assert.ok(executablePath, 'Install a Playwright browser or set FRAMELAB_TEST_BROWSER to an installed Chromium browser');
    browser = await chromium.launch({ headless: true, executablePath, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'], timeout: 30000 });
    testBrowser = { executable: executablePath, version: browser.version() };
    page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await host.connect(page);
  } else {
    const executablePath = process.env.FRAMELAB_E2E_EXECUTABLE || path.resolve('node_modules/electron/dist/electron.exe');
    // Diagnostic-only flags do not alter the production window's sandbox settings.
    desktop = await _electron.launch({ executablePath, args: [...(packaged ? [] : [path.resolve('.')]), '--mute-audio', ...(diagnostic ? ['--no-sandbox', '--disable-gpu'] : [])], cwd: path.resolve('.'), env, timeout: 120000 });
    for (const stream of [desktop.process().stdout, desktop.process().stderr]) stream?.on('data', data => { const line = String(data); if (processLogs.length < 2000) processLogs.push(line); console.log(line.trimEnd()); });
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  }
  page.on('crash', () => errors.push('Renderer process crashed'));
  page.setDefaultTimeout(30000);
  await page.locator('.editor').waitFor({ timeout: 120000 });
  if (desktop) {
    const security = await desktop.evaluate(({ app, BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0], bounds = w.getBounds();
      return { sandbox: app.getAppMetrics().find(p => p.pid === w.webContents.getOSProcessId())?.sandboxed,
        bypassed: process.argv.includes('--no-sandbox'), offscreen: screen.getAllDisplays().every(({ bounds: d }) => bounds.x + bounds.width <= d.x || bounds.x >= d.x + d.width || bounds.y + bounds.height <= d.y || bounds.y >= d.y + d.height) };
    });
    assert.ok(security.offscreen, 'Test window must not overlap a real display');
    assert.equal(security.sandbox, !diagnostic, 'Check actual OS-level renderer sandbox');
    assert.equal(security.bypassed, diagnostic);
    assert.equal(await page.evaluate(() => typeof (window as any).require === 'undefined' && typeof (window as any).process === 'undefined'), true, 'Renderer must not have Node integration');
  }
  await page.evaluate(() => {
    (window as any).__jobEvents = [];
    window.framelab.onEvent(event => { if (event.type === 'job') (window as any).__jobEvents.push({ id: event.job.id, stage: event.job.stage, percent: event.job.percent, speed: event.job.speed, bytes: event.job.bytes, passed: event.job.validation?.passed }); });
  });
  passed(browserMode ? 'headless renderer with actual native services (not Electron startup)' : diagnostic ? 'offscreen Electron IPC diagnostic (sandbox bypassed; not secure startup acceptance)' : softwareRenderer ? 'offscreen secure Electron window with software UI rendering' : 'offscreen secure native Electron window');
  await filesDialog([first, second, music]);
  await page.locator('.media-panel .panel-heading').getByRole('button', { name: '导入媒体', exact: true }).click();
  await until(() => page!.getByTestId('media-item').count(), n => n === 3, 'real media import');
  const imported = await waitProject(p => p.media.length === 3, 'import autosave');
  assert.equal(imported.media[0].video?.fps, '60000/1001');
  assert.equal(imported.media[1].video?.codec, 'hevc');
  await page.getByTestId('media-item').nth(0).click();
  await until(pixels, p => p.colorful > 100, 'nonblank real source preview');
  passed('batch import, native metadata, real source pixels');

  await page.getByTestId('media-item').nth(1).click();
  await page.waitForFunction(() => document.querySelector('.hidden-media video')?.getAttribute('src')?.includes('.proxy.mp4'), undefined, { timeout: 30000 });
  await until(pixels, p => p.colorful > 100, 'HEVC proxy pixels');
  passed('HEVC compatible proxy with visible pixels');

  await page.getByTestId('media-item').nth(0).click();
  await page.getByTestId('media-item').nth(1).click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: '添加选中素材到时间线', exact: true }).click();
  let p = await waitProject(p => p.tracks[0].clips.length === 2, 'ordered append');
  assert.equal(p.width, 320); assert.equal(p.fps, '60000/1001');
  assert.equal(p.tracks[0].clips[0].assetId, imported.media[0].id);
  const firstId = p.tracks[0].clips[0].id;
  const clip = () => page!.locator(`[data-clip-id="${firstId}"]`);
  await clip().click({ position: { x: 20, y: 12 } });
  await page.getByRole('button', { name: '片段向后排序', exact: true }).click();
  p = await waitProject(p => p.tracks[0].clips[1].id === firstId, 'reorder');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await waitProject(p => p.tracks[0].clips[0].id === firstId, 'undo reorder');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await waitProject(p => p.tracks[0].clips[1].id === firstId, 'redo reorder');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  p = await waitProject(p => p.tracks[0].clips[0].id === firstId, 'restore order');
  passed('ordered splice, undo and redo');

  await page.getByRole('button', { name: '吸附', exact: true }).click();
  const box = (await clip().boundingBox())!, pixelsPerSecond = box.width / p.tracks[0].clips[0].duration;
  await page.mouse.move(box.x + box.width / 2, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + pixelsPerSecond * 0.5, box.y + 30, { steps: 8 }); await page.mouse.up();
  await waitProject(p => p.tracks[0].clips.find(c => c.id === firstId)!.start > 0.4, 'drag move');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await waitProject(p => p.tracks[0].clips.find(c => c.id === firstId)!.start === 0, 'undo move');
  passed('pointer drag move');

  const edge = clip().locator('.trim-handle.right'), edgeBox = (await edge.boundingBox())!;
  await page.mouse.move(edgeBox.x + 2, edgeBox.y + 30); await page.mouse.down();
  await page.mouse.move(edgeBox.x - pixelsPerSecond * 0.5, edgeBox.y + 30, { steps: 8 }); await page.mouse.up();
  await waitProject(p => p.tracks[0].clips.find(c => c.id === firstId)!.duration < 3.6, 'trim out');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await waitProject(p => p.tracks[0].clips.find(c => c.id === firstId)!.duration > 4, 'undo trim');
  passed('pointer trim and source bounds');

  await clip().click({ position: { x: 20, y: 12 } });
  await range(page.getByLabel('预览位置', { exact: true }), 1);
  await page.getByRole('button', { name: '在播放头处分割', exact: true }).click();
  await waitProject(p => p.tracks[0].clips.length === 3, 'split');
  await page.getByRole('button', { name: '删除选中片段', exact: true }).click();
  await waitProject(p => p.tracks[0].clips.length === 2, 'delete');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await waitProject(p => p.tracks[0].clips.length === 3, 'undo delete');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await waitProject(p => p.tracks[0].clips.length === 2, 'undo split');
  passed('split, delete, undo source mapping');

  await clip().click({ position: { x: 20, y: 12 } });
  await page.getByRole('button', { name: '锁定轨道 V1', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '删除选中片段', exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('播放速度', { exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '解锁轨道 V1', exact: true }).click();
  await page.getByRole('button', { name: '轨道 V1 隐藏', exact: true }).click();
  await page.locator('.preview-empty').waitFor();
  await page.getByRole('button', { name: '轨道 V1 隐藏', exact: true }).click();
  await page.getByRole('button', { name: '添加缩放关键帧', exact: true }).click();
  await waitProject(p => Boolean(p.tracks[0].clips[0].effects.keys.scale?.length), 'scale keyframe');
  passed('lock, hide and keyframe controls');

  await page.getByTestId('media-item').nth(2).click();
  await page.getByRole('button', { name: '设为全片配乐', exact: true }).click();
  p = await waitProject(p => p.tracks[1].clips.length === 1, 'finite soundtrack');
  assert.ok(p.tracks[1].clips[0].loop && p.tracks[1].clips[0].coverProject);
  assert.ok(Math.abs(p.tracks[1].clips[0].duration - 6.006) < 0.02);
  await page.getByRole('button', { name: '轨道 A1 静音', exact: true }).click();
  await waitProject(p => p.tracks[1].muted, 'track mute');
  await page.getByRole('button', { name: '轨道 A1 静音', exact: true }).click();
  passed('finite full soundtrack and mute');

  await page.locator('.app-menu > summary').filter({ hasText: '字幕' }).click();
  await page.locator('.app-menu[open]').getByRole('button', { name: '新建字幕', exact: true }).click();
  await page.getByLabel('字幕文字', { exact: true }).fill('本地字幕测试');
  await page.getByLabel('字幕文字', { exact: true }).press('Tab');
  p = await waitProject(p => p.tracks[2].clips[0]?.text === '本地字幕测试', 'subtitle edit');
  const srt = path.join(work, 'edited.srt');
  await saveDialog(srt);
  await page.locator('.inspector-panel').getByRole('button', { name: '导出 SRT', exact: true }).click();
  await until(() => readFile(srt, 'utf8').catch(() => ''), value => value.includes('本地字幕测试'), 'SRT export');
  passed('subtitle editing and native SRT export');

  const saved = path.join(work, '编辑项目.frameproj');
  await saveDialog(saved);
  await page.getByRole('button', { name: '保存项目', exact: true }).first().click();
  await until(() => readFile(saved, 'utf8').catch(() => ''), value => value.includes('本地字幕测试'), 'save project');
  passed('native project save and autosave');

  const output = path.join(work, 'UI export under4MB.mp4');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByLabel('输出文件路径', { exact: true }).fill(output);
  await page.getByLabel('导出编码', { exact: true }).selectOption('h264');
  await page.getByLabel('编码器', { exact: true }).selectOption('software');
  await number('最大体积', 0.004);
  await page.getByRole('button', { name: '均衡', exact: true }).click();
  await page.getByRole('button', { name: '加入导出队列', exact: true }).click();
  const done = await until(jobs, js => js.some(j => j.output === output && ['failed', 'completed'].includes(j.stage)), 'actual export', 120000);
  const job = done.find(j => j.output === output)!;
  assert.equal(job.stage, 'completed', job.error); assert.ok(job.validation?.passed && job.validation.decoded);
  assert.ok(job.bytes < 4000000); assert.equal(job.validation.frames, 360);
  assert.ok(job.validation.audioEnd >= 5.98);
  const events = await until(() => page!.evaluate(() => (window as any).__jobEvents as { id: string; stage: string; passed?: boolean }[]),
    events => events.some(e => e.id === job.id && e.stage === 'completed'), 'verified completion event');
  for (const stage of ['preparing', 'encoding', 'packaging', 'verifying', 'completed']) assert.ok(events.some(e => e.id === job.id && e.stage === stage), stage);
  assert.ok(events.filter(e => e.stage === 'completed').every(e => e.passed === true));
  await page.getByTestId('job-row').first().locator('.validation-details > summary').click();
  await page.screenshot({ path: path.join(work, 'export-verified.png') });
  await page.getByRole('dialog', { name: '导出', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  passed('real encoding, packaging, verification, audio coverage, exact frames and size');

  await clip().scrollIntoViewIfNeeded(); await clip().click({ position: { x: 20, y: 12 } });
  await page.getByLabel('定格画面', { exact: true }).check();
  await number('片段时长', 120);
  await waitProject(p => p.tracks[0].clips[0].duration > 119, 'long freeze for cancellation');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const cancelOutput = path.join(work, 'cancelled.mp4');
  await page.getByLabel('输出文件路径', { exact: true }).fill(cancelOutput);
  await page.getByLabel('导出编码', { exact: true }).selectOption('h264');
  await page.getByLabel('编码器', { exact: true }).selectOption('software');
  await page.getByRole('button', { name: '加入导出队列', exact: true }).click();
  await page.getByTestId('job-row').first().getByRole('button', { name: '取消', exact: true }).click();
  await until(jobs, js => js.some(j => j.output === cancelOutput && j.stage === 'cancelled'), 'cancel cleanup', 30000);
  await assert.rejects(stat(cancelOutput));
  await page.getByRole('dialog', { name: '导出', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await waitProject(p => p.tracks[0].clips[0].duration < 5 && p.tracks[0].clips[0].freeze === null, 'restore cancelled edits');
  passed('cancel native job without a final partial file');

  await range(page.getByLabel('预览位置', { exact: true }), 1.5);
  await until(pixels, value => value.colorful > 100, 'timeline pixels');
  const before = await pixels();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await until(pixels, value => value.colorful > 100 && value.hash !== before.hash, 'moving preview');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  passed('nonblank moving timeline preview');
  const emulation = await page.context().newCDPSession(page);
  for (const [width, height, zoom] of [[1480, 960, 1], [1100, 740, 1], [820, 620, 1], [1140, 870, 1.5], [390, 844, 1]] as const) {
    // These are explicit renderer viewport checks, not native Windows resizing.
    const viewport = { width: Math.round(width / zoom), height: Math.round(height / zoom) };
    await page.setViewportSize(viewport);
    await emulation.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: zoom, mobile: false });
    await until(() => page!.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })),
      r => r.w === viewport.width && r.h === viewport.height && r.dpr === zoom, 'viewport and pixel density');
    const geometry = await page.evaluate(() => {
      const bounds = ['.preview-content', '.header-tools', '.brand', '.timeline-panel'].map(selector => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
      });
      return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scroll: document.documentElement.scrollWidth, canvas: bounds[0], header: bounds[1], brand: bounds[2], timeline: bounds[3] };
    });
    assert.ok(geometry.scroll <= geometry.w + 1, JSON.stringify(geometry));
    assert.ok(geometry.canvas.w > 100 && geometry.canvas.h > 65, JSON.stringify(geometry));
    assert.ok(geometry.canvas.x >= 0 && geometry.canvas.y >= 0 && geometry.canvas.right <= geometry.w + 1 && geometry.canvas.bottom <= geometry.h + 1, JSON.stringify(geometry));
    assert.ok(geometry.header.right <= geometry.w + 1 && geometry.header.x >= geometry.brand.right, JSON.stringify(geometry));
    assert.ok(geometry.timeline.bottom <= geometry.h, JSON.stringify(geometry));
    // Capture directly so Playwright cannot restore the context's default DPI.
    const captured = await emulation.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 } });
    const screenshot = Buffer.from(captured.data, 'base64');
    const dimensions = await sharp(screenshot).metadata();
    assert.equal(dimensions.width, width, 'Screenshot must match the actual tested pixel width');
    assert.equal(dimensions.height, height, 'Screenshot must match the actual tested pixel height');
    const left = Math.floor(geometry.canvas.x * zoom), top = Math.floor(geometry.canvas.y * zoom);
    const preview = await sharp(screenshot).extract({ left, top, width: Math.floor(geometry.canvas.right * zoom) - left,
      height: Math.floor(geometry.canvas.bottom * zoom) - top }).png().toBuffer();
    assert.ok((await imagePixels(preview)).colorful > 100, 'resize retains real media pixels');
    await writeFile(path.join(work, `workbench-${width}-${height}-${zoom}.png`), screenshot);
    screenshots.push({ width, height, zoom, deviceScaleFactor: geometry.dpr, pixelWidth: dimensions.width!, pixelHeight: dimensions.height! });
  }
  await emulation.detach();
  passed('emulated renderer viewports and 150 percent DPI screenshots with exact pixel dimensions');
  // 原生 Windows 窗口缩放：上面那段是 renderer 视口模拟，不能代表真窗口。
  // 这里直接调 BrowserWindow.setContentSize，验证①窗口真的接受了新尺寸②renderer 的
  // innerWidth/innerHeight 跟着变③没有横向溢出④截图的实际像素尺寸 = 逻辑尺寸 × DPR。
  // 只在有真实 Electron 窗口且没走诊断绕过时做；窗口始终留在屏幕外。
  const nativeResizes: { width: number; height: number; devicePixelRatio: number; pixelWidth: number; pixelHeight: number }[] = [];
  const nativeWindowResizingVerified = Boolean(desktop) && !diagnostic;
  if (desktop && !diagnostic) {
    // 实测：这个 Electron 版本在 Windows 上 getContentSize() 返回的是**窗口**尺寸
    // （setContentSize(1180,800) → getSize/getContentSize/innerWidth 全是 1196x839）。
    // 所以验收以窗口几何 + renderer 同步为准：边框偏移在一次会话内恒定，且渲染器
    // 的 innerWidth/innerHeight 必须精确等于窗口宽高。
    const initial = await desktop.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0].getBounds(); return { w: b.width, h: b.height }; });
    // page.screenshot() 会沿用 Playwright 记录的模拟视口（上一段留下 390 宽），必须直连 CDP。
    const nativeCdp = await page!.context().newCDPSession(page!);
    let frame: { w: number; h: number } | undefined;
    for (const [width, height] of [[1180, 800], [900, 680], [1480, 960]] as const) {
      // setContentSize 在 Windows 上是异步的（走 WM_SIZE），必须轮询确认窗口真的换了尺寸。
      await desktop.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]); }, [width, height]);
      const applied: { w: number; h: number; offscreen: boolean } = await until(
        () => desktop!.evaluate(({ BrowserWindow, screen }) => {
          const win = BrowserWindow.getAllWindows()[0]; const b = win.getBounds();
          return { w: b.width, h: b.height, offscreen: screen.getAllDisplays().every(({ bounds: d }) => b.x + b.width <= d.x || b.x >= d.x + d.width || b.y + b.height <= d.y || b.y >= d.y + d.height) };
        }),
        r => r.w !== initial.w && r.h !== initial.h && r.w > width,
        `native window resize ${width}x${height}`);
      const delta = { w: applied.w - width, h: applied.h - height };
      frame ??= delta;
      assert.deepEqual(delta, frame, `Window frame offset must stay constant at ${width}x${height}; ${JSON.stringify(applied)}`);
      assert.ok(delta.w >= 0 && delta.h >= 0 && delta.w < 64 && delta.h < 96, `Implausible frame offset ${JSON.stringify(delta)}`);
      assert.ok(applied.offscreen, 'Resized test window must stay off every display');
      const view = await until(() => page!.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })),
        r => r.w === applied.w && r.h === applied.h, `renderer follows native window ${width}x${height}`);
      // 注意：这里不能定义具名的局部函数——tsx/esbuild 的 keepNames 会给它注入
      // __name(...)，而该 helper 在 renderer 上下文里不存在，evaluate 会直接抛 ReferenceError。
      const geometry = await page.evaluate(() => ({
        w: innerWidth,
        h: innerHeight,
        scroll: document.documentElement.scrollWidth,
        canvas: document.querySelector('.preview-content')!.getBoundingClientRect().toJSON(),
        header: document.querySelector('.header-tools')!.getBoundingClientRect().toJSON(),
        brand: document.querySelector('.brand')!.getBoundingClientRect().toJSON(),
        timeline: document.querySelector('.timeline-panel')!.getBoundingClientRect().toJSON()
      }));
      assert.ok(geometry.scroll <= geometry.w + 1, JSON.stringify(geometry));
      assert.ok(geometry.canvas.width > 100 && geometry.canvas.height > 65, JSON.stringify(geometry));
      assert.ok(geometry.canvas.x >= 0 && geometry.canvas.y >= 0 && geometry.canvas.right <= geometry.w + 1 && geometry.canvas.bottom <= geometry.h + 1, JSON.stringify(geometry));
      assert.ok(geometry.header.right <= geometry.w + 1 && geometry.header.x >= geometry.brand.right, JSON.stringify(geometry));
      assert.ok(geometry.timeline.bottom <= geometry.h + 1, JSON.stringify(geometry));
      const captured = await nativeCdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      const shot: Buffer = Buffer.from((captured as unknown as { data: string }).data, 'base64');
      const dimensions: sharp.Metadata = await sharp(shot).metadata();
      assert.equal(dimensions.width, Math.round(view.w * view.dpr), 'Native resize screenshot width must match renderer width × DPR');
      assert.equal(dimensions.height, Math.round(view.h * view.dpr), 'Native resize screenshot height must match renderer height × DPR');
      await writeFile(path.join(work, `native-resize-${width}x${height}.png`), shot);
      nativeResizes.push({ width, height, devicePixelRatio: view.dpr, pixelWidth: dimensions.width!, pixelHeight: dimensions.height! });
    }
    passed('native Windows window resizing');
  }
  assert.deepEqual([await hash(first), await hash(second), await hash(music)], originals);
  assert.deepEqual(errors, []); assert.equal(await page.getByRole('dialog', { name: '处理提示', exact: true }).count(), 0);
  passed('byte-identical sources and no renderer exceptions');
  await writeFile(resultPath, JSON.stringify({ at: new Date().toISOString(), mode, secureStartupVerified: !browserMode && !diagnostic, nativeWindowResizingVerified, nativeResizes, testBrowser, screenshots, directory: work, checks, errors, consoleErrors, processLogs, startupLogs: await startupLogs(), job }, null, 2));
  console.log(`PASS ${mode}: ${checks.length} checks; screenshots: ${work}`);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => {}); const html = await page.content().catch(() => 'Page closed before diagnostics'); await writeFile(path.join(work, 'failure.html'), html).catch(() => {}); }
  await writeFile(resultPath, JSON.stringify({ at: new Date().toISOString(), mode, secureStartupVerified: false, nativeWindowResizingVerified: false, testBrowser, screenshots, directory: work, checks, errors, consoleErrors, processLogs, startupLogs: await startupLogs(), failure: String(error) }, null, 2));
  throw error;
} finally { await desktop?.close(); await browser?.close(); await host?.close(); }
