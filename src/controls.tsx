import { useEffect, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { X, type LucideIcon } from 'lucide-react';
export function IconButton({ icon: Icon, label, active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean }) {
  return <button {...props} className={`icon-button ${active ? 'active' : ''} ${props.className || ''}`} title={label} aria-label={label}><Icon size={16} strokeWidth={1.7} /></button>;
}
export function NumberField({ label, value, onChange, min = 0, max = 86400, step = 0.01, unit, disabled }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; unit?: string; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(5))));
  useEffect(() => { setDraft(String(Number(value.toFixed(5)))); }, [value]);
  const commit = () => { const n = Number(draft); if (draft !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n))); else setDraft(String(value)); };
  return <label className="number-field"><span>{label}</span><div><input aria-label={label} type="number" disabled={disabled} step={step} min={min} max={max} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />{unit && <small>{unit}</small>}</div></label>;
}
export function SliderField({ label, value, onChange, min, max, step = 0.01, unit = '', disabled, extra }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number; unit?: string; disabled?: boolean; extra?: ReactNode }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return <div className="slider-field"><div><span>{label}</span>{extra}<output>{Number(draft.toFixed(2))}{unit}</output></div><input aria-label={label} type="range" min={min} max={max} step={step} disabled={disabled} value={draft} onChange={e => setDraft(Number(e.target.value))} onPointerUp={() => onChange(draft)} onKeyUp={() => onChange(draft)} /></div>;
}
export function CheckField({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className="check-field"><input type="checkbox" checked={value} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span>{label}</span></label>;
}
export function Section({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  return <details className="property-section" open={open}><summary>{title}</summary><div className="section-body">{children}</div></details>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const listener = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [onClose]);
  return <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><IconButton icon={X} label="关闭" onClick={onClose} /></header>{children}</section></div>;
}
export const fileSize = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
export const basename = (filename: string) => filename.split(/[/\\]/).at(-1) || filename;
