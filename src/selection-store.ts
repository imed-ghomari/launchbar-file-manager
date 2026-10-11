import { useSyncExternalStore } from "react";

// Global selection basket + pending copy/move operation, shared across every
// pushed FileBrowser view. Per-view useState loses the selection on push/pop,
// so this module singleton survives navigation until the user pastes, clears,
// or quits the command.

export type Operation = "copy" | "move" | null;

let selected: string[] = [];
let operation: Operation = null;
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version++;
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getVersion(): number {
  return version;
}

export function getSelection(): string[] {
  return selected;
}

export function getOperation(): Operation {
  return operation;
}

export function setOperation(op: Exclude<Operation, null>): void {
  if (operation !== op) {
    operation = op;
    emit();
  }
}

export function clearOperation(): void {
  if (operation !== null) {
    operation = null;
    emit();
  }
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

export function ensurePath(fullPath: string): void {
  if (!selected.includes(fullPath)) {
    selected = [...selected, fullPath];
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

/** Clears both the basket and any pending copy/move operation. */
export function clearAll(): void {
  if (selected.length > 0 || operation !== null) {
    selected = [];
    operation = null;
    emit();
  }
}

export function useGlobalSelection(): {
  selected: string[];
  operation: Operation;
  toggle: (p: string) => void;
  add: (paths: string[]) => void;
  ensure: (p: string) => void;
  remove: (paths: string[]) => void;
  clear: () => void;
  setOp: (op: Exclude<Operation, null>) => void;
  clearOp: () => void;
} {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return {
    selected: getSelection(),
    operation: getOperation(),
    toggle: togglePath,
    add: addPaths,
    ensure: ensurePath,
    remove: removePaths,
    clear: clearAll,
    setOp: setOperation,
    clearOp: clearOperation,
  };
}
