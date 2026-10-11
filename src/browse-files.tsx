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
import trash from "trash";
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
  clearSelection as clearGlobalSelection,
  removePaths,
  togglePath,
  useGlobalSelection,
} from "./selection-store";
import { copyManyWithProgress } from "./copy-progress";
import { DestinationPicker } from "./destination-picker";

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

function FileBrowser(props: {
  initialPath: string;
  showHidden: boolean;
  showDetail: boolean;
  onToggleHidden: () => void;
  onToggleDetail: () => void;
}) {
  const { push, pop } = useNavigation();
  const [currentPath] = useState(props.initialPath);
  const [searchText, setSearchText] = useState("");
  // Global basket: survives push/pop so selection stays visible up the hierarchy.
  const { selected, toggle, add, clear } = useGlobalSelection();

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
  const selectedEntries = useMemo(
    () => entries.filter((e) => selectedSet.has(e.fullPath)),
    [entries, selectedSet],
  );
  const filteredEntries = useMemo(
    () => entries.filter((e) => matchesFilter(e.name, searchText)),
    [entries, searchText],
  );

  function toggleSelect(fullPath: string) {
    togglePath(fullPath);
    void toggle;
  }

  function selectAll() {
    addPaths(entries.map((e) => e.fullPath));
    void add;
  }

  function selectFiltered() {
    addPaths(filteredEntries.map((e) => e.fullPath));
  }

  function clearSelection() {
    clearGlobalSelection();
    void clear;
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
  function enterFolder(folderPath: string) {
    push(
      <FileBrowser
        initialPath={folderPath}
        showHidden={props.showHidden}
        showDetail={props.showDetail}
        onToggleHidden={props.onToggleHidden}
        onToggleDetail={props.onToggleDetail}
      />,
    );
  }

  function jumpTo(target: string) {
    const resolved = expandHome(target);
    if (resolved === currentPath) return;
    push(
      <FileBrowser
        initialPath={resolved}
        showHidden={props.showHidden}
        showDetail={props.showDetail}
        onToggleHidden={props.onToggleHidden}
        onToggleDetail={props.onToggleDetail}
      />,
    );
  }

  // LaunchBar-style: browse to the destination in the same UI, Enter confirms.
  function pickDestination(mode: "copy" | "move", sources: string[]) {
    if (sources.length === 0) return;
    push(
      <DestinationPicker
        sources={sources}
        mode={mode}
        initialPath={currentPath}
        showHidden={props.showHidden}
        onDone={refresh}
      />,
    );
  }

  const crumbs = currentPath.replace(/^\/Users\/[^/]+/, "~");
  const isRoot = currentPath === parentDir(currentPath);

  return (
    <List
      isLoading={isLoading}
      navigationTitle={crumbs}
      searchBarPlaceholder={`Filter + ↑↓, X select, → enter, ← back (${selected.length} selected)`}
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
          <List.Item
            title={`${selected.length} Selected`}
            subtitle={
              selectedEntries.length === selected.length
                ? "Batch actions — trash, copy, move (stays until cleared)"
                : `${selectedEntries.length} in this folder · ${selected.length} total — stays until cleared`
            }
            icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
            keywords={["selection", "selected", "batch"]}
            actions={
              <ActionPanel>
                <Action
                  title="Trash Selected"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() =>
                    trashPaths([...selected], () => {
                      refresh();
                    })
                  }
                />
                <Action
                  title="Copy Selected to… (Browse)"
                  icon={Icon.Clipboard}
                  shortcut={Keyboard.Shortcut.Common.Copy}
                  onAction={() => pickDestination("copy", [...selected])}
                />
                <Action
                  title="Move Selected to… (Browse)"
                  icon={Icon.Move}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
                  onAction={() => pickDestination("move", [...selected])}
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
                {!isRoot ? (
                  <Action
                    title="Go Back"
                    icon={Icon.ArrowLeft}
                    shortcut={{ modifiers: [], key: "arrowLeft" }}
                    onAction={() => pop()}
                  />
                ) : null}
              </ActionPanel>
            }
          />
        ) : null}
        {!isRoot ? (
          <List.Item
            title=".."
            subtitle="Parent folder (←)"
            icon={Icon.ArrowUp}
            keywords={["up", "back", "parent"]}
            actions={
              <ActionPanel>
                <Action
                  title="Go Back"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: [], key: "arrowLeft" }}
                  onAction={() => pop()}
                />
                <Action
                  title="Go Back Alternative"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: ["cmd"], key: "[" }}
                  onAction={() => pop()}
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
            searchActive={searchText.trim().length > 0}
            onToggleSelect={() => toggleSelect(entry.fullPath)}
            onSelectAll={selectAll}
            onSelectFiltered={selectFiltered}
            onClearSelection={clearSelection}
            onEnterFolder={enterFolder}
            onJump={jumpTo}
            onPickDestination={pickDestination}
            onChanged={refresh}
            onToggleHidden={props.onToggleHidden}
            onToggleDetail={props.onToggleDetail}
            onGoBack={() => pop()}
          />
        ))}
      </List.Section>
      {entries.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Folder}
          title="Empty folder"
          description="Press ← to go back"
          actions={
            <ActionPanel>
              {!isRoot ? (
                <Action
                  title="Go Back"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: [], key: "arrowLeft" }}
                  onAction={() => pop()}
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
  searchActive: boolean;
  onToggleSelect: () => void;
  onSelectAll: () => void;
  onSelectFiltered: () => void;
  onClearSelection: () => void;
  onEnterFolder: (p: string) => void;
  onJump: (p: string) => void;
  onPickDestination: (mode: "copy" | "move", sources: string[]) => void;
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
            <Action
              title="Open Folder"
              icon={Icon.ArrowRight}
              shortcut={{ modifiers: [], key: "arrowRight" }}
              onAction={() => onEnterFolder(entry.fullPath)}
            />
          ) : (
            <Action
              title="Open File"
              icon={Icon.Document}
              onAction={() => open(entry.fullPath)}
            />
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
          <Action.ToggleQuickLook />

          {/* FIX 2 — multi-select: filter, ↑↓ to highlight, X to select */}
          <ActionPanel.Section title="Select">
            <Action
              title={props.isSelected ? "Deselect" : "Select"}
              icon={props.isSelected ? Icon.XMarkCircle : Icon.CheckCircle}
              shortcut={{ modifiers: [], key: "x" }}
              onAction={props.onToggleSelect}
            />
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
              title="Copy to… (Browse)"
              icon={Icon.Clipboard}
              shortcut={Keyboard.Shortcut.Common.Copy}
              onAction={() => props.onPickDestination("copy", [entry.fullPath])}
            />
            <Action
              title="Move to… (Browse)"
              icon={Icon.Move}
              shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
              onAction={() => props.onPickDestination("move", [entry.fullPath])}
            />
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
      "Press → or Enter to drill in, ← to go back — like LaunchBar.",
    );
  } else if (entry.extension === ".md" || entry.extension === ".txt") {
    lines.push("", "_Press Space for Quick Look, Enter to open._");
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
  try {
    await trash([entry.fullPath]);
    removePaths([entry.fullPath]);
    await showToast({ style: Toast.Style.Success, title: "Moved to Trash" });
    onChanged();
  } catch (e) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Trash failed",
      message: String(e),
    });
  }
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
  try {
    await trash(fullPaths);
    removePaths(fullPaths);
    await showToast({
      style: Toast.Style.Success,
      title: `Trashed ${fullPaths.length} item${fullPaths.length === 1 ? "" : "s"}`,
    });
    onDone();
  } catch (e) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Trash failed",
      message: String(e),
    });
  }
}
