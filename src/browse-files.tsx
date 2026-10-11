import { useMemo, useState } from "react";
import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Color,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  getPreferenceValues,
  open,
  showInFinder,
  showToast,
  useNavigation,
  Keyboard,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  FAVORITES,
  FileEntry,
  expandHome,
  fileKind,
  formatDate,
  formatSize,
  listDir,
  parentDir,
} from "./fs-utils";
import {
  addPaths,
  clearAll,
  ensurePath,
  removePaths,
  setOperation,
  togglePath,
  useGlobalSelection,
} from "./selection-store";
import { copyManyWithProgress, moveManyWithProgress } from "./copy-progress";
import {
  archiveDisplayName,
  compressMany,
  compressOne,
  extractZip,
} from "./archive";
import { safeTrash, shortError } from "./trash-safe";

type Prefs = {
  startingPath?: string;
  showHiddenDefault?: boolean;
};

function getPrefs(): Prefs {
  try {
    return getPreferenceValues<Prefs>();
  } catch {
    return {};
  }
}

export default function Command() {
  const p = getPrefs();
  const start = expandHome(p.startingPath || "~");
  const [showHidden, setShowHidden] = useState<boolean>(!!p.showHiddenDefault);
  const [showDetail, setShowDetail] = useState(false);
  return (
    <FileBrowser
      initialPath={start}
      showHidden={showHidden}
      showDetail={showDetail}
      canPop={false}
      onToggleHidden={() => setShowHidden((v) => !v)}
      onToggleDetail={() => setShowDetail((v) => !v)}
    />
  );
}

