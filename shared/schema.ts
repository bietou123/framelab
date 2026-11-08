import { z } from 'zod';
import type { ExportSettings, Project } from './types';
const finite = z.number().finite();
const seconds = finite.min(0).max(86400);
const fps = z.string().regex(/^\d+\/[1-9]\d*$/).refine(s => { const [n, d] = s.split('/').map(Number); return n / d >= 1 && n / d <= 240; }, '帧率必须在 1 到 240 之间');
const keys = z.array(z.object({ at: seconds, value: finite.min(-100).max(100) })).max(1000);
const effects = z.object({
  crop: z.object({ left: finite.min(0).max(0.95), top: finite.min(0).max(0.95), right: finite.min(0).max(0.95), bottom: finite.min(0).max(0.95) }).refine(c => c.left + c.right < 0.98 && c.top + c.bottom < 0.98, '裁剪区域太小'),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]), mirrorX: z.boolean(), mirrorY: z.boolean(),
  x: finite.min(-2).max(2), y: finite.min(-2).max(2), scale: finite.min(0.05).max(4), opacity: finite.min(0).max(1),
  exposure: finite.min(-4).max(4), contrast: finite.min(0).max(3), saturation: finite.min(0).max(3), temperature: finite.min(-1).max(1), lut: z.string().max(32760).nullable(),
  volumeDb: finite.min(-60).max(24), fadeIn: seconds, fadeOut: seconds, denoise: z.boolean(),
  keys: z.object({ x: keys.optional(), y: keys.optional(), scale: keys.optional(), opacity: keys.optional(), volumeDb: keys.optional() }).superRefine((k, ctx) => {
    for (const [property, values] of Object.entries(k)) for (const key of values || []) {
      const [min, max] = { x: [-2, 2], y: [-2, 2], scale: [0.05, 4], opacity: [0, 1], volumeDb: [-60, 24] }[property as keyof typeof k];
      if (key.value < min || key.value > max) ctx.addIssue({ code: 'custom', message: `关键帧 ${property} 数值超出范围` });
    }
  }),
});
const clip = z.object({
  id: z.string().min(1).max(100), assetId: z.string().max(100).nullable(), name: z.string().max(10000), start: seconds,
  duration: finite.positive().max(86400), sourceStart: seconds, rate: finite.min(0.1).max(8), reverse: z.boolean(), freeze: seconds.nullable(), effects,
  transition: z.object({ type: z.enum(['none', 'dissolve']), duration: finite.min(0).max(30) }), loop: z.boolean(), crossfade: finite.min(0).max(30), trimSilence: z.boolean(), coverProject: z.boolean().optional(), text: z.string().max(100000).optional(),
});
const projectSchema = z.object({
  version: z.literal(1), id: z.string().min(1).max(100), name: z.string().max(1000), path: z.string().max(32760).optional(), updatedAt: z.string(),
  width: z.number().int().min(16).max(8192), height: z.number().int().min(16).max(8192), fps,
  media: z.array(z.object({ id: z.string(), path: z.string().max(32760), name: z.string(), kind: z.enum(['video', 'audio', 'image']), size: finite, modified: finite, duration: finite, streams: z.array(z.any()), format: z.string(), bitRate: finite, hdr: z.boolean() }).passthrough()).max(5000),
  tracks: z.array(z.object({ id: z.string(), kind: z.enum(['video', 'audio', 'subtitle']), name: z.string().max(1000), locked: z.boolean(), muted: z.boolean(), hidden: z.boolean(), clips: z.array(clip).max(2000) })).max(64),
  subtitleStyle: z.object({ font: z.string().max(200).regex(/^[^,\r\n{}]+$/), size: finite.min(8).max(300), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), outline: z.string().regex(/^#[a-fA-F0-9]{6}$/), outlineWidth: finite.min(0).max(20), position: z.enum(['bottom', 'middle', 'top']) }),
  includeSourceAudio: z.boolean(),
});
export function validateProject(value: unknown): Project {
  const p = projectSchema.parse(value) as Project;
  const ids = p.tracks.flatMap(t => t.clips.map(c => c.id));
  if (new Set(ids).size !== ids.length || new Set(p.tracks.map(t => t.id)).size !== p.tracks.length || new Set(p.media.map(m => m.id)).size !== p.media.length) throw new Error('项目包含重复 ID');
  if (p.tracks.some(t => t.clips.some(c => c.start + c.duration > 86400))) throw new Error('时间线超过 24 小时');
  if (p.width % 2 || p.height % 2) throw new Error('项目宽高必须为偶数');
  for (const t of p.tracks) for (const c of t.clips) if (t.kind !== 'subtitle' && !p.media.some(m => m.id === c.assetId)) throw new Error(`片段缺少素材引用：${c.name}`);
  return p;
}
const settingsSchema = z.object({
  path: z.string().min(1).max(32760), codec: z.enum(['h264', 'hevc', 'av1', 'copy']), encoder: z.string().regex(/^[a-z0-9_\-]+$/), preset: z.enum(['fast', 'balanced', 'quality']),
  maxBytes: z.number().int().positive().nullable(), videoKbps: finite.min(100).max(1000000).nullable(), audioKbps: finite.min(32).max(512), audioSampleRate: z.union([z.literal(44100), z.literal(48000)]),
  width: z.number().int().min(16).max(8192).refine(n => n % 2 === 0), height: z.number().int().min(16).max(8192).refine(n => n % 2 === 0), fps, hdr: z.enum(['preserve', 'sdr']), decode: z.enum(['software', 'auto']), threads: z.number().int().min(1).max(32), verifyDecode: z.boolean(),
});
export function validateSettings(value: unknown): ExportSettings { return settingsSchema.parse(value) as ExportSettings; }
