# JSONL Viewer

A local web app for browsing JSONL files with syntax highlighting, pagination, and filtering.

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Start the viewer
python server.py path/to/file.jsonl

# With custom port
python server.py path/to/file.jsonl --port 3000

# Bind to all interfaces (accessible from other devices on the network)
python server.py path/to/file.jsonl --host 0.0.0.0
```

Open **http://127.0.0.1:8000** in your browser.

## Features

- **Server-side pagination** — handles files with thousands of records without loading everything into browser memory
- **Filtering** — search across all fields or target a specific field (substring match, case-insensitive)
- **Syntax highlighting** — color-coded JSON values (strings, numbers, booleans, null, keys)
- **Collapsible sections** — records, nested objects, and long arrays can be expanded/collapsed
- **Long text handling** — multi-line strings shown in scrollable blocks; very long strings have a show/hide toggle
- **Keyboard shortcuts**:
  - `/` — focus the filter input
  - `←` / `→` — previous/next page
  - `Enter` in page jump input — go to page
- **Per-page size** — choose 10, 25, 50, or 100 records per page

## Requirements

- Python 3.9+
- fastapi, uvicorn
