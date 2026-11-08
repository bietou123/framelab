import type { Clip, Effects, ExportSettings, Key, Media, Project } from '../shared/types';
import { clipEnd, defaultEffects, fpsValue, projectDuration } from '../shared/model';
import { colorFilter, outputVideoColor } from './color';
export const f = (n: number): string => Number(n.toFixed(8)).toString();
export function keyExpression(keys: Key[] | undefined, fallback: number, variable = 't'): string {
  if (!keys?.length) return f(fallback);
  const list = [...keys].sort((a, b) => a.at - b.at);
  let expression = f(list.at(-1)!.value);
  for (let i = list.length - 1; i > 0; i--) {
    const a = list[i - 1], b = list[i];
    const value = `${f(a.value)}+(${f(b.value - a.value)})*(${variable}-${f(a.at)})/${f(Math.max(1e-8, b.at - a.at))}`;
    expression = `if(lt(${variable},${f(b.at)}),${value},${expression})`;
  }
  return `if(lte(${variable},${f(list[0].at)}),${f(list[0].value)},${expression})`;
}
export function untouched(c: Clip): boolean {
  const fx = { ...c.effects, keys: {} }, original = defaultEffects();
  return c.rate === 1 && !c.reverse && c.freeze === null && c.transition.type === 'none' && !Object.values(c.effects.keys).some(k => k?.length) && JSON.stringify(fx) === JSON.stringify(original);
}
export function sequenceClips(p: Project): Clip[] | null {
  const tracks = p.tracks.filter(t => t.kind === 'video' && !t.hidden && t.clips.length);
  if (tracks.length !== 1) return null;
  const clips = [...tracks[0].clips].sort((a, b) => a.start - b.start);
  let end = 0;
  for (const c of clips) { if (Math.abs(c.start - end) > 0.0001 || c.transition.type !== 'none') return null; end = clipEnd(c); }
  return clips;
}
export function copyCompatibility(p: Project, settings: ExportSettings): { compatible: boolean; reasons: string[]; estimatedVideoBytes: number } {
  const reasons: string[] = [];
  const clips = sequenceClips(p);
  if (!clips) return { compatible: false, reasons: ['无损拼接只支持一条连续视频轨，且没有间隙、重叠或转场'], estimatedVideoBytes: 0 };
  const media = clips.map(c => p.media.find(m => m.id === c.assetId)!);
  const first = media[0]?.video;
  if (!first) reasons.push('缺少视频流');
  const same = (a: unknown, b: unknown) => (a || '') === (b || '');
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i], m = media[i], v = m?.video;
    if (!m || m.kind !== 'video' || !v) { reasons.push(`${c.name} 不是视频`); continue; }
    if (!untouched(c) || c.sourceStart !== 0 || Math.abs(c.duration - m.duration) > 1e-4) reasons.push(`${c.name} 有裁剪、特效或速度调整，必须重编码`);
    if (v.width !== first?.width || v.height !== first?.height || ['codec', 'profile', 'fps', 'pixFmt', 'timeBase', 'extradataHash', 'colorPrimaries', 'colorTransfer', 'colorSpace', 'colorRange', 'rotation'].some(key => !same(v[key as keyof typeof v], first?.[key as keyof typeof v]))) reasons.push(`${c.name} 的编码参数与首段不兼容`);
    if (!v.extradataHash) reasons.push(`${c.name} 缺少编码初始化参数，无法确认可无损拼接`);
  }
  if (settings.width !== first?.width || settings.height !== first?.height || settings.fps !== first?.fps) reasons.push('导出规格不同于源片，需要重编码');
  if (p.tracks.some(t => t.kind === 'subtitle' && !t.hidden && t.clips.length)) reasons.push('烧录字幕需要重编码');
  if (settings.hdr === 'sdr' && media.some(m => m.hdr)) reasons.push('HDR 转 SDR 需要重编码');
  const estimatedVideoBytes = media.reduce((total, m) => total + (m?.video?.bitRate || m?.bitRate || 0) * (m?.duration || 0) / 8, 0);
  return { compatible: reasons.length === 0, reasons: [...new Set(reasons)], estimatedVideoBytes };
}
export interface VideoInput { clip: Clip; media: Media; path: string; reversed?: boolean; lutFile?: string }
export function buildVideoGraph(p: Project, settings: ExportSettings, inputs: VideoInput[], subtitleFile?: string): { graph: string; output: string; simple: boolean } {
  const duration = projectDuration(p), fps = settings.fps;
  const sequence = sequenceClips(p);
  const simple = Boolean(sequence && sequence.length === inputs.length && inputs.every(i => untouched(i.clip) && i.media.kind === 'video' && i.media.video?.width === settings.width && i.media.video?.height === settings.height && i.media.video?.fps === fps && !i.media.video?.rotation && !i.media.hdr));
  const graph: string[] = [];
  if (simple) {
    inputs.forEach((input, index) => {
      const start = Math.round(input.clip.sourceStart * fpsValue(fps));
      const end = start + Math.round(input.clip.duration * fpsValue(fps));
      graph.push(`[${index}:${input.media.video!.index}]trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS[v${index}]`);
    });
    graph.push(`${inputs.map((_, i) => `[v${i}]`).join('')}concat=n=${inputs.length}:v=1:a=0[composed]`);
  } else {
    graph.push(`color=c=black:s=${settings.width}x${settings.height}:r=${fps}:d=${f(duration)},format=yuv420p[bg0]`);
    inputs.forEach((input, index) => {
      const c = input.clip, m = input.media, fx = c.effects;
      const filters: string[] = [];
      if (c.freeze !== null && m.kind !== 'image') {
        const frame = Math.round(c.freeze * fpsValue(m.video!.fps || p.fps));
        filters.push(`trim=start_frame=${frame}:end_frame=${frame + 1}`, `loop=loop=${Math.ceil(c.duration * fpsValue(fps))}:size=1:start=0`, `setpts=N/(${fpsValue(fps)}*TB)`);
      } else if (m.kind === 'image') filters.push(`trim=duration=${f(c.duration)}`, 'setpts=PTS-STARTPTS');
      else filters.push(`trim=start=${input.reversed ? '0' : f(c.sourceStart)}:duration=${f(c.duration * c.rate)}`, `setpts=(PTS-STARTPTS)/${f(c.rate)}`);
      if (m.hdr && settings.hdr === 'sdr') filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'tonemap=tonemap=hable:desat=0', 'zscale=p=bt709:t=bt709:m=bt709:r=tv');
      const crop = fx.crop;
      let sourceW = m.video!.width! * (1 - crop.left - crop.right), sourceH = m.video!.height! * (1 - crop.top - crop.bottom);
      if (crop.left || crop.top || crop.right || crop.bottom) filters.push(`crop=w=trunc(iw*${f(1 - crop.left - crop.right)}/2)*2:h=trunc(ih*${f(1 - crop.top - crop.bottom)}/2)*2:x=trunc(iw*${f(crop.left)}/2)*2:y=trunc(ih*${f(crop.top)}/2)*2`);
      const rotation = ((-(m.video!.rotation || 0) + fx.rotation) % 360 + 360) % 360;
      if (rotation === 90) filters.push('transpose=1');
      if (rotation === 180) filters.push('hflip', 'vflip');
      if (rotation === 270) filters.push('transpose=2');
      if (rotation === 90 || rotation === 270) [sourceW, sourceH] = [sourceH, sourceW];
      if (fx.mirrorX) filters.push('hflip'); if (fx.mirrorY) filters.push('vflip');
      if (fx.exposure || fx.contrast !== 1 || fx.saturation !== 1) filters.push(`eq=brightness=${f(fx.exposure * 0.12)}:contrast=${f(fx.contrast)}:saturation=${f(fx.saturation)}`);
      if (fx.temperature) {
        const warm = f(fx.temperature * 0.15), cool = f(-fx.temperature * 0.15);
        filters.push(`colorbalance=rs=${warm}:rm=${warm}:rh=${warm}:bs=${cool}:bm=${cool}:bh=${cool}:pl=1`);
      }
      if (input.lutFile) filters.push(`lut3d=file=${input.lutFile}`);
      const factor = Math.min(settings.width / sourceW, settings.height / sourceH);
      const scale = keyExpression(fx.keys.scale, fx.scale);
      filters.push(`scale=w='max(2,trunc(${f(sourceW * factor)}*(${scale})/2)*2)':h='max(2,trunc(${f(sourceH * factor)}*(${scale})/2)*2)':eval=frame`, `fps=${fps}`, 'setsar=1', 'format=yuva420p');
      if (fx.keys.opacity?.length) filters.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(${keyExpression(fx.keys.opacity, fx.opacity, 'T')})'`);
      else if (fx.opacity !== 1) filters.push(`colorchannelmixer=aa=${f(fx.opacity)}`);
      if (c.transition.type === 'dissolve' && c.transition.duration > 0) filters.push(`fade=t=in:st=0:d=${f(c.transition.duration)}:alpha=1`);
      filters.push(`trim=duration=${f(c.duration)}`, `setpts=PTS+${f(c.start)}/TB`);
      graph.push(`[${index}:${input.reversed ? 'v:0' : m.video!.index}]${filters.join(',')}[clip${index}]`);
      const x = keyExpression(fx.keys.x, fx.x, `(t-${f(c.start)})`), y = keyExpression(fx.keys.y, fx.y, `(t-${f(c.start)})`);
      graph.push(`[bg${index}][clip${index}]overlay=x='(W-w)/2+${settings.width / 2}*(${x})':y='(H-h)/2+${settings.height / 2}*(${y})':eval=frame:eof_action=pass:shortest=0:enable='gte(t,${f(c.start)})*lt(t,${f(c.start + c.duration)})'[bg${index + 1}]`);
    });
    graph.push(`[bg${inputs.length}]trim=duration=${f(duration)},setpts=PTS-STARTPTS[composed]`);
  }
  // The compositor's background owns frame metadata; encoder flags alone are insufficient.
  const color = colorFilter(outputVideoColor(p, settings));
  graph.push(`[composed]${subtitleFile ? `ass=filename=${subtitleFile},` : ''}format=yuv420p${color ? `,${color}` : ''}[outv]`);
  return { graph: graph.join(';'), output: '[outv]', simple };
}
