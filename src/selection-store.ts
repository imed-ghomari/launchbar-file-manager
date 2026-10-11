import { useSyncExternalStore } from "react";

// Global selection basket shared across every pushed FileBrowser view.
// Per-view useState loses the selection on push/pop — this module singleton
// survives navigation until the user clears it or the command unmounts.

let selected: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): string[] {
  return selected;
}

export function getSelection(): string[] {
  return selected;
}

export function isSelected(fullPath: string): boolean {
  return selected.includes(fullPath);
}

export function togglePath(fullPath: string): void {
  selected = selected.includes(fullPath)
    ? selected.filter((p) => p !== fullPath)
    : [...selected, fullPath];
  emit();
}

export function addPaths(paths: string[]): void {
  if (paths.length === 0) return;
  const set = new Set(selected);
  let changed = false;
  for (const p of paths) {
    if (!set.has(p)) {
      set.add(p);
      changed = true;
    }
  }
  if (changed) {
    selected = [...set];
    emit();
  }
}

export function removePaths(paths: string[]): void {
  if (paths.length === 0) return;
  const rm = new Set(paths);
  const next = selected.filter((p) => !rm.has(p));
  if (next.length !== selected.length) {
    selected = next;
    emit();
  }
}

export function clearSelection(): void {
  if (selected.length > 0) {
    selected = [];
    emit();
  }
}

export function useGlobalSelection(): {
  selected: string[];
  toggle: (p: string) => void;
  add: (paths: string[]) => void;
  remove: (paths: string[]) => void;
  clear: () => void;
} {
  const sel = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    selected: sel,
    toggle: togglePath,
    add: addPaths,
    remove: removePaths,
    clear: clearSelection,
  };
}
