import { useEffect, useMemo, useState } from "react";
import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  showToast,
  useNavigation,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import * as path from "node:path";
import {
  FAVORITES,
  expandHome,
  formatSize,
  listDir,
  parentDir,
} from "./fs-utils";
import { clearAll, removePaths } from "./selection-store";
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
 * The ONE copy/move flow (LaunchBar-style).
 *
 * Opened with Tab from the main browser. Shows the file tree (start folder per setting):
 * navigate with ←/→ only — Enter never enters folders here. Enter triggers
 * the transfer for the CURRENT folder, then forces a Copy vs Move choice.
 * Esc pops back to the browser and clears the selection (deselect).
 */
export function TransferTree(props: {
  sources: string[];
  initialPath: string;
  showHidden: boolean;
  /** Called with the destination folder so the browser can reveal results. */
  onDone: (destDir: string) => void;
}) {
  const { pop } = useNavigation();
  const { sources } = props;
  const [currentPath, setCurrentPath] = useState(props.initialPath);
  const [searchText, setSearchText] = useState("");
  const [highlightId, setHighlightId] = useState<string | undefined>(undefined);

  // Esc out of transfer = deselect + back to the normal tree.
  useEffect(() => () => clearAll(), []);

  const { data, isLoading } = usePromise(
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
  const visible = useMemo(
    () => entries.filter((e) => matchesFilter(e.name, searchText)),
    [entries, searchText],
  );

  const sourceNames = useMemo(
    () => sources.map((s) => path.basename(s)),
    [sources],
  );
  const crumbs = currentPath.replace(/^\/Users\/[^/]+/, "~");

  function enter(dir: string) {
    setSearchText("");
    setHighlightId(undefined);
    setCurrentPath(dir);
  }

  function goUp() {
    if (currentPath === parentDir(currentPath)) return;
    // Land the highlight on the folder just left.
    setHighlightId(currentPath);
    setSearchText("");
    setCurrentPath(parentDir(currentPath));
  }

  function jumpTo(target: string) {
    const resolved = expandHome(target);
    if (resolved === currentPath) return;
    setSearchText("");
    setHighlightId(undefined);
    setCurrentPath(resolved);
  }

  function cancel() {
    clearAll();
    pop();
  }

  async function execute(mode: "copy" | "move", destDir: string) {
    for (const src of sources) {
      if (src === destDir || isInside(destDir, src)) {
        await showToast({
          style: Toast.Style.Failure,
          title: `Cannot ${mode} a folder into itself`,
          message: src,
        });
        return;
      }
      if (path.dirname(src) === destDir && mode === "move") {
        await showToast({
          style: Toast.Style.Failure,
          title: "Already in this folder",
          message: destDir,
        });
        return;
      }
    }
    const verb = mode === "copy" ? "Copying" : "Moving";
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `${verb} ${sources.length} Item${sources.length === 1 ? "" : "s"}…`,
      message: `→ ${destDir}`,
    });
    try {
      if (mode === "copy") {
        const r = await copyManyWithProgress(
          sources,
          destDir,
          toast,
          "Copying",
        );
        if (r.errors.length > 0) {
          toast.style = Toast.Style.Failure;
          toast.title = `Copied with ${r.errors.length} errors`;
          toast.message = r.errors.slice(0, 3).join("\n");
        } else {
          toast.style = Toast.Style.Success;
          toast.title = `Copied ${r.copied} Item${r.copied === 1 ? "" : "s"}`;
          toast.message = `→ ${destDir}`;
        }
      } else {
        const r = await moveManyWithProgress(sources, destDir, toast, "Moving");
        if (r.errors.length > 0) {
          toast.style = Toast.Style.Failure;
          toast.title = `Moved with ${r.errors.length} errors`;
          toast.message = r.errors.slice(0, 3).join("\n");
        } else {
          toast.style = Toast.Style.Success;
          toast.title = `Moved ${r.moved} Item${r.moved === 1 ? "" : "s"}`;
          toast.message = `→ ${destDir}`;
        }
        removePaths(sources);
      }
      clearAll();
      props.onDone(destDir);
      pop();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = `${mode === "copy" ? "Copy" : "Move"} failed`;
      toast.message = String(e);
    }
  }

  // Enter on a highlighted folder targets THAT folder; Enter on a file row
  // targets the displayed folder (files can't contain anything).
  function transferMenu(destDir: string, intoName: string | null) {
    const title = intoName ? `Transfer Into ${intoName}…` : "Transfer…";
    const copyTitle = intoName ? `Copy Into ${intoName}` : "Copy Here";
    const moveTitle = intoName ? `Move Into ${intoName}` : "Move Here";
    return (
      <ActionPanel.Submenu title={title}>
        <Action
          title={copyTitle}
          icon={Icon.Clipboard}
          onAction={() => execute("copy", destDir)}
        />
        <Action
          title={moveTitle}
          icon={Icon.Move}
          onAction={() => execute("move", destDir)}
        />
      </ActionPanel.Submenu>
    );
  }

  return (
    <List
      isLoading={isLoading}
      navigationTitle={`Transfer → ${crumbs}`}
      searchBarPlaceholder="←/→ navigate, Enter confirms, Esc cancels"
      searchText={searchText}
      onSearchTextChange={setSearchText}
      filtering={false}
      selectedItemId={highlightId}
      onSelectionChange={(id) => setHighlightId(id ?? undefined)}
    >
      <List.Section
        title={`${sourceNames.slice(0, 3).join(", ")}${sourceNames.length > 3 ? ` +${sourceNames.length - 3} more` : ""}`}
        subtitle={`${visible.length} items`}
      >
        {visible.map((entry) =>
          entry.isDirectory ? (
            <List.Item
              key={entry.fullPath}
              id={entry.fullPath}
              title={entry.name}
              icon={Icon.Folder}
              keywords={[entry.name]}
              quickLook={{ path: entry.fullPath, name: entry.name }}
              actions={
                <ActionPanel>
                  {transferMenu(entry.fullPath, entry.name)}
                  <Action
                    title="Enter Folder"
                    icon={Icon.ArrowRight}
                    shortcut={{ modifiers: [], key: "arrowRight" }}
                    onAction={() => enter(entry.fullPath)}
                  />
                  <Action
                    title="Go up"
                    icon={Icon.ArrowLeft}
                    shortcut={{ modifiers: [], key: "arrowLeft" }}
                    onAction={goUp}
                  />
                  <Action.ToggleQuickLook
                    shortcut={{ modifiers: [], key: "space" }}
                  />
                  <Action
                    title="Cancel Transfer"
                    icon={Icon.XMarkCircle}
                    onAction={cancel}
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
          ) : (
            <List.Item
              key={entry.fullPath}
              id={entry.fullPath}
              title={entry.name}
              subtitle={formatSize(entry.size, false)}
              icon={Icon.Document}
              keywords={[entry.name, entry.extension]}
              quickLook={{ path: entry.fullPath, name: entry.name }}
              actions={
                <ActionPanel>
                  {transferMenu(currentPath, null)}
                  <Action
                    title="Go up"
                    icon={Icon.ArrowLeft}
                    shortcut={{ modifiers: [], key: "arrowLeft" }}
                    onAction={goUp}
                  />
                  <Action.ToggleQuickLook
                    shortcut={{ modifiers: [], key: "space" }}
                  />
                  <Action
                    title="Cancel Transfer"
                    icon={Icon.XMarkCircle}
                    onAction={cancel}
                  />
                </ActionPanel>
              }
            />
          ),
        )}
      </List.Section>
      {visible.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Folder}
          title="Empty folder"
          description="Enter transfers into this folder, ← goes up"
          actions={
            <ActionPanel>
              {transferMenu(currentPath, null)}
              <Action
                title="Go up"
                icon={Icon.ArrowLeft}
                shortcut={{ modifiers: [], key: "arrowLeft" }}
                onAction={goUp}
              />
              <Action
                title="Cancel Transfer"
                icon={Icon.XMarkCircle}
                onAction={cancel}
              />
            </ActionPanel>
          }
        />
      ) : null}
    </List>
  );
}
