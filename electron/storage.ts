import { access, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AssetEntry, Project, RecentProject } from '../shared/types';
import { newProject } from '../shared/model';
import { validateProject } from '../shared/schema';
const defaultRoot = process.env.LOCALAPPDATA || process.env.USERPROFILE || process.cwd();
export const DEFAULT_DATA = path.join(defaultRoot, 'FrameLab', 'data');
export const DEFAULT_AUDIO = path.join(defaultRoot, 'FrameLab', 'audio');
export async function atomicJson(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.framelab-${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await rename(temp, filename);
}
async function readJson<T>(filename: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(filename, 'utf8')) as T; } catch { return fallback; }
}
export class ProjectStore {
  recent: RecentProject[] = [];
  readonly cache: string; readonly exports: string; readonly logs: string;
  private state: { recent: RecentProject[]; cleanExit: boolean; lastPath?: string } = { recent: [], cleanExit: true };
  private autosaves: Promise<void> = Promise.resolve();
  constructor(readonly root: string) { this.cache = path.join(root, 'cache'); this.exports = path.join(root, 'exports'); this.logs = path.join(root, 'logs'); }
  async init(): Promise<{ project: Project; recovery?: Project }> {
    for (const dir of [this.root, this.cache, this.exports, this.logs]) await mkdir(dir, { recursive: true });
    this.state = await readJson(path.join(this.root, 'state.json'), this.state);
    this.recent = this.state.recent;
    let project = newProject(), recovery: Project | undefined, opened = false;
    if (this.state.lastPath) { try { project = await this.open(this.state.lastPath); opened = true; } catch { /* Missing last project must not prevent startup. */ } }
    const auto = await readJson<Project | null>(path.join(this.root, 'autosave.json'), null);
    if (auto) {
      try {
        const valid = validateProject(auto);
        if (!this.state.cleanExit) recovery = valid;
        else if (!opened) project = valid;
        else if (Date.parse(valid.updatedAt) > Date.parse(project.updatedAt)) recovery = valid;
      } catch { /* Keep the damaged recovery file for diagnosis. */ }
    }
    this.state.cleanExit = false; await this.persist();
    return { project, recovery };
  }
  private async persist() { await atomicJson(path.join(this.root, 'state.json'), { ...this.state, recent: this.recent }); }
  async save(p: Project, filename: string): Promise<Project> {
    if (path.extname(filename).toLowerCase() !== '.frameproj') throw new Error('项目只能保存为 .frameproj，不能覆盖媒体文件');
    const next = validateProject({ ...p, path: path.resolve(filename), updatedAt: new Date().toISOString() });
    await atomicJson(next.path!, next);
    this.remember(next); await this.persist(); return next;
  }
  async open(filename: string): Promise<Project> {
    if (path.extname(filename).toLowerCase() !== '.frameproj') throw new Error('不是 FrameLab 项目文件');
    const p = validateProject(JSON.parse(await readFile(filename, 'utf8'))); p.path = path.resolve(filename);
    this.remember(p); await this.persist(); return p;
  }
  private remember(p: Project) {
    if (!p.path) return;
    this.state.lastPath = p.path;
    this.recent = [{ path: p.path, name: p.name, updatedAt: p.updatedAt }, ...this.recent.filter(r => r.path !== p.path)].slice(0, 20);
  }
  async autosave(p: Project) {
    const snapshot = validateProject(structuredClone(p));
    const pending = this.autosaves.catch(() => {}).then(() => atomicJson(path.join(this.root, 'autosave.json'), snapshot));
    this.autosaves = pending;
    await pending;
  }
  async close() { await this.autosaves; this.state.cleanExit = true; await this.persist(); }
}
export class AssetLibrary {
  constructor(readonly root: string) {}
  private entries: AssetEntry[] = [];
  async init(): Promise<AssetEntry[]> {
    await mkdir(this.root, { recursive: true });
    this.entries = await readJson<AssetEntry[]>(path.join(this.root, 'catalog.json'), []);
    return this.entries;
  }
  async add(filename: string, source: string, license: string, notes = ''): Promise<AssetEntry> {
    const extension = path.extname(filename).toLowerCase();
    if (!['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.opus', '.wma', '.aiff', '.mka'].includes(extension)) throw new Error('素材库仅接受音频文件');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    const id = hash.digest('hex');
    const existing = this.entries.find(e => e.id === id);
    if (existing) { await access(existing.path); return existing; }
    let target = path.join(this.root, path.basename(filename));
    try { await access(target); target = path.join(this.root, `${path.basename(filename, extension)}-${id.slice(0, 8)}${extension}`); } catch { /* The first target is free. */ }
    if (path.resolve(filename).toLowerCase() !== target.toLowerCase()) await copyFile(filename, target, 1);
    const entry: AssetEntry = { id, path: target, name: path.basename(target), source: source.slice(0, 10000), license: license.slice(0, 2000), notes: notes.slice(0, 10000), addedAt: new Date().toISOString() };
    this.entries.push(entry); await atomicJson(path.join(this.root, 'catalog.json'), this.entries); return entry;
  }
  async list(): Promise<AssetEntry[]> { return [...this.entries]; }
}
