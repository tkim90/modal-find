<h1 align="center">
  <img src="https://raw.githubusercontent.com/tkim90/fff-extension/main/icon.png" width="64" alt="Fast Fuzzy Finder icon" /><br/>
  Fast Fuzzy Finder
</h1>

<p align="center">
  <strong>Sub-10ms fuzzy search popup for VS Code</strong><br/>
  Powered by <a href="https://github.com/dmtrKovalenko/fff.nvim">fff.nvim</a> · Inspired by JetBrains Search Everywhere
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=TaeKim.fast-fuzzy-finder">
    <img src="https://img.shields.io/visual-studio-marketplace/v/TaeKim.fast-fuzzy-finder?style=flat-square&label=VS%20Marketplace&color=7c3aed" alt="VS Marketplace"/>
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=TaeKim.fast-fuzzy-finder">
    <img src="https://img.shields.io/visual-studio-marketplace/d/TaeKim.fast-fuzzy-finder?style=flat-square&color=4f86f7" alt="Downloads"/>
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=TaeKim.fast-fuzzy-finder">
    <img src="https://img.shields.io/visual-studio-marketplace/r/TaeKim.fast-fuzzy-finder?style=flat-square&color=f5a623" alt="Rating"/>
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="License: MIT"/>
  </a>
</p>

<p align="center">
  Open with <kbd>Cmd+Shift+F</kbd> / <kbd>Ctrl+Shift+F</kbd> — Type — Navigate — Done.
</p>

<p align="center">
  <img alt="Fast Fuzzy Finder screenshot" src="hero.png" />
</p>

<video src="https://github.com/user-attachments/assets/c7dd7275-8417-43d8-b54d-aea11cc22431" controls />

## Installation

Fast Fuzzy Finder on VSCode Marketplace

Through .vsix file 
1. Go to Releases
2. Download .vsix file
3. In VSCode: cmd+shift+p "Extensions: Install from VSIX..."

## Features

- **Sub-10ms fuzzy search** — Rust-powered backend delivers instant results as you type
- **Find files and content in one place** — Search file paths and text content simultaneously with <kbd>Cmd+Shift+F</kbd> / <kbd>Ctrl+Shift+F</kbd>
- **Case, Word & Regex matching** — Toggle case sensitivity (<kbd>Cmd+Alt+C</kbd>), whole-word match (<kbd>Cmd+Alt+W</kbd>), or full regex (<kbd>Cmd+Alt+R</kbd>) on the fly
- **Include / Exclude file filters** — Narrow results with glob patterns (<kbd>Cmd+Alt+F</kbd>) — e.g. `*.ts`, `src/**/components`
- **Live preview with syntax highlighting** — Bottom pane shows surrounding context with highlighting for 30+ languages
- **Image preview** — Preview PNGs, JPGs, SVGs, and more right in the search modal
- **Remembers everything** — Your query, modifiers, filters, and modal size persist across sessions
- **Resizable modal** — Drag corners and the split handle to fit your workflow
- **Cross-platform** — Native performance on macOS (Intel & Apple Silicon), Linux, and Windows

## Current limitations

- VS Code does not expose a true centered modal extension API, so this is implemented as a modal-styled webview panel in the editor area.
- Content search is done against an in-memory index of text files up to a size budget, so very large or binary files fall back to path-only matches.

## Development

```bash
npm install
npm run compile
```

`npm run compile` now builds both the TypeScript extension and the bundled Rust `fff` sidecar for the current platform. For iterative frontend work, `npm run watch` still only recompiles the TypeScript sources; if you change the Rust bridge, rerun `npm run build:native`.
