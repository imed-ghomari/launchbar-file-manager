import { useEffect, useMemo, useState } from "react";
import {
  Action,
  ActionPanel,
  Color,
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
 * Opened with Tab from the main browser. Shows the file tree from home:
 * navigate with ←/→ only — Enter never enters folders here. Enter triggers
 * the transfer for the CURRENT folder, then forces a Copy vs Move choice.
 * Esc pops back to the browser and clears the selection (deselect).
 */
export function TransferTree(props: {
  sources: string[];
  initialPath: string;
  showHidden: boolean;
  onDone: () => void;
}) {
  const { pop } = useNavigation();
  const { sources } = props;
  const [currentPath, setCurrentPath] = useState(props.initialPath);
  const [searchText, setSearchText] = useState("");

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
    setCurrentPath(dir);
  }

  function goUp() {
    if (currentPath === parentDir(currentPath)) return;
    setSearchText("");
    setCurrentPath(parentDir(currentPath));
  }

  function jumpTo(target: string) {
    const resolved = expandHome(target);
    if (resolved === currentPath) return;
    setSearchText("");
    setCurrentPath(resolved);
  }

  function cancel() {
    clearAll();
    pop();
  }

  async function execute(mode: "copy" | "move") {
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
      props.onDone();
      pop();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = `${mode === "copy" ? "Copy" : "Move"} failed`;
      toast.message = String(e);
    }
  }

  // Enter anywhere in this tree confirms the CURRENT folder, then forces the
  // Copy vs Move choice. Shared as every row's primary action.
  const transferMenu = (
    <ActionPanel.Submenu
      title={`Transfer ${sources.length} Item${sources.length === 1 ? "" : "s"}…`}
    >
      <Action
        title={`Copy Here (${currentPath})`}
        icon={Icon.Clipboard}
        onAction={() => execute("copy")}
      />
      <Action
        title={`Move Here (${currentPath})`}
        icon={Icon.Move}
        onAction={() => execute("move")}
      />
    </ActionPanel.Submenu>
  );

  const hereTitle = `Transfer ${sources.length} Item${sources.length === 1 ? "" : "s"} Here`;

  return (
    <List
      isLoading={isLoading}
      navigationTitle={`Transfer → ${crumbs}`}
      searchBarPlaceholder="←/→ navigate, Enter transfers here, Esc cancels"
      searchText={searchText}
      onSearchTextChange={setSearchText}
      filtering={false}
    >
      <List.Section
        title={`${sourceNames.slice(0, 3).join(", ")}${sourceNames.length > 3 ? ` +${sourceNames.length - 3} more` : ""}`}
        subtitle="Enter confirms this folder, then choose Copy or Move"
      >
        {/* HERE row is always visible — never filtered out */}
        <List.Item
          title={hereTitle}
          subtitle={currentPath}
          icon={{ source: Icon.Switch, tintColor: Color.Green }}
          keywords={["here", "confirm", "transfer", "destination", currentPath]}
          quickLook={{
            path: currentPath,
            name: path.basename(currentPath) || currentPath,
          }}
          actions={
            <ActionPanel>
              {transferMenu}
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
        {visible.map((entry) =>
          entry.isDirectory ? (
            <List.Item
              key={entry.fullPath}
              title={entry.name}
              subtitle="→ to enter, Enter transfers here"
              icon={Icon.Folder}
              keywords={[entry.name]}
              quickLook={{ path: entry.fullPath, name: entry.name }}
              actions={
                <ActionPanel>
                  {transferMenu}
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
              title={entry.name}
              subtitle={formatSize(entry.size, false)}
              icon={Icon.Document}
              keywords={[entry.name, entry.extension]}
              quickLook={{ path: entry.fullPath, name: entry.name }}
              actions={
                <ActionPanel>
                  {transferMenu}
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
    </List>
  );
}
