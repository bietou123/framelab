export type Rational = `${number}/${number}`;
export type MediaKind = 'video' | 'audio' | 'image';
export interface MediaStream {
  index: number; type: string; codec: string; profile?: string; width?: number; height?: number;
  fps?: Rational; timeBase?: Rational; pixFmt?: string; duration?: number; frames?: number;
  bitRate?: number; sampleRate?: number; channels?: number; channelLayout?: string;
  colorSpace?: string; colorTransfer?: string; colorPrimaries?: string; colorRange?: string;
  extradataHash?: string; attachedPicture?: boolean; rotation?: number; language?: string;
  sideData?: unknown[];
}
export interface Media {
  id: string; path: string; name: string; kind: MediaKind; size: number; modified: number;
  duration: number; streams: MediaStream[]; video?: MediaStream; audio?: MediaStream;
  format: string; bitRate: number; hdr: boolean; missing?: boolean;
  thumbnail?: string; waveform?: number[]; preview?: string; previewState?: 'source' | 'pending' | 'ready' | 'failed';
  previewError?: string;
}
export interface Key { at: number; value: number }
export type KeyProperty = 'x' | 'y' | 'scale' | 'opacity' | 'volumeDb';
export interface Effects {
  crop: { left: number; top: number; right: number; bottom: number };
  rotation: 0 | 90 | 180 | 270; mirrorX: boolean; mirrorY: boolean;
  x: number; y: number; scale: number; opacity: number;
  exposure: number; contrast: number; saturation: number; temperature: number; lut: string | null;
  volumeDb: number; fadeIn: number; fadeOut: number; denoise: boolean;
  keys: Partial<Record<KeyProperty, Key[]>>;
}
export interface Clip {
  id: string; assetId: string | null; name: string; start: number; duration: number; sourceStart: number;
  rate: number; reverse: boolean; freeze: number | null; effects: Effects;
  transition: { type: 'none' | 'dissolve'; duration: number };
  loop: boolean; crossfade: number; trimSilence: boolean;
  coverProject?: boolean;
  text?: string;
}
export interface Track {
  id: string; kind: 'video' | 'audio' | 'subtitle'; name: string; locked: boolean; muted: boolean; hidden: boolean; clips: Clip[];
}
export interface SubtitleStyle {
  font: string; size: number; color: string; outline: string; outlineWidth: number; position: 'bottom' | 'middle' | 'top';
}
export interface Project {
  version: 1; id: string; name: string; path?: string; updatedAt: string;
  width: number; height: number; fps: Rational; media: Media[]; tracks: Track[];
  subtitleStyle: SubtitleStyle; includeSourceAudio: boolean;
}
export interface ExportSettings {
  path: string; codec: 'h264' | 'hevc' | 'av1' | 'copy'; encoder: 'auto' | 'software' | string;
  preset: 'fast' | 'balanced' | 'quality'; maxBytes: number | null;
  videoKbps: number | null; audioKbps: number; audioSampleRate: number;
  width: number; height: number; fps: Rational; hdr: 'preserve' | 'sdr';
  decode: 'software' | 'auto'; threads: number; verifyDecode: boolean;
}
export interface BitrateBudget {
  duration: number; limit: number | null; audioBits: number; overheadBytes: number; safetyBytes: number;
  videoKbps: number; estimatedBytes: number;
}
export type JobStage = 'queued' | 'preparing' | 'encoding' | 'packaging' | 'verifying' | 'completed' | 'failed' | 'cancelled';
export interface Validation {
  passed: boolean; size: number; duration: number; frames: number; width: number; height: number; fps: string;
  videoCodec: string; audioCodec?: string; audioEnd: number; decoded: boolean;
  packets: number; boundaryChecks: { time: number; maximumGap: number; monotonic: boolean }[];
  issues: string[]; warnings: string[];
}
export interface Job {
  id: string; projectName: string; output: string; stage: JobStage; phase: string;
  percent: number | null; mediaSeconds: number; speed: number; eta: number | null; bytes: number;
  createdAt: string; startedAt?: string; finishedAt?: string; elapsed: number;
  error?: string; log: string[]; logPath?: string; validation?: Validation;
  settings: ExportSettings; budget?: BitrateBudget; encoder?: string;
}
export interface Encoder { name: string; codec: 'h264' | 'hevc' | 'av1'; hardware: boolean; vendor: string; available: boolean; reason?: string }
export interface Capabilities { ffmpeg: string; ffprobe: string; version: string; encoders: Encoder[]; speech: { available: boolean; model?: string; reason: string }; fonts: string[] }
export interface AssetEntry { id: string; path: string; name: string; source: string; license: string; notes: string; addedAt: string }
export interface RecentProject { path: string; name: string; updatedAt: string }
export interface Bootstrap {
  project: Project; recovery?: Project; recent: RecentProject[]; library: AssetEntry[];
  capabilities: Capabilities; jobs: Job[]; paths: { data: string; audio: string; cache: string };
}
export type BackendEvent = { type: 'job'; job: Job } | { type: 'media'; media: Media } | { type: 'status'; text: string };
export interface EditorAPI {
  bootstrap(): Promise<Bootstrap>;
  importMedia(paths?: string[]): Promise<{ media: Media[]; errors: { path: string; error: string }[] }>;
  ensurePreview(id: string, force?: boolean): Promise<void>;
  previewAudio(project: Project): Promise<string | null>;
  renderFrame(project: Project, time: number): Promise<string>;
  cancelPreview(kind: 'audio' | 'frame'): Promise<void>;
  mediaUrl(path: string): string;
  filePath(file: File): string;
  saveProject(project: Project, saveAs?: boolean): Promise<Project | null>;
  openProject(path?: string): Promise<Project | null>;
  autosave(project: Project): Promise<void>;
  relink(id: string): Promise<Media | null>;
  addAsset(path: string, source: string, license: string): Promise<AssetEntry>;
  refreshAssets(): Promise<AssetEntry[]>;
  pickFile(kind: 'lut' | 'music'): Promise<string | null>;
  importSrt(): Promise<{ path: string; text: string } | null>;
  exportSrt(text: string): Promise<string | null>;
  transcribe(project: Project): Promise<{ text: string; path: string }>;
  exportDialog(name: string): Promise<string | null>;
  enqueue(project: Project, settings: ExportSettings): Promise<Job>;
  cancel(id: string): Promise<void>;
  retry(id: string, smaller?: boolean): Promise<Job>;
  reveal(path: string): Promise<void>;
  onEvent(listener: (event: BackendEvent) => void): () => void;
}
