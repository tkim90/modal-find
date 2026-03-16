# Changelog

## [0.1.0] - 2026-03-16
- Prioritize keyword matches over file match results

## [0.0.2] - 2026-03-16

### Features
- Added Word match support
- Hotkeys: `Alt+Cmd+C`, `Alt+Cmd+W`, `Alt+Cmd+R`, `Alt+Cmd+F`
- `Cmd+Shift+F` on selected text auto-inserts it as the query and fires search
- Include/exclude file filters

### Improvements
- Reduced bundle size
- Syntax highlighting pre-warms results (~50 lines at a time) to eliminate selection delay
- Match the editor color theme
- Cache last search term and flag states across sessions

### Bug Fixes
- Fixed inability to open PNG files (and other files showing "Preview unavailable for this file.")

## [0.0.1] - 2026-03-13

- Initial release
- Global fuzzy search in a IntelliJ-style modal
