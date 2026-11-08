import type { Clip, Effects, ExportSettings, Key, KeyProperty, Media, Project, Rational, Track } from './types';
export function uid(): string { return crypto.randomUUID(); }
export const defaultEffects = (): Effects => ({
  crop: { left: 0, top: 0, right: 0, bottom: 0 }, rotation: 0, mirrorX: false, mirrorY: false,
  x: 0, y: 0, scale: 1, opacity: 1, exposure: 0, contrast: 1, saturation: 1, temperature: 0, lut: null,
  volumeDb: 0, fadeIn: 0, fadeOut: 0, denoise: false, keys: {},
});
export function newTrack(kind: Track['kind'], name?: string): Track {
  return { id: uid(), kind, name: name || ({ video: '视频', audio: '音频', subtitle: '字幕' }[kind]), locked: false, muted: false, hidden: false, clips: [] };
}
export function newProject(): Project {
  return { version: 1, id: uid(), name: '未命名项目', updatedAt: new Date().toISOString(), width: 1920, height: 1080, fps: '30000/1001', media: [],
    tracks: [newTrack('video', 'V1'), newTrack('audio', 'A1'), newTrack('subtitle', 'S1')], includeSourceAudio: true,
    subtitleStyle: { font: 'Microsoft YaHei', size: 48, color: '#ffffff', outline: '#000000', outlineWidth: 2, position: 'bottom' } };
}
export const fpsValue = (fps: string): number => {
  const [n, d] = fps.split('/').map(Number);
  return Number.isFinite(n) && Number.isFinite(d) && n > 0 && d > 0 ? n / d : 0;
};
export const snapFrame = (t: number, fps: Rational): number => Math.max(0, Math.round(t * fpsValue(fps)) / fpsValue(fps));
export const projectDuration = (p: Project): number => Math.max(0, ...p.tracks.filter(t => !t.hidden && t.kind === 'video').flatMap(t => t.clips.map(c => c.start + c.duration)), ...p.tracks.filter(t => !t.hidden && t.kind === 'subtitle').flatMap(t => t.clips.map(c => c.start + c.duration)));
export const clipEnd = (c: Clip): number => c.start + c.duration;
export function mediaClip(media: Media, start = 0, duration?: number): Clip {
  return { id: uid(), assetId: media.id, name: media.name, start, duration: duration ?? media.duration, sourceStart: 0, rate: 1, reverse: false, freeze: null,
    effects: defaultEffects(), transition: { type: 'none', duration: 0 }, loop: false, crossfade: 3, trimSilence: false };
}
export function appendMedia(p: Project, media: Media, asMusic = false): Project {
  const next = structuredClone(p);
  if (!next.media.some(m => m.id === media.id)) next.media.push(media);
  const kind = media.kind === 'audio' ? 'audio' : 'video';
  let track = next.tracks.find(t => t.kind === kind && !t.locked);
  if (!track) { track = newTrack(kind); next.tracks.push(track); }
  const start = Math.max(0, ...track.clips.map(clipEnd));
  const clip = mediaClip(media, asMusic ? 0 : start, asMusic ? Math.max(projectDuration(p), media.duration) : undefined);
  if (asMusic) { clip.loop = true; clip.coverProject = true; clip.trimSilence = true; clip.effects.fadeIn = 0.1; clip.effects.fadeOut = 0.4; clip.effects.volumeDb = -1.5; }
  track.clips.push(clip);
  if (kind === 'video' && !p.tracks.some(t => t.kind === 'video' && t.clips.length) && media.video) {
    const rotation = media.video.rotation || 0;
    next.width = Math.abs(rotation) === 90 ? media.video.height! : media.video.width!;
    next.height = Math.abs(rotation) === 90 ? media.video.width! : media.video.height!;
    if (media.video.fps && fpsValue(media.video.fps)) next.fps = media.video.fps;
  }
  return next;
}
export function reorder(p: Project, trackId: string, ids: string[]): Project {
  const next = structuredClone(p);
  const track = next.tracks.find(t => t.id === trackId);
  if (!track || track.locked) return p;
  const clips = ids.map(id => track.clips.find(c => c.id === id)).filter((c): c is Clip => Boolean(c));
  if (clips.length !== track.clips.length || new Set(ids).size !== ids.length) return p;
  let end = 0;
  for (const c of clips) {
    const overlap = end > 0 && c.transition.type !== 'none' ? Math.min(c.transition.duration, c.duration / 2, clips[clips.indexOf(c) - 1].duration / 2) : 0;
    c.start = snapFrame(Math.max(0, end - overlap), next.fps);
    c.transition.duration = overlap;
    end = c.start + c.duration;
  }
  track.clips = clips;
  return next;
}
export function splitClip(p: Project, id: string, time: number): Project {
  const next = structuredClone(p);
  for (const track of next.tracks) {
    const index = track.clips.findIndex(c => c.id === id);
    if (index < 0 || track.locked) continue;
    const c = track.clips[index];
    const t = snapFrame(time, p.fps) - c.start;
    if (t < 1 / fpsValue(p.fps) || c.duration - t < 1 / fpsValue(p.fps)) return p;
    const right = structuredClone(c);
    right.id = uid(); right.start = c.start + t; right.duration -= t;
    if (!c.reverse) right.sourceStart += t * c.rate;
    else c.sourceStart += right.duration * c.rate;
    right.transition = { type: 'none', duration: 0 };
    for (const property of Object.keys(c.effects.keys) as (keyof Effects['keys'])[]) {
      const keys = c.effects.keys[property]!;
      const current = evaluateKeys(keys, t, c.effects[property]);
      c.effects.keys[property] = [...keys.filter(k => k.at < t), { at: t, value: current }];
      right.effects.keys[property] = [{ at: 0, value: current }, ...keys.filter(k => k.at > t).map(k => ({ at: k.at - t, value: k.value }))];
    }
    c.duration = t; track.clips.splice(index + 1, 0, right); return next;
  }
  return p;
}
export function moveClip(p: Project, id: string, targetId: string, time: number, snap: boolean): Project {
  const next = structuredClone(p);
  const from = next.tracks.find(t => t.clips.some(c => c.id === id));
  const to = next.tracks.find(t => t.id === targetId);
  if (!from || !to || from.locked || to.locked || from.kind !== to.kind) return p;
  const c = from.clips.find(c => c.id === id)!;
  let start = snapFrame(time, p.fps);
  if (snap) {
    const edges = [0, ...next.tracks.flatMap(t => t.clips.filter(c => c.id !== id).flatMap(c => [c.start, clipEnd(c)]))];
    for (const edge of edges) {
      if (Math.abs(start - edge) < 0.15) start = edge;
      if (Math.abs(start + c.duration - edge) < 0.15) start = Math.max(0, edge - c.duration);
    }
  }
  from.clips = from.clips.filter(c => c.id !== id);
  c.start = start; to.clips.push(c); to.clips.sort((a, b) => a.start - b.start);
  return next;
}
export function evaluateKeys(keys: Key[] | undefined, time: number, fallback: number): number {
  if (!keys?.length) return fallback;
  const list = [...keys].sort((a, b) => a.at - b.at);
  if (time <= list[0].at) return list[0].value;
  for (let i = 1; i < list.length; i++) if (time <= list[i].at) {
    const a = list[i - 1], b = list[i];
    return a.value + (b.value - a.value) * (time - a.at) / Math.max(1e-9, b.at - a.at);
  }
  return list.at(-1)!.value;
}
export function fitMusic(p: Project): Project {
  const duration = projectDuration(p);
  for (const track of p.tracks) if (track.kind === 'audio') for (const c of track.clips) {
    if (c.coverProject && duration > c.start) c.duration = duration - c.start;
  }
  return p;
}
export function trimClip(p: Project, id: string, edge: 'left' | 'right', time: number): Project {
  const next = structuredClone(p), track = next.tracks.find(t => t.clips.some(c => c.id === id));
  if (!track || track.locked) return p;
  const c = track.clips.find(c => c.id === id)!, m = next.media.find(m => m.id === c.assetId);
  const oldStart = c.start, oldEnd = clipEnd(c), frame = 1 / fpsValue(p.fps);
  const bounded = m?.kind === 'video' && c.freeze === null || m?.kind === 'audio' && !c.loop;
  if (edge === 'left') {
    const available = c.reverse ? Math.max(0, (m?.duration || 0) - c.sourceStart - c.duration * c.rate) / c.rate : c.sourceStart / c.rate;
    c.start = Math.min(oldEnd - frame, Math.max(bounded ? oldStart - available : 0, snapFrame(time, p.fps)));
    const delta = c.start - oldStart;
    c.duration = oldEnd - c.start;
    if (bounded && !c.reverse) c.sourceStart += delta * c.rate;
    for (const property of Object.keys(c.effects.keys) as KeyProperty[]) {
      const keys = c.effects.keys[property]!;
      const value = evaluateKeys(keys, delta, c.effects[property]);
      c.effects.keys[property] = [{ at: 0, value }, ...keys.filter(k => k.at > delta).map(k => ({ at: k.at - delta, value: k.value }))];
    }
  } else {
    const maximum = bounded ? c.reverse ? oldEnd + c.sourceStart / c.rate : c.start + ((m?.duration || 0) - c.sourceStart) / c.rate : 86400;
    const end = Math.min(maximum, Math.max(c.start + frame, snapFrame(time, p.fps)));
    if (bounded && c.reverse) c.sourceStart += (oldEnd - end) * c.rate;
    c.duration = end - c.start;
    for (const property of Object.keys(c.effects.keys) as KeyProperty[]) {
      const keys = c.effects.keys[property]!;
      c.effects.keys[property] = [...keys.filter(k => k.at < c.duration), { at: c.duration, value: evaluateKeys(keys, c.duration, c.effects[property]) }];
    }
  }
  c.coverProject = false;
  return next;
}
export function timecode(t: number, fps?: Rational): string {
  const seconds = Math.max(0, t || 0);
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = Math.floor(seconds % 60);
  const base = [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
  return fps ? `${base}:${String(Math.floor((seconds % 1) * fpsValue(fps) + 1e-6)).padStart(2, '0')}` : base;
}
export function defaultExport(p: Project, path: string): ExportSettings {
  return { path, codec: 'hevc', encoder: 'auto', preset: 'quality', maxBytes: 1_000_000_000, videoKbps: null, audioKbps: 192,
    audioSampleRate: 48000, width: p.width, height: p.height, fps: p.fps, hdr: 'preserve', decode: 'software', threads: 8, verifyDecode: true };
}
