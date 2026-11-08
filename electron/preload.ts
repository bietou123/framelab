import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { BackendEvent, EditorAPI } from '../shared/types';
const call = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`framelab:${name}`, ...args);
const api: EditorAPI = {
  bootstrap: () => call('bootstrap'), importMedia: paths => call('import', paths), ensurePreview: (id, force) => call('preview', id, force),
  previewAudio: project => call('preview-audio', project), renderFrame: (project, time) => call('render-frame', project, time),
  cancelPreview: kind => call('cancel-preview', kind),
  mediaUrl: filename => `framelab://local/media?path=${encodeURIComponent(filename)}`,
  filePath: file => webUtils.getPathForFile(file),
  saveProject: (p, as) => call('save', p, as), openProject: filename => call('open', filename), autosave: p => call('autosave', p), relink: id => call('relink', id),
  addAsset: (filename, source, license) => call('asset-add', filename, source, license), refreshAssets: () => call('assets'), pickFile: kind => call('pick', kind),
  importSrt: () => call('srt-open'), exportSrt: text => call('srt-save', text), transcribe: p => call('transcribe', p), exportDialog: name => call('export-dialog', name),
  enqueue: (p, s) => call('enqueue', p, s), cancel: id => call('cancel', id), retry: (id, smaller) => call('retry', id, smaller), reveal: filename => call('reveal', filename),
  onEvent: listener => { const handler = (_: unknown, event: BackendEvent) => listener(event); ipcRenderer.on('framelab:event', handler); return () => ipcRenderer.removeListener('framelab:event', handler); },
};
contextBridge.exposeInMainWorld('framelab', api);
