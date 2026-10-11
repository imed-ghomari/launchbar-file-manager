import { useMemo, useState } from "react";
import {
  Action,
  ActionPanel,
  Form,
  Icon,
  List,
  Toast,
  showToast,
  useNavigation,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  FAVORITES,
  expandHome,
  formatSize,
  listDir,
  parentDir,
} from "./fs-utils";
import { removePaths } from "./selection-store";
import { copyManyWithProgress, moveManyWithProgress } from "./copy-progress";

function matchesFilter(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * LaunchBar-style destination picker.
 * Browse with → to enter, ← to go up (state-based, single view — no stack
 * push per folder), then highlight the HERE row and press Enter to copy/move.
 * Cmd+Enter confirms from any row without moving the highlight.
 */
export function DestinationPicker(props: {
  sources: string[];
  mode: "copy" | "move";
  initialPath: string;
  showHidden: boolean;
  onDone: () => void;
}) {
  const { pop } = useNavigation();
  const { sources, mode } = props;
  const [currentPath, setCurrentPath] = useState(props.initialPath);
  const [searchText, setSearchText] = useState("");

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
        return [];
      }
    },
    [currentPath, props.showHidden],
  );

  const entries = useMemo(() => data ?? [], [data]);
  const folders = useMemo(
    () => entries.filter((e) => e.isDirectory),
    [entries],
  );
  const visibleFolders = useMemo(
    () => folders.filter((f) => matchesFilter(f.name, searchText)),
    [folders, searchText],
  );
  const fileCount = entries.length - folders.length;

  const sourceNames = useMemo(
    () => sources.map((s) => path.basename(s)),
    [sources],
  );
  const verb = mode === "copy" ? "Copy" : "Move";
  const crumbs = currentPath.replace(/^\/Users\/[^/]+/, "~");
  const isRoot = currentPath === parentDir(currentPath);

  function enter(dir: string) {
    setSearchText("");
    setCurrentPath(dir);
  }

  function goUp() {
    if (isRoot) return;
    setSearchText("");
    setCurrentPath(parentDir(currentPath));
  }

  function jumpTo(target: string) {
    const resolved = expandHome(target);
    if (resolved === currentPath) return;
    setSearchText("");
    setCurrentPath(resolved);
  }

  async function execute() {
    // Guard: cannot copy/move a folder into itself or its own descendant.
    for (const src of sources) {
      if (src === currentPath || isInside(currentPath, src)) {
        await showToast({
          style: Toast.Style.Failure,
          title: `Cannot ${verb.toLowerCase()} a folder into itself`,
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
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `${verb}ing ${sources.length} item${sources.length === 1 ? "" : "s"}…`,
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
      props.onDone();
      pop();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = `${verb} failed`;
      toast.message = String(e);
    }
  }

  const hereTitle = `${verb} ${sources.length} item${sources.length === 1 ? "" : "s"} Here`;
  const hereSubtitle = currentPath;

  return (
    <List
      isLoading={isLoading}
      navigationTitle={`${verb} → ${crumbs}`}
      searchBarPlaceholder={`Browse to destination — → enter, ← up, ⏎ ${verb.toLowerCase()} here`}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      filtering={false}
    >
      <List.Section
        title={`${verb}: ${sourceNames.slice(0, 3).join(", ")}${sourceNames.length > 3 ? ` +${sourceNames.length - 3} more` : ""}`}
        subtitle="Highlight HERE + Enter to confirm"
      >
        {/* HERE row is always visible — never filtered out */}
        <List.Item
          title={hereTitle}
          subtitle={hereSubtitle}
          icon={mode === "copy" ? Icon.Clipboard : Icon.Move}
          keywords={["here", "confirm", "destination", currentPath]}
          actions={
            <ActionPanel>
              <Action
                title={hereTitle}
                icon={Icon.ArrowRight}
                onAction={execute}
              />
              <Action
                title="Cancel"
                icon={Icon.XMarkCircle}
                onAction={() => pop()}
              />
              {!isRoot ? (
                <Action
                  title="Go up"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: [], key: "arrowLeft" }}
                  onAction={goUp}
                />
              ) : null}
              <ActionPanel.Section title="Go">
                {FAVORITES.map((f) => (
                  <Action
                    key={f.path}
                    title={`Go to ${f.title}`}
                    icon={Icon.House}
                    onAction={() => jumpTo(f.path)}
                  />
                ))}
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
        {!isRoot ? (
          <List.Item
            title=".."
            subtitle="Up one folder (←)"
            icon={Icon.ArrowUp}
            keywords={["up", "back", "parent"]}
            actions={
              <ActionPanel>
                <Action
                  title="Go up"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: [], key: "arrowLeft" }}
                  onAction={goUp}
                />
                <Action
                  title={hereTitle}
                  icon={mode === "copy" ? Icon.Clipboard : Icon.Move}
                  onAction={execute}
                />
                <Action
                  title="Cancel"
                  icon={Icon.XMarkCircle}
                  onAction={() => pop()}
                />
              </ActionPanel>
            }
          />
        ) : null}
        {visibleFolders.map((folder) => (
          <List.Item
            key={folder.fullPath}
            title={folder.name}
            subtitle={`${formatSize(folder.size, true)} — → to enter`}
            icon={Icon.Folder}
            keywords={[folder.name]}
            quickLook={{ path: folder.fullPath, name: folder.name }}
            actions={
              <ActionPanel>
                <Action
                  title="Enter Folder"
                  icon={Icon.ArrowRight}
                  shortcut={{ modifiers: [], key: "arrowRight" }}
                  onAction={() => enter(folder.fullPath)}
                />
                <Action
                  title="Go up"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: [], key: "arrowLeft" }}
                  onAction={goUp}
                />
                <Action
                  title={hereTitle}
                  icon={mode === "copy" ? Icon.Clipboard : Icon.Move}
                  onAction={execute}
                />
                <Action
                  title="Cancel"
                  icon={Icon.XMarkCircle}
                  onAction={() => pop()}
                />
                <ActionPanel.Section title="Go">
                  {FAVORITES.map((f) => (
                    <Action
                      key={f.path}
                      title={`Go to ${f.title}`}
                      icon={Icon.House}
                      onAction={() => jumpTo(f.path)}
                    />
                  ))}
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      <List.Section
        title="This folder"
        subtitle={`${folders.length} folders · ${fileCount} files`}
      >
        {fileCount > 0 ? (
          <List.Item
            title={`${fileCount} file${fileCount === 1 ? "" : "s"} in this folder (context only)`}
            icon={Icon.Document}
            actions={
              <ActionPanel>
                <Action
                  title={hereTitle}
                  icon={Icon.ArrowRight}
                  onAction={execute}
                />
                <Action
                  title="Cancel"
                  icon={Icon.XMarkCircle}
                  onAction={() => pop()}
                />
              </ActionPanel>
            }
          />
        ) : null}
      </List.Section>
      <List.Section title="Create">
        <List.Item
          title="New Folder…"
          icon={Icon.NewFolder}
          keywords={["new", "folder", "mkdir"]}
          actions={
            <ActionPanel>
              <Action.Push
                title="New Folder…"
                icon={Icon.NewFolder}
                target={
                  <PickerNewFolderForm dir={currentPath} onDone={revalidate} />
                }
              />
              <Action
                title={hereTitle}
                icon={Icon.ArrowRight}
                onAction={execute}
              />
              <Action
                title="Cancel"
                icon={Icon.XMarkCircle}
                onAction={() => pop()}
              />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}

function PickerNewFolderForm(props: { dir: string; onDone: () => void }) {
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
