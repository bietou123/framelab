import { defaultEffects, uid } from './model';
import type { Clip, Project } from './types';
const timestamp = (s: string): number => {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(s.trim());
  if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) throw new Error(`无效字幕时间：${s}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
};
const format = (t: number): string => {
  const ms = Math.round(Math.max(0, t) * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
export function parseSrt(input: string): Clip[] {
  const result: Clip[] = [];
  for (const block of input.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\s*\n/)) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const index = lines.findIndex(l => l.includes('-->'));
    if (index < 0) throw new Error('SRT 缺少时间轴');
    const parts = lines[index].split('-->').map(s => s.trim().split(/\s/)[0]);
    const start = timestamp(parts[0]), end = timestamp(parts[1]);
    if (end <= start) throw new Error('字幕结束时间必须晚于开始时间');
    const text = lines.slice(index + 1).join('\n').replace(/<\/?[^>]+>/g, '');
    result.push({ id: uid(), assetId: null, name: text.slice(0, 40) || '字幕', text, start, duration: end - start, sourceStart: 0,
      rate: 1, reverse: false, freeze: null, effects: defaultEffects(), transition: { type: 'none', duration: 0 }, loop: false, crossfade: 0, trimSilence: false });
  }
  return result.sort((a, b) => a.start - b.start);
}
export function exportSrt(clips: Clip[]): string {
  return clips.filter(c => c.text).sort((a, b) => a.start - b.start).map((c, i) => `${i + 1}\n${format(c.start)} --> ${format(c.start + c.duration)}\n${c.text}\n`).join('\n');
}
const assTime = (t: number): string => {
  const cs = Math.round(Math.max(0, t) * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assColor = (hex: string): string => `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
export function makeAss(p: Project): string {
  const s = p.subtitleStyle;
  const alignment = { bottom: 2, middle: 5, top: 8 }[s.position];
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${p.width}\nPlayResY: ${p.height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,${s.font.replace(/[,\r\n]/g, '')},${s.size},${assColor(s.color)},&H000000FF,${assColor(s.outline)},&H00000000,0,0,0,0,100,100,0,0,1,${s.outlineWidth},0,${alignment},40,40,60,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  return header + p.tracks.filter(t => t.kind === 'subtitle' && !t.hidden).flatMap(t => t.clips).filter(c => c.text).map(c => {
    const text = c.text!.replace(/\\/g, '\\u005c').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.start + c.duration)},Default,,0,0,0,,${text}`;
  }).join('\n') + '\n';
}
