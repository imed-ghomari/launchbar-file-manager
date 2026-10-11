# LaunchBar File Manager for Raycast

LaunchBar-style file browsing inside Raycast — miles better than the built-in file search.

## Commands

- **Browse Files** (`browse-files.tsx`): single-view drill — `→` enters, `←` goes up, `Esc` exits. `Space` opens folders / Quick Looks files, `X` selects. The ONE transfer flow: highlight one item (or `X` several), press `Tab` → transfer tree from home → `←`/`→` navigate → `Enter` confirms the folder → choose Copy or Move. `Esc` in transfer cancels + deselects. Ops: Rename, Duplicate, Compress to ZIP (`⌘⇧Z`), Extract Here (zips), Trash, New Folder/File, Copy Path.
- **Act on Finder Selection** (`finder-selection.tsx`): Instant-Send style — select files in Finder, run command, act on them.

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
