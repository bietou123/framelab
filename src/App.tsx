import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Film, FolderOpen, Save, Plus, Download, ListVideo, PanelLeft, PanelRight, HardDrive, ChevronDown, Captions, ScanText, X, LoaderCircle, Check, Music2 } from 'lucide-react';
import type { AssetEntry, Bootstrap, ExportSettings, Job, Media, Project, Track } from '../shared/types';
import { appendMedia, defaultEffects, fpsValue, mediaClip, newProject, newTrack, projectDuration, snapFrame, splitClip, uid } from '../shared/model';
import { exportSrt, parseSrt } from '../shared/subtitles';
import { useHistory } from './history';
import { IconButton, Modal } from './controls';
import { MediaPanel } from './MediaPanel';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';
import { ExportPanel } from './ExportPanel';
export function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null), [initError, setInitError] = useState(''), [status, setStatus] = useState('正在检测本机 FFmpeg 和编码能力');
  const history = useHistory(newProject()), p = history.project;
  const [assetIds, setAssetIds] = useState<string[]>([]), [selected, setSelected] = useState<string | null>(null), [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<'timeline' | 'source'>('timeline'), [jobs, setJobs] = useState<Job[]>([]), [library, setLibrary] = useState<AssetEntry[]>([]);
  const [importing, setImporting] = useState(false), [dirty, setDirty] = useState(false), [saveStatus, setSaveStatus] = useState(''), [recent, setRecent] = useState<Bootstrap['recent']>([]);
  const [recovery, setRecovery] = useState<Project | null>(null), [error, setError] = useState(''), [exportTab, setExportTab] = useState<'settings' | 'queue' | null>(null);
  const [assetStore, setAssetStore] = useState<Media | null>(null), [assetSource, setAssetSource] = useState(''), [assetLicense, setAssetLicense] = useState('授权未确认；仅用户本地素材');
  const [leftOpen, setLeftOpen] = useState(window.innerWidth >= 980), [rightOpen, setRightOpen] = useState(window.innerWidth >= 980), [timelineHeight, setTimelineHeight] = useState(286);
  const resize = useRef<{ y: number; height: number } | null>(null), initialized = useRef(false);
  const notify = useCallback((text: string) => { setError(text); setStatus(text); }, []);
  const commit = useCallback((value: Project | ((p: Project) => Project)) => { setPlaying(false); history.commit(value); setDirty(true); }, [history.commit]);
  const selectClip = (id: string) => { setSelected(id); setAssetIds([]); setMode('timeline'); setPlaying(false); };
  const seek = (t: number) => { setPlaying(false); setMode('timeline'); setTime(Math.min(Math.max(0, projectDuration(history.current.current) - 1 / fpsValue(history.current.current.fps)), snapFrame(t, history.current.current.fps))); };
  useEffect(() => {
    if (!window.framelab) { setInitError('当前页面没有 Electron 主进程连接，请运行 FrameLab 程序。'); return; }
    let alive = true;
    const off = window.framelab.onEvent(event => {
      if (!alive) return;
      if (event.type === 'media') history.hydrate(event.media);
      else if (event.type === 'status') setStatus(event.text);
      else setJobs(old => old.some(j => j.id === event.job.id) ? old.map(j => j.id === event.job.id ? event.job : j) : [...old, event.job]);
    });
    void window.framelab.bootstrap().then(result => {
      if (!alive) return;
      history.reset(result.project); setBootstrap(result); setLibrary(result.library); setJobs(result.jobs); setRecent(result.recent); setRecovery(result.recovery || null); setStatus('就绪'); setDirty(false); initialized.current = true;
    }).catch(e => { if (alive) setInitError(String(e)); });
    return () => { alive = false; off(); };
  }, []);
  useEffect(() => {
    if (!initialized.current || !bootstrap || recovery) return;
    let alive = true;
    const timer = setTimeout(() => {
      setSaveStatus('正在自动保存');
      void window.framelab.autosave(history.current.current).then(() => { if (alive) setSaveStatus('已自动保存'); }).catch(e => { if (alive) { setSaveStatus('自动保存失败'); notify(String(e)); } });
    }, 1000);
    return () => { alive = false; clearTimeout(timer); };
  }, [history.revision, bootstrap, recovery]);
  useEffect(() => { const d = projectDuration(p); if (time > d) setTime(Math.max(0, d - 1 / fpsValue(p.fps))); }, [p]);
  useEffect(() => {
    let wide = window.innerWidth >= 980;
    const listener = () => { const next = window.innerWidth >= 980; if (wide && !next) { setLeftOpen(false); setRightOpen(false); } wide = next; };
    window.addEventListener('resize', listener); return () => window.removeEventListener('resize', listener);
  }, []);
  const save = async (as = false) => {
    try { const current = history.current.current, updatedAt = current.updatedAt, result = await window.framelab.saveProject(current, as); if (!result) return; const unchanged = history.current.current.updatedAt === updatedAt; history.saved(result); if (unchanged) setDirty(false); setSaveStatus('已保存项目'); setRecent(old => [{ path: result.path!, name: result.name, updatedAt: result.updatedAt }, ...old.filter(r => r.path !== result.path)].slice(0, 20)); }
    catch (e) { notify(String(e)); }
  };
  const reset = (project: Project) => { history.reset(project); setSelected(null); setAssetIds([]); setTime(0); setPlaying(false); setMode('timeline'); setDirty(false); };
  const open = async (filename?: string) => { if (dirty && !confirm('打开另一项目？当前改动已有自动保存，仍建议先保存项目。')) return; try { const result = await window.framelab.openProject(filename); if (result) { reset(result); setRecent(old => [{ path: result.path!, name: result.name, updatedAt: result.updatedAt }, ...old.filter(r => r.path !== result.path)].slice(0, 20)); } } catch (e) { notify(String(e)); } };
  const importFiles = async (paths?: string[], select = true) => {
    setImporting(true);
    try { const result = await window.framelab.importMedia(paths); if (result.media.length) { commit(old => ({ ...old, media: [...old.media, ...result.media.filter(m => !old.media.some(a => a.id === m.id))] })); if (select) { setAssetIds(result.media.map(m => m.id)); setSelected(null); setMode('source'); } } if (result.errors.length) notify(result.errors.map(e => `${e.path}\n${e.error}`).join('\n\n')); return result.media; }
    catch (e) { notify(String(e)); return []; } finally { setImporting(false); }
  };
  const append = (ids: string[], music = false) => {
    let lastId: string | null = null;
    commit(old => {
      let next = structuredClone(old);
      const candidates = ids.map(id => next.media.find(m => m.id === id)).filter((m): m is Media => Boolean(m && !m.missing && (!music || m.kind === 'audio')));
      if (music && candidates.length) next.tracks = next.tracks.map(t => t.kind === 'audio' && !t.locked ? { ...t, clips: t.clips.filter(c => !c.coverProject) } : t);
      for (const m of music ? candidates.slice(0, 1) : candidates) {
        const before = new Set(next.tracks.flatMap(t => t.clips.map(c => c.id))); next = appendMedia(next, m, music); lastId = next.tracks.flatMap(t => t.clips).find(c => !before.has(c.id))?.id || null;
      }
      return next;
    });
    if (lastId) { setSelected(lastId); setAssetIds([]); } setMode('timeline');
  };
  const onDropMedia = (ids: string[], trackId: string, at: number) => {
    let last: string | null = null;
    commit(old => {
      const next = structuredClone(old), track = next.tracks.find(t => t.id === trackId);
      if (!track || track.locked || track.kind === 'subtitle') return old;
      let position = snapFrame(at, old.fps);
      for (const id of ids) {
        const m = next.media.find(m => m.id === id); if (!m || m.missing || (m.kind === 'audio' ? 'audio' : 'video') !== track.kind) continue;
        if (track.kind === 'video' && !next.tracks.some(t => t.kind === 'video' && t.clips.length) && m.video) {
          const rotated = Math.abs(m.video.rotation || 0) === 90; next.width = (rotated ? m.video.height : m.video.width)!; next.height = (rotated ? m.video.width : m.video.height)!; if (m.video.fps && fpsValue(m.video.fps)) next.fps = m.video.fps;
        }
        const c = mediaClip(m, position); track.clips.push(c); position += c.duration; last = c.id;
      }
      track.clips.sort((a, b) => a.start - b.start); return next;
    });
    if (last) selectClip(last);
  };
  const libraryImport = async (entry: AssetEntry, asMusic: boolean) => { const imported = await importFiles([entry.path], !asMusic); if (asMusic && imported[0]) append([imported[0].id], true); };
  const removeClip = () => { if (!selected) return; commit(old => ({ ...old, tracks: old.tracks.map(t => !t.locked ? { ...t, clips: t.clips.filter(c => c.id !== selected) } : t) })); setSelected(null); };
  const duplicateClip = () => { if (!selected) return; let id = ''; commit(old => { const next = structuredClone(old), t = next.tracks.find(t => t.clips.some(c => c.id === selected)); if (!t || t.locked) return old; const c = structuredClone(t.clips.find(c => c.id === selected)!); c.id = uid(); id = c.id; c.start += c.duration; c.coverProject = false; t.clips.push(c); t.clips.sort((a, b) => a.start - b.start); return next; }); if (id) setSelected(id); };
  const split = () => { if (selected) commit(old => splitClip(old, selected, time)); };
  const relink = async (id: string) => { try { await window.framelab.autosave(history.current.current); const found = await window.framelab.relink(id); if (found) commit(old => ({ ...old, media: old.media.map(m => m.id === id ? found : m) })); } catch (e) { notify(String(e)); } };
  const addSubtitles = (clips: ReturnType<typeof parseSrt>) => {
    if (!clips.length) return;
    commit(old => { const next = structuredClone(old); let track = next.tracks.find(t => t.kind === 'subtitle' && !t.locked); if (!track) { track = newTrack('subtitle', `S${next.tracks.filter(t => t.kind === 'subtitle').length + 1}`); next.tracks.push(track); } track.clips.push(...clips); track.clips.sort((a, b) => a.start - b.start); return next; }); selectClip(clips[0].id);
  };
  const addSubtitle = () => { const c = { id: uid(), assetId: null, name: '字幕', text: '', start: snapFrame(time, p.fps), duration: Math.min(3, Math.max(1 / fpsValue(p.fps), projectDuration(p) - time)), sourceStart: 0, rate: 1, reverse: false, freeze: null, effects: defaultEffects(), transition: { type: 'none' as const, duration: 0 }, loop: false, crossfade: 0, trimSilence: false }; addSubtitles([c]); };
  const importSrt = async () => { try { const result = await window.framelab.importSrt(); if (result) addSubtitles(parseSrt(result.text)); } catch (e) { notify(String(e)); } };
  const saveSrt = async () => { try { const file = await window.framelab.exportSrt(exportSrt(p.tracks.filter(t => t.kind === 'subtitle' && !t.hidden).flatMap(t => t.clips))); if (file) setStatus(`字幕已保存：${file}`); } catch (e) { notify(String(e)); } };
  const transcribe = async () => { setPlaying(false); try { const result = await window.framelab.transcribe(history.current.current); addSubtitles(parseSrt(result.text)); } catch (e) { notify(String(e)); } };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!bootstrap || error || exportTab || recovery || assetStore) return;
      const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase(), target = e.target as HTMLElement;
      if (ctrl && key === 's') { e.preventDefault(); void save(e.shiftKey); return; }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return;
      if (ctrl && key === 'z') { e.preventDefault(); setPlaying(false); if (e.shiftKey) history.redo(); else history.undo(); setDirty(true); }
      else if (ctrl && key === 'y') { e.preventDefault(); setPlaying(false); history.redo(); setDirty(true); }
      else if (ctrl && key === 'o') { e.preventDefault(); void open(); }
      else if (ctrl && key === 'i') { e.preventDefault(); void importFiles(); }
      else if (ctrl && key === 'd') { e.preventDefault(); duplicateClip(); }
      else if (e.code === 'Space') { e.preventDefault(); setPlaying(v => !v); }
      else if (key === 'delete' || key === 'backspace') { e.preventDefault(); removeClip(); }
      else if (key === 's' && !ctrl) split();
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(time - 1 / fpsValue(p.fps)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seek(time + 1 / fpsValue(p.fps)); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  });
  if (!bootstrap) return <div className="startup"><Film size={30} /><h1>FrameLab</h1>{initError ? <><p role="alert">{initError}</p><button className="command" onClick={() => location.reload()}><RotateReload />重新初始化</button></> : <><LoaderCircle size={20} className="spin" /><p>{status}</p></>}</div>;
  const active = jobs.find(j => !['completed', 'failed', 'cancelled'].includes(j.stage)), source = p.media.find(m => m.id === assetIds[0]) || null;
  const closeMenu = (action: () => void) => { document.querySelectorAll<HTMLDetailsElement>('.app-menu[open]').forEach(menu => { menu.open = false; }); action(); };
  return <main className={`editor ${leftOpen ? 'show-library' : ''} ${rightOpen ? 'show-inspector' : ''}`} style={{ '--timeline-height': `${timelineHeight}px` } as CSSProperties} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); const files = Array.from(e.dataTransfer.files).map(f => window.framelab.filePath(f)).filter(Boolean); if (files.length) void importFiles(files); }}>
    <header className="app-header"><div className="brand"><Film size={20} /><strong>FrameLab</strong></div><details className="app-menu"><summary>文件<ChevronDown size={12} /></summary><div className="menu-items"><button onClick={() => closeMenu(() => { if (!dirty || confirm('新建项目？当前改动已有自动保存，仍建议先保存。')) reset(newProject()); })}><Plus size={15} />新建项目</button><button onClick={() => closeMenu(() => void open())}><FolderOpen size={15} />打开项目</button><button onClick={() => closeMenu(() => void save())}><Save size={15} />保存项目</button><button onClick={() => closeMenu(() => void save(true))}><Save size={15} />另存项目</button><hr /><small>最近项目</small>{recent.length ? recent.slice(0, 8).map(r => <button className="recent-project" key={r.path} title={r.path} onClick={() => closeMenu(() => void open(r.path))}><Film size={14} /><span>{r.name}</span></button>) : <span className="menu-empty">暂无最近项目</span>}</div></details><details className="app-menu"><summary>字幕<ChevronDown size={12} /></summary><div className="menu-items"><button onClick={() => closeMenu(addSubtitle)}><Plus size={15} />新建字幕</button><button onClick={() => closeMenu(() => void importSrt())}><FolderOpen size={15} />导入 SRT</button><button disabled={!p.tracks.some(t => t.kind === 'subtitle' && t.clips.length)} onClick={() => closeMenu(() => void saveSrt())}><Captions size={15} />导出 SRT</button><hr /><button disabled={!bootstrap.capabilities.speech.available} title={bootstrap.capabilities.speech.reason} onClick={() => closeMenu(() => void transcribe())}><ScanText size={15} />自动字幕{!bootstrap.capabilities.speech.available ? ' · 不可用' : ''}</button></div></details><div className="project-title" title={p.path || p.name}>{p.name}{dirty && <span className="unsaved-dot" />}</div><div className="header-tools"><IconButton icon={FolderOpen} label="导入素材" disabled={importing} onClick={() => void importFiles()} /><IconButton icon={Save} label="保存项目" onClick={() => void save()} /><span className="toolbar-divider" /><IconButton icon={PanelLeft} label="显示素材库" active={leftOpen} onClick={() => { setLeftOpen(!leftOpen); if (window.innerWidth < 980) setRightOpen(false); }} /><IconButton icon={PanelRight} label="显示属性面板" active={rightOpen} onClick={() => { setRightOpen(!rightOpen); if (window.innerWidth < 980) setLeftOpen(false); }} /><button className="command queue-command" onClick={() => setExportTab('queue')}><ListVideo size={15} /><span>队列</span>{active && <small>{jobs.filter(j => !['completed', 'failed', 'cancelled'].includes(j.stage)).length}</small>}</button><button className="command primary" onClick={() => setExportTab('settings')} disabled={!projectDuration(p)}><Download size={15} /><span>导出</span></button></div></header>
    <div className="workspace"><MediaPanel project={p} selected={assetIds} library={library} importing={importing} onImport={() => void importFiles()} onSelect={ids => { setSelected(null); setAssetIds(ids); setMode('source'); setPlaying(false); }} onAppend={append} onRemove={id => commit(old => ({ ...old, media: old.media.filter(m => m.id !== id) }))} onLibraryImport={(entry, asMusic) => void libraryImport(entry, asMusic)} onRefresh={() => void window.framelab.refreshAssets().then(setLibrary).catch(e => notify(String(e)))} onStore={m => { setAssetStore(m); setAssetSource(''); setAssetLicense('授权未确认；仅用户本地素材'); }} onRelink={id => void relink(id)} audioPath={bootstrap.paths.audio} />
      <Preview project={p} time={time} onTime={setTime} playing={playing} onPlaying={setPlaying} source={source} mode={mode} onMode={setMode} onError={notify} />
      <Inspector project={p} selected={selected} asset={source} capabilities={bootstrap.capabilities} time={time} commit={commit} onTime={seek} onRelink={id => void relink(id)} onImportSrt={() => void importSrt()} onExportSrt={() => void saveSrt()} onSubtitle={addSubtitle} onTranscribe={() => void transcribe()} onError={notify} />
    </div>
    <div className="timeline-resizer" role="separator" aria-label="调整时间线高度" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); resize.current = { y: e.clientY, height: timelineHeight }; }} onPointerMove={e => { if (resize.current) setTimelineHeight(Math.max(160, Math.min(window.innerHeight - 260, resize.current.height + resize.current.y - e.clientY))); }} onPointerUp={() => { resize.current = null; }} onPointerCancel={() => { resize.current = null; }} />
    <Timeline project={p} selected={selected} time={time} onTime={seek} onSelect={selectClip} commit={commit} undo={() => { history.undo(); setPlaying(false); setDirty(true); }} redo={() => { history.redo(); setPlaying(false); setDirty(true); }} canUndo={history.canUndo} canRedo={history.canRedo} onSplit={split} onDelete={removeClip} onDuplicate={duplicateClip} onDropMedia={onDropMedia} />
    <footer className="status-bar"><span title={status}>{importing ? <LoaderCircle className="spin" size={12} /> : <span className="state-dot good" />}{active ? `${active.phase}${active.percent !== null ? ` ${active.percent.toFixed(1)}%` : ''}` : status}</span><span>{saveStatus && <Check size={12} />}{saveStatus}<HardDrive size={12} /><button title={bootstrap.paths.data} onClick={() => void window.framelab.reveal(bootstrap.paths.data)}>D: 本地项目</button></span></footer>
    {exportTab && <ExportPanel project={p} capabilities={bootstrap.capabilities} jobs={jobs} initialTab={exportTab} onClose={() => setExportTab(null)} onEnqueue={async (settings: ExportSettings) => { await window.framelab.enqueue(history.current.current, settings); }} onError={notify} />}
    {recovery && <Modal title="恢复未保存项目" onClose={() => {}}><div className="recovery-body"><Film size={22} /><strong>{recovery.name}</strong><span>{recovery.updatedAt}</span><span>{recovery.tracks.reduce((n, t) => n + t.clips.length, 0)} 个片段</span></div><footer className="modal-footer"><button className="command" onClick={() => setRecovery(null)}>使用当前项目</button><button className="command primary" onClick={() => { reset(recovery); setDirty(true); setRecovery(null); }}>打开恢复版本</button></footer></Modal>}
    {assetStore && <Modal title="复制到 D 盘配乐库" onClose={() => setAssetStore(null)}><form className="asset-form" onSubmit={e => { e.preventDefault(); void window.framelab.addAsset(assetStore.path, assetSource, assetLicense).then(async () => { setLibrary(await window.framelab.refreshAssets()); setAssetStore(null); setStatus('已复制到 D 盘配乐库，原文件未修改'); }).catch(e => notify(String(e))); }}><strong>{assetStore.name}</strong><label className="field"><span>来源</span><input aria-label="素材来源" value={assetSource} onChange={e => setAssetSource(e.target.value)} /></label><label className="field"><span>授权情况</span><input aria-label="素材授权" required value={assetLicense} onChange={e => setAssetLicense(e.target.value)} /></label><footer className="modal-footer"><button className="command" type="button" onClick={() => setAssetStore(null)}>取消</button><button className="command primary" type="submit"><Music2 size={15} />复制音频</button></footer></form></Modal>}
    {error && <Modal title="处理提示" onClose={() => setError('')}><pre className="error-message" role="alert">{error}</pre><footer className="modal-footer"><button className="command" onClick={() => setError('')}>关闭</button></footer></Modal>}
  </main>;
}
function RotateReload() { return <LoaderCircle size={15} />; }
