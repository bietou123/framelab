import { useMemo, useState } from 'react';
import { Plus, FolderOpen, Film, Music2, Image, Search, RefreshCw, Trash2, Folder, Play, Copy } from 'lucide-react';
import type { AssetEntry, Media, Project } from '../shared/types';
import { fpsValue, timecode } from '../shared/model';
import { IconButton, fileSize } from './controls';
import { Waveform } from './Waveform';
export interface MediaPanelProps {
  project: Project; library: AssetEntry[]; selected: string[]; importing: boolean;
  onImport: () => void; onSelect: (ids: string[]) => void; onAppend: (ids: string[], music?: boolean) => void;
  onRemove: (id: string) => void; onLibraryImport: (entry: AssetEntry, append: boolean) => void;
  onRefresh: () => void; onStore: (m: Media) => void; onRelink: (id: string) => void; audioPath: string;
}
export function MediaPanel(props: MediaPanelProps) {
  const { project, library, selected } = props;
  const [tab, setTab] = useState('media'), [search, setSearch] = useState(''), [sort, setSort] = useState('import');
  const list = useMemo(() => {
    const result = project.media.filter(m => m.name.toLowerCase().includes(search.toLowerCase()));
    if (sort === 'name') result.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'duration') result.sort((a, b) => a.duration - b.duration);
    return result;
  }, [project.media, search, sort]);
  const choose = (m: Media, e: React.MouseEvent) => {
    if (e.shiftKey && selected.length) {
      const start = list.findIndex(item => item.id === selected[0]), end = list.findIndex(item => item.id === m.id);
      props.onSelect(list.slice(Math.min(start, end), Math.max(start, end) + 1).map(item => item.id));
    } else if (e.ctrlKey || e.metaKey) props.onSelect(selected.includes(m.id) ? selected.filter(id => id !== m.id) : [...selected, m.id]);
    else props.onSelect([m.id]);
  };
  return <aside className="media-panel panel" aria-label="素材库">
    <header className="panel-heading"><h2>素材库</h2><div><IconButton icon={FolderOpen} label="导入媒体" onClick={props.onImport} disabled={props.importing} /><IconButton icon={Plus} label="添加选中素材到时间线" disabled={!selected.length} onClick={() => props.onAppend(selected)} /></div></header>
    <div className="tabs"><button className={tab === 'media' ? 'selected' : ''} onClick={() => setTab('media')}>项目素材 <small>{project.media.length}</small></button><button className={tab === 'music' ? 'selected' : ''} onClick={() => setTab('music')}>配乐库 <small>{library.length}</small></button></div>
    <div className="search-box"><Search size={14} /><input aria-label="搜索素材" placeholder="搜索素材" value={search} onChange={e => setSearch(e.target.value)} /></div>
    {tab === 'media' ? <>
      <div className="media-sort"><span>{selected.length ? `已选择 ${selected.length}` : `${list.length} 个素材`}</span><select aria-label="素材排序" value={sort} onChange={e => setSort(e.target.value)}><option value="import">导入顺序</option><option value="name">文件名</option><option value="duration">时长</option></select></div>
      <div className="media-list">
        {!list.length && <div className="empty-media"><FolderOpen size={30} strokeWidth={1.2} /><button className="command" onClick={props.onImport} disabled={props.importing}><Plus size={15} />{props.importing ? '正在导入' : '导入媒体'}</button></div>}
        {list.map(m => { const Kind = m.kind === 'audio' ? Music2 : m.kind === 'image' ? Image : Film; const used = project.tracks.some(t => t.clips.some(c => c.assetId === m.id));
          return <article className={`media-item ${selected.includes(m.id) ? 'selected' : ''} ${m.missing ? 'missing' : ''}`} key={m.id} data-testid="media-item" draggable={!m.missing} onDragStart={e => { const ids = selected.includes(m.id) ? selected : [m.id]; e.dataTransfer.setData('application/framelab-media', JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'copy'; }} onClick={e => choose(m, e)} onDoubleClick={() => !m.missing && props.onAppend([m.id])} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') props.onSelect([m.id]); }}>
            <div className="media-thumb">{m.thumbnail && !m.missing ? <img src={window.framelab.mediaUrl(m.thumbnail)} alt={m.name} /> : m.waveform ? <Waveform media={m} /> : <Kind size={22} />}<span>{timecode(m.duration).replace(/^00:/, '')}</span></div>
            <div className="media-info"><strong title={m.name}>{m.name}</strong><small>{m.missing ? '素材缺失' : m.video ? `${m.video.width} × ${m.video.height} · ${fpsValue(m.video.fps || '0/1').toFixed(3)} fps` : `${m.audio?.sampleRate || 0} Hz · ${m.audio?.channels || 0} 声道`}</small><small>{m.hdr ? 'HDR · ' : ''}{m.video?.codec || m.audio?.codec} · {fileSize(m.size)}</small></div>
            <div className="media-actions" onClick={e => e.stopPropagation()}>{m.missing ? <IconButton icon={FolderOpen} label="重新定位素材" onClick={() => props.onRelink(m.id)} /> : <IconButton icon={Plus} label={`添加 ${m.name}`} onClick={() => props.onAppend([m.id])} />}{m.kind === 'audio' && <IconButton icon={Copy} label="复制到 D 盘配乐库" onClick={() => props.onStore(m)} />}<IconButton icon={Trash2} label="从项目移除素材" disabled={used} onClick={() => props.onRemove(m.id)} /></div>
          </article>;
        })}
      </div>
      <footer className="media-footer"><span>{props.importing ? '正在读取媒体信息' : `${project.media.filter(m => m.missing).length} 个缺失素材`}</span><button className="subtle" onClick={() => props.onAppend(selected, true)} disabled={!selected.some(id => project.media.find(m => m.id === id)?.kind === 'audio')}><Music2 size={14} />设为全片配乐</button></footer>
    </> : <>
      <div className="media-sort"><span>D 盘 · 本地音频</span><div><IconButton icon={Folder} label="打开配乐库目录" onClick={() => void window.framelab.reveal(props.audioPath)} /><IconButton icon={RefreshCw} label="刷新配乐库" onClick={props.onRefresh} /></div></div>
      <div className="media-list">{library.filter(e => e.name.toLowerCase().includes(search.toLowerCase())).map(entry => <article className="library-item" key={entry.id}>
        <Music2 size={19} /><div><strong title={entry.name}>{entry.name}</strong><small className={/未|unknown|未经/i.test(entry.license) ? 'warning-text' : ''} title={`${entry.source}\n${entry.notes}`}>{entry.license || '授权未确认'}</small></div><div className="library-actions"><IconButton icon={Play} label={`预听 ${entry.name}`} onClick={() => props.onLibraryImport(entry, false)} /><IconButton icon={Plus} label="添加为全片配乐" onClick={() => props.onLibraryImport(entry, true)} /></div>
      </article>)}{!library.length && <div className="empty-media"><Music2 size={30} strokeWidth={1.2} /><span>暂无本地配乐</span></div>}</div>
      <footer className="media-footer"><span>{library.length} 个素材</span><button className="subtle" onClick={props.onImport}><FolderOpen size={14} />导入音频</button></footer>
    </>}
  </aside>;
}