function matchesFilter(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function FileBrowser(props: {
  initialPath: string;
  showHidden: boolean;
  showDetail: boolean;
  /**
   * Whether this view was pushed on top of another browser view (so pop()
   * returns to it). The very first view has canPop=false: popping it would
   * exit the whole extension, so back-navigation pushes the parent instead.
   */
  canPop: boolean;
  onToggleHidden: () => void;
  onToggleDetail: () => void;
}) {
  const { push, pop } = useNavigation();
  const [currentPath] = useState(props.initialPath);
  const [searchText, setSearchText] = useState("");
  // Global basket + pending copy/move op: survives push/pop so the selection
  // stays visible up the hierarchy, and the main browser IS the destination.
  const { selected, operation } = useGlobalSelection();

  const { data, isLoading, revalidate } = usePromise(
    async (dir: string, hidden: boolean) => {
      try {
        return await listDir(dir, hidden);
      } catch {
        await showToast({
          style: Toast.Style.Failure,
          title: "Cannot read folder",
          message: dir,
        });
        return [] as FileEntry[];
      }
    },
    [currentPath, props.showHidden],
  );

  const entries = useMemo(() => data ?? [], [data]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredEntries = useMemo(
    () => entries.filter((e) => matchesFilter(e.name, searchText)),
    [entries, searchText],
  );

  function toggleSelect(fullPath: string) {
    togglePath(fullPath);
  }

  function selectAll() {
    addPaths(entries.map((e) => e.fullPath));
  }

  function selectFiltered() {
    addPaths(filteredEntries.map((e) => e.fullPath));
  }

  function clearSelection() {
    clearAll();
  }

  function markForCopy(fullPath?: string) {
    if (fullPath) ensurePath(fullPath);
    setOperation("copy");
  }

  function markForMove(fullPath?: string) {
    if (fullPath) ensurePath(fullPath);
    setOperation("move");
  }

  async function pruneMissing() {
    // Drop only paths that no longer exist on disk — NOT paths from other
    // folders. Old code pruned against current-folder entries, which wiped
    // cross-folder selections as soon as you navigated.
    const gone: string[] = [];
    await Promise.all(
      selected.map(async (p) => {
        try {
          await fs.access(p);
        } catch {
          gone.push(p);
        }
      }),
    );
    if (gone.length > 0) removePaths(gone);
  }

  async function refresh() {
    await revalidate();
    await pruneMissing();
  }

  // FIX (back-nav bug): previously enterFolder/jumpTo mutated this view's
  // currentPath AND pushed a new view, corrupting the parent when popping.
  // Now each pushed view owns its path — no mutation of the parent.
  function pushView(dir: string, canPop: boolean) {
    push(
      <FileBrowser
        initialPath={dir}
        showHidden={props.showHidden}
        showDetail={props.showDetail}
        canPop={canPop}
        onToggleHidden={props.onToggleHidden}
        onToggleDetail={props.onToggleDetail}
      />,
    );
  }

  function enterFolder(folderPath: string) {
    pushView(folderPath, true);
  }

  function jumpTo(target: string) {
    const resolved = expandHome(target);
    if (resolved === currentPath) return;
    pushView(resolved, true);
  }

  // Back navigation that never exits the extension: on the first view
  // (canPop=false) there is nothing to pop back to, so going up pushes the
  // parent folder instead of closing the whole command.
  function goBack() {
    if (props.canPop) {
      pop();
      return;
    }
    const parent = parentDir(currentPath);
    if (parent !== currentPath) pushView(parent, false);
  }

  // The main browser IS the destination: paste the global basket into the
  // current folder. Guards against copying a folder into itself/descendant
  // and against moving onto the same folder.
  async function executePaste(mode: "copy" | "move") {
    const sources = [...selected];
    if (sources.length === 0) return;
    for (const src of sources) {
      if (src === currentPath || isInside(currentPath, src)) {
        await showToast({
          style: Toast.Style.Failure,
          title: `Cannot ${mode} a folder into itself`,
          message: src,
        });
        return;
      }
      if (path.dirname(src) === currentPath && mode === "move") {
        await showToast({
          style: Toast.Style.Failure,
          title: "Already in this folder",
          message: currentPath,
        });
        return;
      }
    }
    const verb = mode === "copy" ? "Copying" : "Moving";
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `${verb} ${sources.length} item${sources.length === 1 ? "" : "s"}…`,
      message: `→ ${currentPath}`,
    });
    try {
      if (mode === "copy") {
        const r = await copyManyWithProgress(
          sources,
          currentPath,
          toast,
          "Copying",
        );
        if (r.errors.length > 0) {
          toast.style = Toast.Style.Failure;
          toast.title = `Copied with ${r.errors.length} errors`;
          toast.message = r.errors.slice(0, 3).join("\n");
        } else {
          toast.style = Toast.Style.Success;
          toast.title = `Copied ${r.copied} item${r.copied === 1 ? "" : "s"}`;
          toast.message = `→ ${currentPath}`;
        }
      } else {
        const r = await moveManyWithProgress(
          sources,
          currentPath,
          toast,
          "Moving",
        );
        if (r.errors.length > 0) {
          toast.style = Toast.Style.Failure;
          toast.title = `Moved with ${r.errors.length} errors`;
          toast.message = r.errors.slice(0, 3).join("\n");
        } else {
          toast.style = Toast.Style.Success;
          toast.title = `Moved ${r.moved} item${r.moved === 1 ? "" : "s"}`;
          toast.message = `→ ${currentPath}`;
        }
        removePaths(sources);
      }
      clearAll();
      refresh();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = `${mode === "copy" ? "Copy" : "Move"} failed`;
      toast.message = String(e);
    }
  }

  const crumbs = currentPath.replace(/^\/Users\/[^/]+/, "~");
  const isRoot = currentPath === parentDir(currentPath);

  return (
    <List
      isLoading={isLoading}
      navigationTitle={crumbs}
      searchBarPlaceholder={
        operation
          ? `Paste (${operation}) ${selected.length} items — navigate, Enter on Paste row (${selected.length} selected)`
          : `Filter + ↑↓, X select, → enter, ← back, Space open/preview (${selected.length} selected)`
      }
      searchText={searchText}
      onSearchTextChange={setSearchText}
      filtering={true}
      isShowingDetail={props.showDetail && entries.length > 0}
    >
      <List.Section
        title={currentPath}
        subtitle={
          selected.length > 0
            ? `${entries.length} items · ${selected.length} selected`
            : `${entries.length} items`
        }
      >
        {selected.length > 0 ? (
          operation ? (
            <List.Item
              title={`Paste (${operation === "copy" ? "Copy" : "Move"}) ${selected.length} item${selected.length === 1 ? "" : "s"} Here`}
              subtitle={`${currentPath} — Enter pastes, ← navigates`}
              icon={{ source: Icon.ArrowRight, tintColor: Color.Green }}
              keywords={["paste", "here", "copy", "move", currentPath]}
              quickLook={{
                path: currentPath,
                name: path.basename(currentPath) || currentPath,
              }}
              actions={
                <ActionPanel>
                  <Action
                    title={`Paste Here (${operation === "copy" ? "Copy" : "Move"})`}
                    icon={Icon.ArrowRight}
                    onAction={() => executePaste(operation)}
                  />
                  <Action
                    title={`Switch to ${operation === "copy" ? "Move" : "Copy"}`}
                    icon={Icon.Repeat}
                    onAction={() =>
                      setOperation(operation === "copy" ? "move" : "copy")
                    }
                  />
                  <Action
                    title="Cancel Paste"
                    icon={Icon.XMarkCircle}
                    onAction={() => clearAll()}
                  />
                  <ActionPanel.Section title="Selection">
                    <Action
                      title="Trash Selected"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      onAction={() =>
                        trashPaths([...selected], () => refresh())
                      }
                    />
                    <Action
                      title="Compress Selected to ZIP Here"
                      icon={Icon.Box}
                      onAction={() =>
                        compressSelected([...selected], currentPath, () =>
                          refresh(),
                        )
                      }
                    />
                    <Action.CopyToClipboard
                      title="Copy Selected Paths"
                      content={selected.join("\n")}
                      onCopy={() => Clipboard.copy(selected.join("\n"))}
                    />
                    <Action
                      title="Clear Selection"
                      icon={Icon.XMarkCircle}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "x" }}
                      onAction={clearSelection}
                    />
                  </ActionPanel.Section>
                  {!isRoot ? (
                    <Action
                      title="Go Back"
                      icon={Icon.ArrowLeft}
                      shortcut={{ modifiers: [], key: "arrowLeft" }}
                      onAction={goBack}
                    />
                  ) : null}
                </ActionPanel>
              }
            />
          ) : (
            <List.Item
              title={`${selected.length} Selected — Copy or Move?`}
              subtitle="Choose an operation first, then Enter pastes here"
              icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
              keywords={[
                "selection",
                "selected",
                "batch",
                "paste",
                "copy",
                "move",
              ]}
              quickLook={{
                path: currentPath,
                name: path.basename(currentPath) || currentPath,
              }}
              actions={
                <ActionPanel>
                  <ActionPanel.Submenu title="Paste Selected Here…">
                    <Action
                      title="Copy Here"
                      icon={Icon.Clipboard}
                      onAction={() => executePaste("copy")}
                    />
                    <Action
                      title="Move Here"
                      icon={Icon.Move}
                      onAction={() => executePaste("move")}
                    />
                  </ActionPanel.Submenu>
                  <Action
                    title="Mark for Copy"
                    icon={Icon.Clipboard}
                    shortcut={Keyboard.Shortcut.Common.Copy}
                    onAction={() => markForCopy()}
                  />
                  <Action
                    title="Mark for Move"
                    icon={Icon.Move}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
                    onAction={() => markForMove()}
                  />
                  <ActionPanel.Section title="Selection">
                    <Action
                      title="Trash Selected"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      onAction={() =>
                        trashPaths([...selected], () => refresh())
                      }
                    />
                    <Action
                      title="Compress Selected to ZIP Here"
                      icon={Icon.Box}
                      onAction={() =>
                        compressSelected([...selected], currentPath, () =>
                          refresh(),
                        )
                      }
                    />
                    <Action.CopyToClipboard
                      title="Copy Selected Paths"
                      content={selected.join("\n")}
                      onCopy={() => Clipboard.copy(selected.join("\n"))}
                    />
                    <Action
                      title="Clear Selection"
                      icon={Icon.XMarkCircle}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "x" }}
                      onAction={clearSelection}
                    />
                  </ActionPanel.Section>
                  {!isRoot ? (
                    <Action
                      title="Go Back"
                      icon={Icon.ArrowLeft}
                      shortcut={{ modifiers: [], key: "arrowLeft" }}
                      onAction={goBack}
                    />
                  ) : null}
                </ActionPanel>
              }
            />
          )
        ) : null}
        {!isRoot ? (
          <List.Item
            title=".."
            subtitle="Parent folder (←)"
            icon={Icon.ArrowUp}
            keywords={["up", "back", "parent"]}
            quickLook={{
              path: parentDir(currentPath),
              name: path.basename(parentDir(currentPath)) || "/",
            }}
            actions={
              <ActionPanel>
                <Action
                  title="Go Back"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: [], key: "arrowLeft" }}
                  onAction={goBack}
                />
                <Action
                  title="Go Back Alternative"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: ["cmd"], key: "[" }}
                  onAction={goBack}
                />
              </ActionPanel>
            }
          />
        ) : null}
        {entries.map((entry) => (
          <FileRow
            key={entry.fullPath}
            entry={entry}
            currentPath={currentPath}
            showDetail={props.showDetail}
            isSelected={selectedSet.has(entry.fullPath)}
            selectedCount={selected.length}
            pendingOp={operation}
            searchActive={searchText.trim().length > 0}
            onToggleSelect={() => toggleSelect(entry.fullPath)}
            onSelectAll={selectAll}
            onSelectFiltered={selectFiltered}
            onClearSelection={clearSelection}
            onEnterFolder={enterFolder}
            onJump={jumpTo}
            onMarkCopy={() => markForCopy(entry.fullPath)}
            onMarkMove={() => markForMove(entry.fullPath)}
            onPasteHere={(mode) => executePaste(mode)}
            onChanged={refresh}
            onToggleHidden={props.onToggleHidden}
            onToggleDetail={props.onToggleDetail}
            onGoBack={goBack}
          />
        ))}
      </List.Section>
      {entries.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Folder}
          title="Empty folder"
          description={
            selected.length > 0
              ? "Paste your selection here, or press ← to go back"
              : "Press ← to go back"
          }
          actions={
            <ActionPanel>
              {selected.length > 0 ? (
                operation ? (
                  <Action
                    title={`Paste Here (${operation === "copy" ? "Copy" : "Move"})`}
                    icon={Icon.ArrowRight}
                    onAction={() => executePaste(operation)}
                  />
                ) : (
                  <ActionPanel.Submenu title="Paste Selected Here…">
                    <Action
                      title="Copy Here"
                      icon={Icon.Clipboard}
                      onAction={() => executePaste("copy")}
                    />
                    <Action
                      title="Move Here"
                      icon={Icon.Move}
                      onAction={() => executePaste("move")}
                    />
                  </ActionPanel.Submenu>
                )
              ) : null}
              {!isRoot ? (
                <Action
                  title="Go Back"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: [], key: "arrowLeft" }}
                  onAction={goBack}
                />
              ) : null}
            </ActionPanel>
          }
        />
      ) : null}
    </List>
  );
}

