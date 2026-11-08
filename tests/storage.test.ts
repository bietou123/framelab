import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectStore } from '../electron/storage';
import { newProject } from '../shared/model';

async function store() {
  const directory = path.resolve('test-artifacts');
  await mkdir(directory, { recursive: true });
  return new ProjectStore(await mkdtemp(path.join(directory, 'storage-')));
}

test('clean exit restores an autosaved untitled project', async () => {
  const first = await store(); await first.init();
  const p = newProject(); p.name = 'Untitled edit';
  await first.autosave(p); await first.close();
  const next = new ProjectStore(first.root), state = await next.init();
  assert.equal(state.project.id, p.id); assert.equal(state.project.name, p.name);
  assert.equal(state.recovery, undefined); await next.close();
});

test('autosave does not invent an edit after an explicit project save', async () => {
  const first = await store(); await first.init();
  const p = await first.save(newProject(), path.join(first.root, 'saved.frameproj'));
  await first.autosave(p); await first.close();
  const next = new ProjectStore(first.root), state = await next.init();
  assert.equal(state.project.id, p.id); assert.equal(state.recovery, undefined);
  await next.close();
});

test('unclean exit offers the actual autosaved recovery version', async () => {
  const first = await store(); await first.init();
  const p = newProject(); p.name = 'Recover me'; await first.autosave(p);
  const next = new ProjectStore(first.root), state = await next.init();
  assert.equal(state.recovery?.id, p.id); assert.equal(state.recovery?.name, p.name);
  await next.close();
});

test('concurrent autosaves commit the newest snapshot last', async () => {
  const first = await store(); await first.init();
  const p = newProject(), a = first.autosave({ ...p, name: 'First' });
  const b = first.autosave({ ...p, name: 'Second' });
  await a; await b; await first.close();
  const saved = JSON.parse(await readFile(path.join(first.root, 'autosave.json'), 'utf8'));
  assert.equal(saved.name, 'Second');
});
