import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serveApp } from '../electron/app-protocol';

async function fixture() {
  const artifacts = path.resolve('test-artifacts'); await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(path.join(artifacts, 'app-protocol-'));
  const root = path.join(directory, 'dist'); await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>FrameLab</title>');
  await writeFile(path.join(root, 'assets', 'app.js'), 'export const ready = true;');
  await writeFile(path.join(directory, 'private.json'), '{"secret":true}');
  return root;
}

test('local app protocol serves the real bundle and HEAD with correct MIME types', async () => {
  const root = await fixture();
  const html = await serveApp(new Request('framelab://app/'), root);
  assert.equal(html.status, 200); assert.match(html.headers.get('content-type')!, /^text\/html/);
  assert.match(await html.text(), /FrameLab/);
  const js = await serveApp(new Request('framelab://app/assets/app.js'), root);
  assert.equal(js.status, 200); assert.match(js.headers.get('content-type')!, /^text\/javascript/);
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
  const head = await serveApp(new Request('framelab://app/assets/app.js', { method: 'HEAD' }), root);
  assert.equal(await head.text(), ''); assert.ok(Number(head.headers.get('content-length')) > 0);
});

test('local app protocol rejects traversal, other origins, invalid escapes and writes', async () => {
  const root = await fixture();
  for (const url of ['framelab://local/index.html', 'https://app/index.html', 'framelab://user@app/index.html',
    'framelab://app/..%2fprivate.json', 'framelab://app/%5c..%5cprivate.json', 'framelab://app/C:%5cprivate.json',
    'framelab://app/%00index.html', 'framelab://app/%zz', 'framelab://app/missing.js']) {
    const response = await serveApp({ url, method: 'GET' }, root);
    assert.ok(response.status >= 400, url); assert.ok(!(await response.text()).includes('secret'), url);
  }
  assert.equal((await serveApp(new Request('framelab://app/index.html', { method: 'POST' }), root)).status, 405);
});