function FileRow(props: {
  entry: FileEntry;
  currentPath: string;
  showDetail: boolean;
  isSelected: boolean;
  selectedCount: number;
  pendingOp: "copy" | "move" | null;
  searchActive: boolean;
  onToggleSelect: () => void;
  onSelectAll: () => void;
  onSelectFiltered: () => void;
  onClearSelection: () => void;
  onEnterFolder: (p: string) => void;
  onJump: (p: string) => void;
  onMarkCopy: () => void;
  onMarkMove: () => void;
  onPasteHere: (mode: "copy" | "move") => void;
  onChanged: () => void;
  onToggleHidden: () => void;
  onToggleDetail: () => void;
  onGoBack: () => void;
}) {
  const { entry, onEnterFolder, onChanged } = props;
  const baseIcon = entry.isDirectory ? Icon.Folder : fileIcon(entry.extension);
  const icon = props.isSelected
    ? { source: Icon.CheckCircle, tintColor: Color.Green }
    : baseIcon;

  const accessories: List.Item.Accessory[] = [];
  if (props.isSelected) {
    accessories.push({ tag: { value: "Selected", color: Color.Green } });
  }
  accessories.push({
    text: entry.isDirectory ? "Folder" : fileKind(entry),
  });
  accessories.push({ date: entry.mtime });

  const detail = props.showDetail ? (
    <List.Item.Detail
      markdown={detailMarkdown(entry, props.isSelected)}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label
            title="Kind"
            text={fileKind(entry)}
          />
          <List.Item.Detail.Metadata.Label
            title="Size"
            text={formatSize(entry.size, entry.isDirectory)}
          />
          <List.Item.Detail.Metadata.Label
            title="Modified"
            text={formatDate(entry.mtime)}
          />
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.Label
            title="Selected"
            text={props.isSelected ? "Yes" : "No"}
          />
          <List.Item.Detail.Metadata.Label title="Path" text={entry.fullPath} />
          <List.Item.Detail.Metadata.Label title="Name" text={entry.name} />
        </List.Item.Detail.Metadata>
      }
    />
  ) : undefined;

  return (
    <List.Item
      title={props.isSelected ? `✓ ${entry.name}` : entry.name}
      subtitle={entry.isDirectory ? undefined : formatSize(entry.size, false)}
      accessories={accessories}
      icon={icon}
      keywords={[entry.name, entry.extension]}
      detail={detail}
      quickLook={{ path: entry.fullPath, name: entry.name }}
      actions={
        <ActionPanel>
          {entry.isDirectory ? (
            <>
              <Action
                title="Open Folder"
                icon={Icon.ArrowRight}
                shortcut={{ modifiers: [], key: "space" }}
                onAction={() => onEnterFolder(entry.fullPath)}
              />
              <Action
                title="Open Folder"
                icon={Icon.ArrowRight}
                shortcut={{ modifiers: [], key: "arrowRight" }}
                onAction={() => onEnterFolder(entry.fullPath)}
              />
            </>
          ) : (
            <>
              <Action
                title="Open File"
                icon={Icon.Document}
                onAction={() => open(entry.fullPath)}
              />
              <Action.ToggleQuickLook
                shortcut={{ modifiers: [], key: "space" }}
              />
            </>
          )}
          {/* FIX 1 — back navigation on EVERY row so ← always works */}
          <Action
            title="Go Back"
            icon={Icon.ArrowLeft}
            shortcut={{ modifiers: [], key: "arrowLeft" }}
            onAction={props.onGoBack}
          />
          <Action
            title="Go Back Alternative"
            icon={Icon.ArrowLeft}
            shortcut={{ modifiers: ["cmd"], key: "[" }}
            onAction={props.onGoBack}
          />
          <Action
            title="Show in Finder"
            icon={Icon.Finder}
            shortcut={Keyboard.Shortcut.Common.Open}
            onAction={() => showInFinder(entry.fullPath)}
          />

          {/* FIX 2 — multi-select: filter, ↑↓ to highlight, X to select */}
          <ActionPanel.Section title="Select">
            <Action
              title={props.isSelected ? "Deselect" : "Select"}
              icon={props.isSelected ? Icon.XMarkCircle : Icon.CheckCircle}
              shortcut={{ modifiers: [], key: "x" }}
              onAction={props.onToggleSelect}
            />
            <Action
              title="Mark for Copy"
              icon={Icon.Clipboard}
              shortcut={Keyboard.Shortcut.Common.Copy}
              onAction={props.onMarkCopy}
            />
            <Action
              title="Mark for Move"
              icon={Icon.Move}
              shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
              onAction={props.onMarkMove}
            />
            {props.selectedCount > 0 ? (
              props.pendingOp ? (
                <Action
                  title={`Paste Here (${props.pendingOp === "copy" ? "Copy" : "Move"})`}
                  icon={Icon.ArrowRight}
                  onAction={() =>
                    props.onPasteHere(props.pendingOp as "copy" | "move")
                  }
                />
              ) : (
                <ActionPanel.Submenu title="Paste Selected Here…">
                  <Action
                    title="Copy Here"
                    icon={Icon.Clipboard}
                    onAction={() => props.onPasteHere("copy")}
                  />
                  <Action
                    title="Move Here"
                    icon={Icon.Move}
                    onAction={() => props.onPasteHere("move")}
                  />
                </ActionPanel.Submenu>
              )
            ) : null}
            <Action
              title="Select All in Folder"
              icon={Icon.CheckRosette}
              shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
              onAction={props.onSelectAll}
            />
            {props.searchActive ? (
              <Action
                title="Select Filtered Results"
                icon={Icon.MagnifyingGlass}
                shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
                onAction={props.onSelectFiltered}
              />
            ) : null}
            {props.selectedCount > 0 ? (
              <Action
                title={`Clear Selection (${props.selectedCount})`}
                icon={Icon.Trash}
                shortcut={{ modifiers: ["cmd", "shift"], key: "x" }}
                onAction={props.onClearSelection}
              />
            ) : null}
          </ActionPanel.Section>

          <ActionPanel.Section title="LaunchBar-style ops">
            <Action.Push
              title="Rename…"
              icon={Icon.Pencil}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              target={<RenameForm entry={entry} onDone={onChanged} />}
            />
            <Action
              title="Duplicate"
              icon={Icon.CopyClipboard}
              shortcut={{ modifiers: ["cmd"], key: "d" }}
              onAction={() => duplicateEntry(entry, onChanged)}
            />
            <Action
              title="Compress to ZIP"
              icon={Icon.Box}
              shortcut={{ modifiers: ["cmd", "shift"], key: "z" }}
              onAction={() => compressEntry(entry, onChanged)}
            />
            {entry.extension === ".zip" ? (
              <Action
                title="Extract Here"
                icon={Icon.Upload}
                onAction={() => extractEntry(entry, onChanged)}
              />
            ) : null}
            <Action
              title="Move to Trash"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["cmd"], key: "backspace" }}
              onAction={() => moveToTrash(entry, onChanged)}
            />
          </ActionPanel.Section>

          <ActionPanel.Section title="Create">
            <Action.Push
              title="New Folder…"
              icon={Icon.NewFolder}
              target={
                <NewFolderForm dir={props.currentPath} onDone={onChanged} />
              }
            />
            <Action.Push
              title="New File…"
              icon={Icon.NewDocument}
              target={
                <NewFileForm dir={props.currentPath} onDone={onChanged} />
              }
            />
          </ActionPanel.Section>

          <ActionPanel.Section title="Copy">
            <Action.CopyToClipboard
              title="Copy Path"
              content={entry.fullPath}
              shortcut={Keyboard.Shortcut.Common.CopyName}
            />
            <Action.CopyToClipboard
              title="Copy File Name"
              content={entry.name}
            />
          </ActionPanel.Section>

          <ActionPanel.Section title="View">
            <Action
              title={
                props.showDetail
                  ? "Hide Details"
                  : "Show Details (Info Browsing)"
              }
              icon={Icon.Sidebar}
              shortcut={{ modifiers: ["cmd"], key: "i" }}
              onAction={props.onToggleDetail}
            />
            <Action
              title="Toggle Hidden Files"
              icon={Icon.Eye}
              shortcut={Keyboard.Shortcut.Common.Pin}
              onAction={props.onToggleHidden}
            />
          </ActionPanel.Section>

          <ActionPanel.Section title="Go">
            {FAVORITES.map((f) => (
              <Action
                key={f.path}
                title={`Go to ${f.title}`}
                icon={Icon.House}
                onAction={() => props.onJump(f.path)}
              />
            ))}
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function fileIcon(ext: string) {
  switch (ext) {
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".heic":
    case ".webp":
      return Icon.Image;
    case ".pdf":
      return Icon.Document;
    case ".mp3":
    case ".wav":
    case ".m4a":
    case ".flac":
      return Icon.Music;
    case ".mp4":
    case ".mov":
    case ".mkv":
      return Icon.Video;
    case ".zip":
    case ".tar":
    case ".gz":
    case ".rar":
    case ".7z":
      return Icon.Box;
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".py":
    case ".rb":
    case ".go":
    case ".rs":
    case ".swift":
      return Icon.Code;
    case ".md":
    case ".txt":
      return Icon.Text;
    default:
      return Icon.Document;
  }
}

