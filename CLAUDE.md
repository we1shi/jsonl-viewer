# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run server (no initial file — use web UI to open files)
python server.py

# Run with a pre-opened file
python server.py <path-to-jsonl-file>

# Custom port/host
python server.py --port 3000
python server.py --host 0.0.0.0 --port 8080
```

## Architecture

**server.py** — FastAPI backend managing multiple open JSONL files simultaneously.

- `FileIndex` dataclass holds per-file state: `path`, `offsets` (byte-position array), `count`
- `open_files: dict[str, FileIndex]` keyed by base64-encoded absolute path
- File operations (open/close) are protected by a threading lock
- Two sets of API routes: legacy routes (no file key in URL, default to first-open file) and file-scoped routes (`/api/files/{key}/...`)

Key routes:
- `GET /api/files` — list open files
- `GET /api/browse?dir=` — browse filesystem for .jsonl/.json files
- `POST /api/files/open` — index and open a JSONL file
- `POST /api/files/close` — close and remove index
- `GET /api/files/{key}/metadata` — file metadata + field names
- `GET /api/files/{key}/records?offset=&limit=&query=&field=` — paginated records with optional filtering
- `GET /api/files/{key}/records/{index}` — single record

**static/app.js** — Vanilla JS frontend. `fileStates` Map holds per-file state objects keyed by base64 path. `activeKey` tracks the current tab.

Key modules:
- Tab management: `renderTabs()`, `switchTab()`, `openFileTab()`, `closeFileTab()`
- File browser modal: `showFileBrowser()`, `browseDir()`, `renderFileList()`
- JSON rendering: recursive `renderJsonValue()` → typed spans with color classes
- Filtering: server-side substring match, case-insensitive

**static/style.css** — Warm neutral dark theme (VS Code-like palette). CSS custom properties for all colors. Key patterns: `.json-value-multiline` blocks are `resize: vertical`, record cards have hover border accent, tabs use flex layout with active underline.

**static/index.html** — Shell: tab bar (nav#tabbar), top bar (controls), scrollable record list, pagination footer, hidden file browser modal.

## Key Design Decisions

- No database — byte-offset index in memory, one per open file
- No JavaScript framework — vanilla JS with a single global state Map
- Filtering scans linearly capped at 20k records per file
- Internal fields prefixed with `_` and hidden from rendering
- Paths encoded as URL-safe base64 in API routes to handle special characters
- CLI file argument is optional — server can start empty, files opened via web UI
