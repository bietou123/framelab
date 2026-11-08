import type { ExportSettings, Media, MediaStream, Project } from '../shared/types';

export const colorKeys = ['colorPrimaries', 'colorTransfer', 'colorSpace', 'colorRange'] as const;
export type VideoColor = Pick<MediaStream, typeof colorKeys[number]>;

export function visibleVideoMedia(project: Project): Media[] {
  const media = new Map(project.media.map(item => [item.id, item]));
  return project.tracks.filter(track => track.kind === 'video' && !track.hidden)
    .flatMap(track => [...track.clips].sort((a, b) => a.start - b.start))
    .map(clip => clip.assetId ? media.get(clip.assetId) : undefined)
    .filter((item): item is Media => Boolean(item));
}

export function outputVideoColor(project: Project, settings: Pick<ExportSettings, 'hdr'>): VideoColor {
  const sources = visibleVideoMedia(project);
  if (settings.hdr === 'sdr' && sources.some(media => media.hdr)) {
    return { colorPrimaries: 'bt709', colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv' };
  }
  const source = sources.find(media => media.kind === 'video')?.video;
  const color: VideoColor = {};
  for (const key of colorKeys) {
    const value = source?.[key];
    if (value && value !== 'unknown') color[key] = value;
  }
  return color;
}

export function colorFilter(color: VideoColor): string | undefined {
  const parameters: string[] = [];
  for (const [key, name] of [['colorPrimaries', 'color_primaries'], ['colorTransfer', 'color_trc'], ['colorSpace', 'colorspace']] as const) {
    if (color[key]) parameters.push(`${name}=${color[key]}`);
  }
  if (color.colorRange === 'tv') parameters.push('range=limited');
  if (color.colorRange === 'pc') parameters.push('range=full');
  return parameters.length ? `setparams=${parameters.join(':')}` : undefined;
}
