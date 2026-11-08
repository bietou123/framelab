import { useEffect, useRef, useState } from 'react';
import { Undo2, Redo2, Scissors, Trash2, Magnet, ZoomIn, ZoomOut, Maximize2, LockKeyhole, LockKeyholeOpen, Volume2, VolumeX, Eye, EyeOff, Copy, ChevronLeft, ChevronRight, Film, Music2, Captions, Plus } from 'lucide-react';
import type { Clip, Project, Track } from '../shared/types';
import { clipEnd, moveClip, newTrack, projectDuration, reorder, timecode, trimClip } from '../shared/model';
import { IconButton } from './controls';
import { Waveform } from './Waveform';
interface Props {
  project: Project; selected: string | null; time: number; onTime: (time: number) => void;
  onSelect: (id: string) => void; commit: (p: Project | ((p: Project) => Project)) => void;
  undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean;
  onSplit: () => void; onDelete: () => void; onDuplicate: () => void;
  onDropMedia: (ids: string[], track: string, time: number) => void;
}
interface Drag { id: string; edge: 'move' | 'left' | 'right'; x: number; delta: number; track: string; target: string; start: number; duration: number }
export function Timeline(props: Props) {
  const { project: p, selected, time, commit } = props;
  const [snap, setSnap] = useState(true), [zoom, setZoom] = useState(0), [availableWidth, setAvailableWidth] = useState(800), [drag, setDrag] = useState<Drag | null>(null);
  const scroll = useRef<HTMLDivElement>(null), dragRef = useRef<Drag | null>(null);
  const duration = Math.max(projectDuration(p), ...p.tracks.flatMap(t => t.clips.map(clipEnd)), 10);
  const base = Math.max(0.1, (availableWidth - 150 - 36) / duration), scale = base * 2 ** (zoom / 20);
  const laneWidth = Math.max(availableWidth - 150, duration * scale + 80);
  const chosenTrack = p.tracks.find(t => t.clips.some(c => c.id === selected));
  const selectedClip = chosenTrack?.clips.find(c => c.id === selected);
  const tracks = [...p.tracks.filter(t => t.kind === 'video').reverse(), ...p.tracks.filter(t => t.kind === 'audio'), ...p.tracks.filter(t => t.kind === 'subtitle')];
  const interval = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].find(n => n * scale >= 76) || 7200;
  const ticks = Array.from({ length: Math.min(2000, Math.ceil(laneWidth / scale / interval) + 1) }, (_, i) => i * interval);
  useEffect(() => { const observer = new ResizeObserver(entries => setAvailableWidth(entries[0].contentRect.width)); observer.observe(scroll.current!); return () => observer.disconnect(); }, []);
  const trackChange = (id: string, update: Partial<Track>) => commit(old => ({ ...old, tracks: old.tracks.map(t => t.id === id ? { ...t, ...update } : t) }));
  const begin = (e: React.PointerEvent, c: Clip, t: Track, edge: Drag['edge']) => {
    if (e.button !== 0) return;
    e.stopPropagation(); props.onSelect(c.id);
    if (t.locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const state: Drag = { id: c.id, edge, x: e.clientX + (scroll.current?.scrollLeft || 0), delta: 0, track: t.id, target: t.id, start: c.start, duration: c.duration };
    dragRef.current = state; setDrag(state);
  };
  const moving = (e: React.PointerEvent) => {
    const old = dragRef.current; if (!old) return;
    const delta = (e.clientX + (scroll.current?.scrollLeft || 0) - old.x) / scale;
    const element = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-track-id]');
    const target = old.edge === 'move' && element?.getAttribute('data-track-id') || old.track;
    const state = { ...old, delta, target }; dragRef.current = state; setDrag(state);
  };
  const finish = () => {
    const state = dragRef.current; if (!state) return;
    if (Math.abs(state.delta) > 1e-5 || state.edge === 'move' && state.target !== state.track) {
      if (state.edge === 'move') commit(old => moveClip(old, state.id, state.target, state.start + state.delta, snap));
      else {
        const edge = state.edge;
        commit(old => trimClip(old, state.id, edge, (edge === 'left' ? state.start : state.start + state.duration) + state.delta));
      }
    }
    dragRef.current = null; setDrag(null);
  };
  const reorderSelected = (direction: number) => {
    if (!chosenTrack || !selected) return;
    const ids = [...chosenTrack.clips].sort((a, b) => a.start - b.start).map(c => c.id), at = ids.indexOf(selected), next = at + direction;
    if (next < 0 || next >= ids.length) return;
    [ids[at], ids[next]] = [ids[next], ids[at]]; commit(old => reorder(old, chosenTrack.id, ids));
  };
  return <section className="timeline-panel" aria-label="多轨时间线">
    <header className="timeline-toolbar"><div><h2>时间线</h2><span className="toolbar-divider" /><IconButton icon={Undo2} label="撤销" onClick={props.undo} disabled={!props.canUndo} /><IconButton icon={Redo2} label="重做" onClick={props.redo} disabled={!props.canRedo} /><span className="toolbar-divider" /><IconButton icon={Scissors} label="在播放头处分割" onClick={props.onSplit} disabled={!selectedClip || chosenTrack?.locked || time <= selectedClip.start || time >= clipEnd(selectedClip)} /><IconButton icon={Trash2} label="删除选中片段" onClick={props.onDelete} disabled={!selected || chosenTrack?.locked} /><IconButton icon={Copy} label="复制片段" onClick={props.onDuplicate} disabled={!selected || chosenTrack?.locked} /><IconButton icon={ChevronLeft} label="片段向前排序" onClick={() => reorderSelected(-1)} disabled={!selected || chosenTrack?.locked} /><IconButton icon={ChevronRight} label="片段向后排序" onClick={() => reorderSelected(1)} disabled={!selected || chosenTrack?.locked} /><span className="toolbar-divider" /><IconButton icon={Magnet} label="吸附" active={snap} onClick={() => setSnap(!snap)} /><select aria-label="添加轨道" value="" onChange={e => { const kind = e.target.value as Track['kind']; const track = newTrack(kind, `${{ video: 'V', audio: 'A', subtitle: 'S' }[kind]}${p.tracks.filter(t => t.kind === kind).length + 1}`); commit(old => ({ ...old, tracks: [...old.tracks, track] })); }}><option value="" disabled>+ 轨道</option><option value="video">视频轨</option><option value="audio">音频轨</option><option value="subtitle">字幕轨</option></select></div><div className="timeline-zoom"><output>{timecode(time, p.fps)}</output><IconButton icon={ZoomOut} label="缩小时间线" onClick={() => setZoom(z => Math.max(-60, z - 15))} /><input aria-label="时间线缩放" type="range" min={-60} max={100} value={zoom} onChange={e => setZoom(Number(e.target.value))} /><IconButton icon={ZoomIn} label="放大时间线" onClick={() => setZoom(z => Math.min(100, z + 15))} /><IconButton icon={Maximize2} label="适配全片" onClick={() => { setZoom(0); if (scroll.current) scroll.current.scrollLeft = 0; }} /></div></header>
    <div className="timeline-scroll" ref={scroll}>
      <div className="timeline-ruler" style={{ width: laneWidth + 150 }}><div className="ruler-corner">{fpsValueLabel(p.fps)}</div><div className="ruler-lane" style={{ width: laneWidth }} onPointerDown={e => props.onTime(Math.max(0, Math.min(projectDuration(p), (e.clientX - e.currentTarget.getBoundingClientRect().left) / scale)))}>{ticks.map(t => <span key={t} style={{ left: t * scale }}>{timecode(t).replace(/^00:/, '')}</span>)}<div className="ruler-head" style={{ left: time * scale }} /></div></div>
      {tracks.map(track => { const Kind = track.kind === 'video' ? Film : track.kind === 'audio' ? Music2 : Captions;
        return <div className={`track-row ${track.kind} ${track.locked ? 'locked' : ''} ${track.hidden ? 'hidden-track' : ''}`} key={track.id} style={{ width: laneWidth + 150 }}>
          <div className="track-header"><div><Kind size={13} /><input aria-label={`轨道名称 ${track.name}`} key={`${track.id}-${track.name}`} defaultValue={track.name} disabled={track.locked} onBlur={e => { const name = e.target.value.trim(); if (name && name !== track.name) trackChange(track.id, { name }); }} /><IconButton icon={Trash2} label={`删除轨道 ${track.name}`} disabled={track.locked} onClick={() => { if (track.clips.length && !confirm(`删除轨道 ${track.name} 和其中 ${track.clips.length} 个片段？原素材不受影响。`)) return; commit(old => ({ ...old, tracks: old.tracks.filter(t => t.id !== track.id) })); }} /></div><div><IconButton icon={track.locked ? LockKeyhole : LockKeyholeOpen} label={track.locked ? `解锁轨道 ${track.name}` : `锁定轨道 ${track.name}`} active={track.locked} onClick={() => trackChange(track.id, { locked: !track.locked })} />{track.kind !== 'subtitle' && <IconButton icon={track.muted ? VolumeX : Volume2} label={`轨道 ${track.name} 静音`} active={track.muted} onClick={() => trackChange(track.id, { muted: !track.muted })} />}<IconButton icon={track.hidden ? EyeOff : Eye} label={`轨道 ${track.name} 隐藏`} active={track.hidden} onClick={() => trackChange(track.id, { hidden: !track.hidden })} /></div></div>
          <div className={`track-lane ${drag?.target === track.id ? 'drop-active' : ''}`} data-track-id={track.id} style={{ width: laneWidth, backgroundSize: `${interval * scale}px 100%` }} onPointerDown={e => { if (e.target === e.currentTarget) props.onTime(Math.max(0, Math.min(projectDuration(p), (e.clientX - e.currentTarget.getBoundingClientRect().left) / scale))); }} onDragOver={e => { if (e.dataTransfer.types.includes('application/framelab-media')) { e.preventDefault(); e.dataTransfer.dropEffect = track.locked ? 'none' : 'copy'; } }} onDrop={e => { const data = e.dataTransfer.getData('application/framelab-media'); if (!data || track.locked) return; e.preventDefault(); e.stopPropagation(); try { props.onDropMedia(JSON.parse(data), track.id, Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / scale)); } catch { /* Ignore external drag types. */ } }}>
            {track.clips.map(c => {
              const media = p.media.find(m => m.id === c.assetId);
              const preview = drag?.id === c.id ? drag : null;
              const start = preview && preview.edge !== 'right' ? Math.max(0, c.start + preview.delta) : c.start;
              const length = preview && preview.edge !== 'move' ? Math.max(0.03, c.duration + preview.delta * (preview.edge === 'left' ? -1 : 1)) : c.duration;
              const keyTimes = [...new Set(Object.values(c.effects.keys).flatMap(keys => keys?.map(k => k.at) || []))];
              return <div className={`timeline-clip ${selected === c.id ? 'selected' : ''} ${media?.missing ? 'missing' : ''} ${preview ? 'dragging' : ''}`} data-testid="timeline-clip" data-clip-id={c.id} key={c.id} title={`${c.name}\n${timecode(c.start, p.fps)} - ${timecode(clipEnd(c), p.fps)}`} style={{ left: start * scale, width: Math.max(3, length * scale) }} tabIndex={0} onPointerDown={e => begin(e, c, track, 'move')} onPointerMove={moving} onPointerUp={finish} onPointerCancel={() => { dragRef.current = null; setDrag(null); }} onDoubleClick={() => props.onTime(c.start)} onKeyDown={e => { if (e.key === 'Enter') props.onSelect(c.id); }}>
                <div className="clip-title">{c.text || c.name}</div>{track.kind === 'video' && media?.thumbnail && <img className="clip-thumbnail" src={window.framelab.mediaUrl(media.thumbnail)} alt="" />}{track.kind === 'audio' && media?.waveform && <Waveform media={media} clip={c} />}
                {c.transition.type === 'dissolve' && <div className="transition-mark" style={{ width: Math.min(length * scale, c.transition.duration * scale) }} />}{keyTimes.map(at => <i className="key-marker" key={at} style={{ left: Math.min(length * scale - 4, at * scale) }} />)}
                <div className="trim-handle left" aria-label="裁剪片段入点" onPointerDown={e => begin(e, c, track, 'left')} onPointerMove={moving} onPointerUp={finish} /><div className="trim-handle right" aria-label="裁剪片段出点" onPointerDown={e => begin(e, c, track, 'right')} onPointerMove={moving} onPointerUp={finish} />
              </div>;
            })}<div className="lane-head" style={{ left: time * scale }} />
          </div>
        </div>;
      })}
      {!tracks.length && <button className="empty-track" onClick={() => commit(old => ({ ...old, tracks: [newTrack('video', 'V1'), newTrack('audio', 'A1'), newTrack('subtitle', 'S1')] }))}><Plus size={16} />添加轨道</button>}
    </div>
    <footer className="timeline-footer"><span>{p.tracks.length} 条轨道 · {p.tracks.reduce((n, t) => n + t.clips.length, 0)} 个片段</span><span>{Math.round(projectDuration(p) * Number(p.fps.split('/')[0]) / Number(p.fps.split('/')[1])).toLocaleString()} 帧 · {timecode(projectDuration(p), p.fps)}</span></footer>
  </section>;
}
function fpsValueLabel(fps: string) { return `${fps} fps`; }
