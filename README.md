# Modal Find

Modal Find is a VS Code extension prototype that remaps `Cmd+Shift+F` / `Ctrl+Shift+F` to a workspace-wide fuzzy search surface inspired by WebStorm's global find dialog.

<img width="1226" height="888" alt="CleanShot 2026-03-12 at 12 35 01" src="https://github.com/user-attachments/assets/d0e51ea8-0987-4c5e-9d5b-ef6cf4855e8a" />



## What it does

- Opens a dedicated search panel on `Cmd+Shift+F` / `Ctrl+Shift+F`
- Fuzzy-matches file paths
- Scans indexed text files for line matches
- Shows a bottom preview pane with surrounding context
- Opens the selected result on `Enter` or double-click

## Current limitations

- VS Code does not expose a true centered modal extension API, so this is implemented as a modal-styled webview panel in the editor area.
- Content search is done against an in-memory index of text files up to a size budget, so very large or binary files fall back to path-only matches.

## Development

```bash
npm install
npm run compile
```

`npm run compile` now builds both the TypeScript extension and the bundled Rust `fff` sidecar for the current platform. For iterative frontend work, `npm run watch` still only recompiles the TypeScript sources; if you change the Rust bridge, rerun `npm run build:native`.
