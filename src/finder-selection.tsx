import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  showToast,
  Keyboard,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getSelectedFinderItems } from "@raycast/api";
import { formatSize } from "./fs-utils";

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(async () => {
    try {
      const items = await getSelectedFinderItems();
      const out: { path: string; isDir: boolean; size: number }[] = [];
      for (const item of items) {
        try {
          const st = await fs.stat(item.path);
          out.push({ path: item.path, isDir: st.isDirectory(), size: st.size });
        } catch {
          out.push({ path: item.path, isDir: false, size: 0 });
        }
      }
      return out;
    } catch {
      await showToast({
        style: Toast.Style.Failure,
        title: "No Finder selection",
        message: "Select files in Finder first, then run this command",
      });
      return [];
    }
  }, []);

  return (
    <List
      isLoading={isLoading}
      navigationTitle="Finder Selection — Instant Send style"
    >
      <List.EmptyView
        icon={Icon.Finder}
        title="Select files in Finder first"
        description="Then run this command to copy, move, rename, or trash them"
      />
      {(data ?? []).map((f) => (
        <List.Item
          key={f.path}
          title={path.basename(f.path)}
          subtitle={f.isDir ? "Folder" : formatSize(f.size, false)}
          accessories={[{ text: f.path }]}
          icon={f.isDir ? Icon.Folder : Icon.Document}
          quickLook={{ path: f.path, name: path.basename(f.path) }}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title="Copy Path" content={f.path} />
              <Action.ToggleQuickLook />
              <Action
                title="Refresh Selection"
                icon={Icon.RotateClockwise}
                shortcut={Keyboard.Shortcut.Common.Refresh}
                onAction={() => revalidate()}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
