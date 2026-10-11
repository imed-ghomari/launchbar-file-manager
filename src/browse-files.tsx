import { useState } from "react";
import {
  Action,
  ActionPanel,
  Alert,
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

function FileBrowser(props: {
  initialPath: string;
  showHidden: boolean;
  showDetail: boolean;
  onToggleHidden: () => void;
  onToggleDetail: () => void;
}) {
  const { push, pop } = useNavigation();
  const [currentPath, setCurrentPath] = useState(props.initialPath);

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

  function enterFolder(folderPath: string) {
    setCurrentPath(folderPath);
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
    setCurrentPath(resolved);
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

  const crumbs = currentPath.replace(/^\/Users\/[^/]+/, "~");

  return (
    <List
      isLoading={isLoading}
      navigationTitle={crumbs}
      searchBarPlaceholder={`Search in ${path.basename(currentPath) || currentPath} — → enter, ← back`}
      isShowingDetail={props.showDetail && (data?.length ?? 0) > 0}
    >
      <List.Section title={currentPath} subtitle={`${data?.length ?? 0} items`}>
        {currentPath !== parentDir(currentPath) ? (
          <List.Item
            title=".."
            subtitle="Parent folder"
            icon={Icon.ArrowUp}
            keywords={["up", "back", "parent"]}
            actions={
              <ActionPanel>
                <Action
                  title="Go to Parent Folder"
                  icon={Icon.ArrowLeft}
                  onAction={() => pop()}
                />
              </ActionPanel>
            }
          />
        ) : null}
        {(data ?? []).map((entry) => (
          <FileRow
            key={entry.fullPath}
            entry={entry}
            currentPath={currentPath}
            showDetail={props.showDetail}
            onEnterFolder={enterFolder}
            onJump={jumpTo}
            onChanged={revalidate}
            onToggleHidden={props.onToggleHidden}
            onToggleDetail={props.onToggleDetail}
          />
        ))}
      </List.Section>
    </List>
  );
}

function FileRow(props: {
  entry: FileEntry;
  currentPath: string;
  showDetail: boolean;
  onEnterFolder: (p: string) => void;
  onJump: (p: string) => void;
  onChanged: () => void;
  onToggleHidden: () => void;
  onToggleDetail: () => void;
}) {
  const { entry, onEnterFolder, onChanged } = props;
  const icon = entry.isDirectory ? Icon.Folder : fileIcon(entry.extension);

  const detail = props.showDetail ? (
    <List.Item.Detail
      markdown={detailMarkdown(entry)}
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
          <List.Item.Detail.Metadata.Label title="Path" text={entry.fullPath} />
          <List.Item.Detail.Metadata.Label title="Name" text={entry.name} />
        </List.Item.Detail.Metadata>
      }
    />
  ) : undefined;

  return (
    <List.Item
      title={entry.name}
      subtitle={entry.isDirectory ? undefined : formatSize(entry.size, false)}
      accessories={[
        { text: entry.isDirectory ? "Folder" : fileKind(entry) },
        { date: entry.mtime },
      ]}
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
          <Action
            title="Show in Finder"
            icon={Icon.Finder}
            shortcut={{ modifiers: ["cmd"], key: "o" }}
            onAction={() => showInFinder(entry.fullPath)}
          />
          <Action.ToggleQuickLook />

          <ActionPanel.Section title="LaunchBar-style ops">
            <Action.Push
              title="Rename…"
              icon={Icon.Pencil}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              target={<RenameForm entry={entry} onDone={onChanged} />}
            />
            <Action
              title="Duplicate"
              icon={Icon.CopyClipboard}
              shortcut={{ modifiers: ["cmd"], key: "d" }}
              onAction={() => duplicateEntry(entry, onChanged)}
            />
            <ActionPanel.Submenu
              title="Copy To…"
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            >
              {FAVORITES.map((f) => (
                <Action
                  key={f.path}
                  title={f.title}
                  onAction={() => copyToDir(entry, f.path, onChanged)}
                />
              ))}
            </ActionPanel.Submenu>
            <ActionPanel.Submenu
              title="Move To…"
              icon={Icon.Move}
              shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
            >
              {FAVORITES.map((f) => (
                <Action
                  key={f.path}
                  title={f.title}
                  onAction={() => moveToDir(entry, f.path, onChanged)}
                />
              ))}
            </ActionPanel.Submenu>
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
              shortcut={{ modifiers: ["cmd", "opt"], key: "c" }}
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
              shortcut={{ modifiers: ["cmd"], key: "." }}
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

function detailMarkdown(entry: FileEntry): string {
  const lines = [
    `# ${entry.name}`,
    ``,
    `${fileKind(entry)} · ${formatSize(entry.size, entry.isDirectory)}`,
    ``,
    `Modified: ${formatDate(entry.mtime)}`,
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

// ---------- Operations ----------

async function duplicateEntry(entry: FileEntry, onChanged: () => void) {
  const dir = path.dirname(entry.fullPath);
  const dest = path.join(dir, path.basename(entry.fullPath) + " copy");
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Duplicating…",
  });
  try {
    await fs.cp(entry.fullPath, dest, { recursive: true });
    toast.style = Toast.Style.Success;
    toast.title = "Duplicated";
    onChanged();
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = "Duplicate failed";
    toast.message = String(e);
  }
}

async function copyToDir(
  entry: FileEntry,
  destDir: string,
  onChanged: () => void,
) {
  const dest = path.join(destDir, path.basename(entry.fullPath));
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Copying to ${destDir}…`,
  });
  try {
    await fs.cp(entry.fullPath, dest, { recursive: true });
    toast.style = Toast.Style.Success;
    toast.title = "Copied";
    onChanged();
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = "Copy failed";
    toast.message = String(e);
  }
}

async function moveToDir(
  entry: FileEntry,
  destDir: string,
  onChanged: () => void,
) {
  const dest = path.join(destDir, path.basename(entry.fullPath));
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Moving to ${destDir}…`,
  });
  try {
    await fs.rename(entry.fullPath, dest);
    toast.style = Toast.Style.Success;
    toast.title = "Moved";
    onChanged();
  } catch {
    try {
      await fs.cp(entry.fullPath, dest, { recursive: true });
      await trash([entry.fullPath]);
      toast.style = Toast.Style.Success;
      toast.title = "Moved";
      onChanged();
    } catch (e2) {
      toast.style = Toast.Style.Failure;
      toast.title = "Move failed";
      toast.message = String(e2);
    }
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
