# LaunchBar File Manager for Raycast

LaunchBar-style file browsing inside Raycast — miles better than the built-in file search.

## Commands

- **Browse Files** (`browse-files.tsx`): single-view drill — `→` enters, `←` goes up (landing on the folder just left), `Esc` exits and deselects. `Space` opens folders / Quick Looks files, `X` selects (count shown in the bottom status bar). The ONE transfer flow: highlight one item (or `X` several), press `Tab` → transfer tree (starts at home or current folder per setting) → `←`/`→` navigate → `Enter` on a folder transfers INTO it (on a file row, into the displayed folder) → choose Copy or Move. `Esc` in transfer cancels + deselects. After transfer, the destination opens so you see results. Ops: Rename, Duplicate, Compress to ZIP (`⌘⇧Z`), Extract Here (zips), Trash, New Folder/File, Copy Path.
- **Transfer Finder Selection** (`finder-selection.tsx`): takes the current Finder selection straight into the same transfer tree (browse, Enter on a folder, choose Copy or Move). Never touches the `X` basket.

## Develop

```bash
npm install
npm run dev
```

Then in Raycast: `Import Extension` → select this folder. Pin `Browse Files`, alias `fm`.

Grant Full Disk Access if folders show empty: System Settings → Privacy → Full Disk Access → Raycast.

## Build / Lint

```bash
npx ray build -e dist
npx ray lint
```

## GitHub upload

See `GITHUB_STEPS.md`.
