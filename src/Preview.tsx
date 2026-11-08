import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Camera, LoaderCircle, Film } from 'lucide-react';
import type { Clip, Media, Project } from '../shared/types';
import { evaluateKeys, fpsValue, mediaClip, projectDuration, timecode } from '../shared/model';
import { IconButton } from './controls';
import { Waveform } from './Waveform';
interface Layer { clip: Clip; media: Media }
interface Props {
  project: Project; time: number; onTime: (t: number) => void; playing: boolean; onPlaying: (v: boolean) => void;
  source: Media | null; mode: 'timeline' | 'source'; onMode: (v: 'timeline' | 'source') => void;
  onError: (text: string) => void;
}
export function Preview({ project: p, time, onTime, playing, onPlaying, source, mode, onMode, onError }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), elements = useRef(new Map<string, HTMLVideoElement | HTMLImageElement>()), soundtrack = useRef<HTMLAudioElement>(null);
  const [sourceTime, setSourceTime] = useState(0), [mix, setMix] = useState<string | null>(null), [mixPending, setMixPending] = useState(false);
  const [muted, setMuted] = useState(false), [exactPending, setExactPending] = useState(false), [exact, setExact] = useState<{ image: HTMLImageElement; signature: string } | null>(null);
  const [frameVersion, setFrameVersion] = useState(0);
  const dirty = useRef(true), failProxy = useRef(new Set<string>());
  const sourceMode = mode === 'source' && source !== null;
  const sourceClip = useMemo(() => source ? mediaClip(source) : null, [source?.id]);
  const duration = sourceMode ? source.duration : projectDuration(p), position = sourceMode ? sourceTime : time;
  const fps = sourceMode ? source.video?.fps || p.fps : p.fps;
  const setPosition = (t: number) => sourceMode ? setSourceTime(t) : onTime(t);
  const layers: Layer[] = sourceMode ? source.video && sourceClip ? [{ clip: sourceClip, media: source }] : [] : p.tracks.filter(t => t.kind === 'video' && !t.hidden).flatMap(t => [...t.clips].sort((a, b) => a.start - b.start).filter(c => c.start <= time && time < c.start + c.duration).flatMap(clip => { const media = p.media.find(m => m.id === clip.assetId); return media?.video && !media.missing ? [{ clip, media }] : []; }));
  const subtitleClips = sourceMode ? [] : p.tracks.filter(t => t.kind === 'subtitle' && !t.hidden).flatMap(t => t.clips.filter(c => c.start <= time && time < c.start + c.duration));
  const layerIds = layers.map(l => l.media.id).join(',');
  const hasAudio = sourceMode ? Boolean(source.audio) : p.tracks.some(t => !t.hidden && !t.muted && (t.kind === 'audio' || t.kind === 'video' && p.includeSourceAudio) && t.clips.some(c => c.freeze === null && p.media.find(m => m.id === c.assetId)?.audio));
  const audioSignature = useMemo(() => JSON.stringify({ duration: projectDuration(p), sourceAudio: p.includeSourceAudio, media: p.media.map(m => [m.id, m.path, m.modified]), tracks: p.tracks.filter(t => !t.hidden && !t.muted && (t.kind === 'audio' || t.kind === 'video' && p.includeSourceAudio)).map(t => t.clips.map(c => [c.assetId, c.start, c.duration, c.sourceStart, c.rate, c.reverse, c.freeze, c.loop, c.crossfade, c.trimSilence, c.effects.volumeDb, c.effects.fadeIn, c.effects.fadeOut, c.effects.denoise, c.effects.keys.volumeDb])) }), [p]);
  const visualSignature = useMemo(() => JSON.stringify({ width: p.width, height: p.height, fps: p.fps, subtitleStyle: p.subtitleStyle, tracks: p.tracks.filter(t => t.kind !== 'audio').map(t => [t.hidden, t.clips]), files: p.media.map(m => [m.id, m.path, m.modified, m.missing]) }), [p]);
  const frameSignature = `${visualSignature}|${time}`;
  const exactReady = !sourceMode && !playing && exact?.signature === frameSignature;
  const audioUrl = sourceMode && source.audio ? window.framelab.mediaUrl(source.preview || source.path) : mix ? window.framelab.mediaUrl(mix) : undefined;
  const latest = useRef({ p, layers, subtitleClips, position, sourceMode, source, playing, exactReady, exact });
  latest.current = { p, layers, subtitleClips, position, sourceMode, source, playing, exactReady, exact };
  useEffect(() => { setSourceTime(0); onPlaying(false); dirty.current = true; }, [source?.id, mode]);
  useEffect(() => {
    let alive = true; setMix(null);
    if (sourceMode || !hasAudio || duration <= 0) { setMixPending(false); return; }
    setMixPending(true);
    void window.framelab.previewAudio(p).then(file => { if (alive) { setMix(file); setMixPending(false); } }).catch(error => { if (alive) { setMixPending(false); if (!String(error).includes('取消')) onError(`音轨预览失败：${String(error)}`); } });
    return () => { alive = false; void window.framelab.cancelPreview('audio').catch(() => {}); };
  }, [audioSignature, sourceMode]);
  useEffect(() => {
    for (const { media } of layers) void window.framelab.ensurePreview(media.id).catch(error => onError(String(error)));
    if (sourceMode && source.kind === 'audio') void window.framelab.ensurePreview(source.id).catch(error => onError(String(error)));
  }, [layerIds, sourceMode, source?.id]);
  useEffect(() => {
    let alive = true;
    if (playing || sourceMode || !duration || !layers.length) { setExactPending(false); return; }
    const timer = setTimeout(() => {
      setExactPending(true);
      void window.framelab.renderFrame(p, Math.min(time, duration - 1 / fpsValue(p.fps))).then(file => {
        if (!alive) return;
        const img = new Image(); img.onload = () => { if (alive) { setExact({ image: img, signature: frameSignature }); setExactPending(false); dirty.current = true; } }; img.onerror = () => { if (alive) setExactPending(false); }; img.src = window.framelab.mediaUrl(file);
      }).catch(error => { if (alive) { setExactPending(false); if (!String(error).includes('取消')) onError(`精确帧预览失败：${String(error)}`); } });
    }, 350);
    return () => { alive = false; clearTimeout(timer); void window.framelab.cancelPreview('frame').catch(() => {}); };
  }, [visualSignature, time, playing, sourceMode]);
  useEffect(() => {
    if (!playing || duration <= 0) return;
    const began = performance.now(), initial = position;
    let raf = 0;
    const tick = (now: number) => {
      const next = Math.min(duration, initial + (now - began) / 1000);
      setPosition(next);
      if (next >= duration) onPlaying(false); else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing, sourceMode, duration]);
  useEffect(() => {
    dirty.current = true;
    for (const { clip, media } of layers) {
      const element = elements.current.get(clip.id); if (!(element instanceof HTMLVideoElement)) continue;
      const local = sourceMode ? position : position - clip.start;
      const target = clip.freeze ?? clip.sourceStart + (clip.reverse ? Math.max(0, clip.duration - local - 1 / fpsValue(fps)) : local) * clip.rate;
      if (element.readyState > 0 && Math.abs(element.currentTime - target) > (playing && !clip.reverse && clip.freeze === null ? 0.2 : 0.025)) element.currentTime = Math.min(Math.max(0, target), media.duration - 0.001);
      element.playbackRate = clip.rate;
      if (playing && !clip.reverse && clip.freeze === null) void element.play().catch(() => {}); else element.pause();
    }
    const a = soundtrack.current;
    if (a && audioUrl && a.readyState > 0 && Math.abs(a.currentTime - position) > (playing ? 0.25 : 0.03)) a.currentTime = Math.min(position, duration);
  }, [position, playing, p, sourceMode, frameVersion]);
  useEffect(() => {
    const a = soundtrack.current; if (!a) return;
    a.muted = muted;
    if (playing && audioUrl) { a.currentTime = Math.min(position, duration); void a.play().catch(error => onError(`音频播放失败：${String(error)}`)); } else a.pause();
  }, [playing, audioUrl, muted]);
  useEffect(() => {
    const target = canvas.current!;
    const ctx = target.getContext('2d')!;
    let raf = 0, last = 0;
    const resize = new ResizeObserver(() => { dirty.current = true; }); resize.observe(target);
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 30 || !dirty.current && !latest.current.playing) return;
      last = now; dirty.current = false;
      const state = latest.current, rect = target.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio);
      const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
      if (target.width !== Math.round(width * dpr) || target.height !== Math.round(height * dpr)) { target.width = Math.round(width * dpr); target.height = Math.round(height * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#090b0d'; ctx.fillRect(0, 0, width, height);
      const rotation = state.sourceMode ? Math.abs(state.source?.video?.rotation || 0) : 0;
      const pw = state.sourceMode && state.source?.video ? (rotation === 90 ? state.source.video.height : state.source.video.width)! : state.p.width;
      const ph = state.sourceMode && state.source?.video ? (rotation === 90 ? state.source.video.width : state.source.video.height)! : state.p.height;
      const w = Math.min(width, height * pw / ph), h = w * ph / pw, left = (width - w) / 2, top = (height - h) / 2;
      ctx.save(); ctx.beginPath(); ctx.rect(left, top, w, h); ctx.clip(); ctx.translate(left, top); ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, w, h);
      if (state.exactReady && state.exact) ctx.drawImage(state.exact.image, 0, 0, w, h);
      else {
        for (const { clip: c, media: m } of state.layers) {
          const el = elements.current.get(c.id);
          if (!el || el instanceof HTMLVideoElement && el.readyState < 2 || el instanceof HTMLImageElement && !el.complete) continue;
          const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth, sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
          if (!sw || !sh) continue;
          const fx = c.effects, local = state.sourceMode ? state.position : state.position - c.start;
          const angle = ((-(m.video?.rotation || 0) + fx.rotation) % 360 + 360) % 360;
          const cw = sw * (1 - fx.crop.left - fx.crop.right), ch = sh * (1 - fx.crop.top - fx.crop.bottom);
          const rotated = angle === 90 || angle === 270, factor = Math.min(w / (rotated ? ch : cw), h / (rotated ? cw : ch)) * evaluateKeys(fx.keys.scale, local, fx.scale);
          ctx.save(); ctx.translate(w / 2 + evaluateKeys(fx.keys.x, local, fx.x) * w / 2, h / 2 + evaluateKeys(fx.keys.y, local, fx.y) * h / 2);
          ctx.globalAlpha = evaluateKeys(fx.keys.opacity, local, fx.opacity) * (c.transition.type === 'dissolve' && c.transition.duration ? Math.min(1, local / c.transition.duration) : 1);
          ctx.rotate(angle * Math.PI / 180); ctx.scale(fx.mirrorX ? -1 : 1, fx.mirrorY ? -1 : 1);
          ctx.filter = `brightness(${Math.max(0, 1 + fx.exposure * 0.24)}) contrast(${fx.contrast}) saturate(${fx.saturation})`;
          ctx.drawImage(el, sw * fx.crop.left, sh * fx.crop.top, cw, ch, -cw * factor / 2, -ch * factor / 2, cw * factor, ch * factor); ctx.restore();
        }
        const style = state.p.subtitleStyle;
        const lines = state.subtitleClips.map(c => c.text || '').join('\n').split('\n').filter(Boolean), fontSize = style.size * w / state.p.width, lineHeight = fontSize * 1.25;
        ctx.font = `${fontSize}px "${style.font}"`; ctx.textAlign = 'center'; ctx.lineJoin = 'round'; ctx.textBaseline = 'middle'; ctx.fillStyle = style.color; ctx.strokeStyle = style.outline; ctx.lineWidth = style.outlineWidth * w / state.p.width * 2;
        const y = style.position === 'top' ? 60 * h / state.p.height : style.position === 'middle' ? h / 2 - (lines.length - 1) * lineHeight / 2 : h - 60 * h / state.p.height - (lines.length - 1) * lineHeight;
        lines.forEach((text, i) => { if (ctx.lineWidth > 0) ctx.strokeText(text, w / 2, y + i * lineHeight, w - 20); ctx.fillText(text, w / 2, y + i * lineHeight, w - 20); });
      }
      ctx.restore();
    };
    raf = requestAnimationFrame(draw); return () => { cancelAnimationFrame(raf); resize.disconnect(); };
  }, []);
  const decoderError = (m: Media) => {
    if (!failProxy.current.has(m.id)) { failProxy.current.add(m.id); void window.framelab.ensurePreview(m.id, true).catch(error => onError(String(error))); }
  };
  return <section className="preview-panel panel" aria-label="预览">
    <header className="panel-heading"><div className="segmented"><button className={!sourceMode ? 'selected' : ''} onClick={() => { onPlaying(false); onMode('timeline'); }}>时间线</button><button className={sourceMode ? 'selected' : ''} disabled={!source} onClick={() => { onPlaying(false); onMode('source'); }}>源素材</button></div><div className="preview-badges">{exactPending && <LoaderCircle className="spin" size={13} />}<span title={exactReady ? 'FFmpeg 原片滤镜渲染' : '实时预览，调色和 LUT 的准确效果以精确帧为准'}>{exactReady ? '精确帧' : '实时预览'}</span><IconButton icon={Camera} label="刷新精确帧" disabled={sourceMode || playing || !duration} onClick={() => { setExact(null); setFrameVersion(v => v + 1); dirty.current = true; void window.framelab.renderFrame(p, Math.min(time, duration - 1 / fpsValue(p.fps))).then(file => { const img = new Image(); img.onload = () => { setExact({ image: img, signature: frameSignature }); dirty.current = true; }; img.src = window.framelab.mediaUrl(file); }).catch(error => onError(String(error))); }} /></div></header>
    <div className="preview-title"><span title={sourceMode ? source.name : p.name}>{sourceMode ? source.name : p.name}</span><small>{sourceMode ? source.video ? `${source.video.width} × ${source.video.height}` : `${source.audio?.sampleRate} Hz` : `${p.width} × ${p.height}`} · {fpsValue(fps).toFixed(3)} fps</small></div>
    <div className="preview-content"><canvas ref={canvas} data-testid="preview-canvas" />{sourceMode && source.kind === 'audio' && <div className="audio-preview"><Waveform media={source} /><MusicLabel name={source.name} /></div>}{!layers.length && !(sourceMode && source.kind === 'audio') && <div className="preview-empty"><Film size={32} strokeWidth={1.2} /><span>{duration ? '当前无画面' : '空时间线'}</span></div>}</div>
    <div className="hidden-media" aria-hidden="true">{layers.map(({ clip, media }) => media.kind === 'image' ? <img key={clip.id} ref={el => { if (el) elements.current.set(clip.id, el); else elements.current.delete(clip.id); }} src={window.framelab.mediaUrl(media.path)} onLoad={() => { dirty.current = true; setFrameVersion(v => v + 1); }} /> : <video key={clip.id} ref={el => { if (el) elements.current.set(clip.id, el); else elements.current.delete(clip.id); }} src={window.framelab.mediaUrl(media.preview || media.path)} muted playsInline preload="auto" onLoadedData={() => { dirty.current = true; setFrameVersion(v => v + 1); }} onSeeked={() => { dirty.current = true; }} onError={() => decoderError(media)} />)}<audio ref={soundtrack} src={audioUrl} preload="auto" onLoadedMetadata={() => { if (soundtrack.current) soundtrack.current.currentTime = Math.min(position, duration); }} onError={() => sourceMode && source ? decoderError(source) : onError('音轨预览无法播放')} /></div>
    <div className="preview-status"><span>{layers.some(l => l.media.previewState === 'pending') ? '兼容代理生成中' : layers.some(l => l.media.preview) ? '兼容代理预览' : '原片预览'}{layers.some(l => l.media.hdr) ? ' · HDR 显示预览转 SDR' : ''}</span><span>{mixPending ? '音轨预览生成中' : hasAudio ? '音轨已就绪' : '无音轨'}</span></div>
    <div className="transport"><div><IconButton icon={SkipBack} label="上一帧" disabled={!duration} onClick={() => { onPlaying(false); setPosition(Math.max(0, position - 1 / fpsValue(fps))); }} /><IconButton icon={playing ? Pause : Play} label={playing ? '暂停' : '播放'} className="play-button" disabled={!duration || mixPending} onClick={() => { if (position >= duration) setPosition(0); onPlaying(!playing); }} /><IconButton icon={SkipForward} label="下一帧" disabled={!duration} onClick={() => { onPlaying(false); setPosition(Math.min(Math.max(0, duration - 1 / fpsValue(fps)), position + 1 / fpsValue(fps))); }} /></div><output>{timecode(position, fps)} <span>/ {timecode(duration, fps)}</span></output><IconButton icon={muted ? VolumeX : Volume2} label={muted ? '取消预览静音' : '预览静音'} active={muted} onClick={() => setMuted(!muted)} /></div>
    <input className="preview-seek" aria-label="预览位置" type="range" min={0} max={Math.max(duration, 0.001)} step={1 / fpsValue(fps)} value={position} disabled={!duration} onChange={e => { onPlaying(false); setPosition(Number(e.target.value)); }} />
  </section>;
}
function MusicLabel({ name }: { name: string }) { return <span>{name}</span>; }