function detailMarkdown(entry: FileEntry, isSelected: boolean): string {
  const lines = [
    `# ${entry.name}`,
    ``,
    `${fileKind(entry)} · ${formatSize(entry.size, entry.isDirectory)}`,
    ``,
    `Modified: ${formatDate(entry.mtime)}`,
    isSelected ? `Selected ✓` : ``,
  ];
  if (entry.isDirectory) {
    lines.push(
      "",
      "Space or → enters, ← goes back. X selects, ⌘⇧C marks copy, ⌘⇧M marks move.",
    );
  } else if (entry.extension === ".md" || entry.extension === ".txt") {
    lines.push("", "_Space previews (Quick Look), Enter opens._");
  } else {
    lines.push("", "_Space previews (Quick Look), Enter opens._");
  }
  lines.push("", `\`${entry.fullPath}\``);
  return lines.join("\n");
}

// ---------- Forms ----------

function RenameForm(props: { entry: FileEntry; onDone: () => void }) {
  const { pop } = useNavigation();
  const [name, setName] = useState(props.entry.name);
  const [error, setError] = useState<string | undefined>();
  return (
    <Form
      navigationTitle={`Rename ${props.entry.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Rename"
            onSubmit={async () => {
              if (!name.trim()) {
                setError("Name cannot be empty");
                return;
              }
              const dest = path.join(
                path.dirname(props.entry.fullPath),
                name.trim(),
              );
              if (dest === props.entry.fullPath) {
                pop();
                return;
              }
              try {
                await fs.rename(props.entry.fullPath, dest);
                await showToast({
                  style: Toast.Style.Success,
                  title: "Renamed",
                });
                props.onDone();
                pop();
              } catch (e) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Rename failed",
                  message: String(e),
                });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="New name"
        value={name}
        error={error}
        onChange={setName}
      />
    </Form>
  );
}

function NewFolderForm(props: { dir: string; onDone: () => void }) {
  const { pop } = useNavigation();
  const [name, setName] = useState("Untitled Folder");
  const [error, setError] = useState<string | undefined>();
  return (
    <Form
      navigationTitle={`New folder in ${props.dir}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Create Folder"
            onSubmit={async () => {
              if (!name.trim()) {
                setError("Name cannot be empty");
                return;
              }
              try {
                await fs.mkdir(path.join(props.dir, name.trim()));
                await showToast({
                  style: Toast.Style.Success,
                  title: "Folder created",
                });
                props.onDone();
                pop();
              } catch (e) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Create failed",
                  message: String(e),
                });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Folder name"
        value={name}
        error={error}
        onChange={setName}
      />
    </Form>
  );
}

function NewFileForm(props: { dir: string; onDone: () => void }) {
  const { pop } = useNavigation();
  const [name, setName] = useState("Untitled.txt");
  const [error, setError] = useState<string | undefined>();
  return (
    <Form
      navigationTitle={`New file in ${props.dir}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Create File"
            onSubmit={async () => {
              if (!name.trim()) {
                setError("Name cannot be empty");
                return;
              }
              try {
                await fs.writeFile(path.join(props.dir, name.trim()), "");
                await showToast({
                  style: Toast.Style.Success,
                  title: "File created",
                });
                props.onDone();
                pop();
              } catch (e) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Create failed",
                  message: String(e),
                });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="File name"
        value={name}
        error={error}
        onChange={setName}
      />
    </Form>
  );
}

// ---------- Operations (single + batch, with progress) ----------

async function duplicateEntry(entry: FileEntry, onChanged: () => void) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Duplicating…",
    message: entry.name,
  });
  try {
    const r = await copyManyWithProgress(
      [entry.fullPath],
      path.dirname(entry.fullPath),
      toast,
      "Duplicating",
    );
    if (r.errors.length > 0) {
      toast.style = Toast.Style.Failure;
      toast.title = "Duplicate had errors";
      toast.message = r.errors.slice(0, 3).join("\n");
    } else {
      toast.style = Toast.Style.Success;
      toast.title = "Duplicated";
      toast.message = entry.name;
    }
    onChanged();
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = "Duplicate failed";
    toast.message = String(e);
  }
}

async function moveToTrash(entry: FileEntry, onChanged: () => void) {
  const ok = await confirmAlert({
    title: `Move "${entry.name}" to Trash?`,
    message: entry.fullPath,
    primaryAction: {
      title: "Move to Trash",
      style: Alert.ActionStyle.Destructive,
    },
  });
  if (!ok) return;
  const { trashed, errors } = await safeTrash([entry.fullPath]);
  removePaths(trashed);
  if (errors.length > 0) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Trash failed",
      message: errors.slice(0, 2).join("\n"),
    });
  } else {
    removePaths([entry.fullPath]);
    await showToast({ style: Toast.Style.Success, title: "Moved to Trash" });
  }
  onChanged();
}

async function trashPaths(fullPaths: string[], onDone: () => void) {
  if (fullPaths.length === 0) return;
  const ok = await confirmAlert({
    title: `Move ${fullPaths.length} item${fullPaths.length === 1 ? "" : "s"} to Trash?`,
    message:
      fullPaths.slice(0, 5).join("\n") +
      (fullPaths.length > 5 ? `\n…+${fullPaths.length - 5} more` : ""),
    primaryAction: {
      title: "Move to Trash",
      style: Alert.ActionStyle.Destructive,
    },
  });
  if (!ok) return;
  const { trashed, errors } = await safeTrash(fullPaths);
  removePaths(trashed);
  if (errors.length > 0) {
    await showToast({
      style: Toast.Style.Failure,
      title: `Trash failed (${errors.length} item${errors.length === 1 ? "" : "s"})`,
      message: errors.slice(0, 2).join("\n"),
    });
  } else {
    await showToast({
      style: Toast.Style.Success,
      title: `Trashed ${trashed.length} item${trashed.length === 1 ? "" : "s"}`,
    });
  }
  onDone();
}

async function compressEntry(entry: FileEntry, onChanged: () => void) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Compressing ${entry.name}…`,
  });
  try {
    const { dest } = await compressOne(
      entry.fullPath,
      path.dirname(entry.fullPath),
    );
    toast.style = Toast.Style.Success;
    toast.title = "Compressed";
    toast.message = `→ ${path.basename(dest)}`;
    onChanged();
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = "Compress failed";
    toast.message = shortError(e);
  }
}

async function extractEntry(entry: FileEntry, onChanged: () => void) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Extracting ${entry.name}…`,
  });
  try {
    await extractZip(entry.fullPath, path.dirname(entry.fullPath));
    toast.style = Toast.Style.Success;
    toast.title = "Extracted";
    toast.message = `→ ${path.dirname(entry.fullPath)}`;
    onChanged();
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = "Extract failed";
    toast.message = shortError(e);
  }
}

async function compressSelected(
  fullPaths: string[],
  destDir: string,
  onDone: () => void,
) {
  if (fullPaths.length === 0) return;
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Compressing ${fullPaths.length} items…`,
  });
  try {
    const { dest } = await compressMany(
      fullPaths,
      destDir,
      archiveDisplayName(fullPaths),
      (done, total, name) => {
        toast.message = `${done}/${total} staged · ${name.slice(0, 60)}`;
      },
    );
    toast.style = Toast.Style.Success;
    toast.title = "Compressed";
    toast.message = `→ ${path.basename(dest)}`;
    onDone();
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = "Compress failed";
    toast.message = shortError(e);
  }
}
