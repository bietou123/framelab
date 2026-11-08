import { useCallback, useRef, useState } from 'react';
import type { Media, Project } from '../shared/types';
import { fitMusic } from '../shared/model';
export function useHistory(initial: Project) {
  const [project, setProject] = useState(initial);
  const [revision, setRevision] = useState(0);
  const current = useRef(project), past = useRef<Project[]>([]), future = useRef<Project[]>([]);
  const commit = useCallback((value: Project | ((p: Project) => Project)) => {
    const before = current.current, next = typeof value === 'function' ? value(before) : value;
    if (next === before || JSON.stringify(next) === JSON.stringify(before)) return;
    past.current = [...past.current.slice(-79), before]; future.current = [];
    const adjusted = fitMusic({ ...next, updatedAt: new Date().toISOString() });
    current.current = adjusted; setProject(adjusted); setRevision(r => r + 1);
  }, []);
  const reset = useCallback((p: Project) => { current.current = p; past.current = []; future.current = []; setProject(p); setRevision(r => r + 1); }, []);
  const undo = useCallback(() => {
    const value = past.current.pop(); if (!value) return;
    future.current.push(current.current); current.current = { ...value, updatedAt: new Date().toISOString() }; setProject(current.current); setRevision(r => r + 1);
  }, []);
  const redo = useCallback(() => {
    const value = future.current.pop(); if (!value) return;
    past.current.push(current.current); current.current = { ...value, updatedAt: new Date().toISOString() }; setProject(current.current); setRevision(r => r + 1);
  }, []);
  const hydrate = useCallback((m: Media) => {
    const replace = (p: Project) => p.media.some(a => a.id === m.id) ? { ...p, media: p.media.map(a => a.id === m.id ? { ...m } : a) } : p;
    current.current = replace(current.current); past.current = past.current.map(replace); future.current = future.current.map(replace); setProject(current.current);
  }, []);
  const saved = useCallback((p: Project) => { current.current = { ...current.current, path: p.path, updatedAt: p.updatedAt }; setProject(current.current); }, []);
  return { project, current, commit, reset, undo, redo, hydrate, saved, revision, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
