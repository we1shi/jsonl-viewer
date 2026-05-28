import argparse
import base64
import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI()

MAX_FILTER_SCAN = 20_000
HOME = Path.home()


@dataclass
class FileIndex:
    path: Path
    offsets: list[int] = field(default_factory=list)
    count: int = 0


open_files: dict[str, FileIndex] = {}  # key = urlsafe b64 encoded absolute path
_index_lock = threading.Lock()


# ── Path encoding ───────────────────────────────────────────────────────────


def encode_path(path: str | Path) -> str:
    return base64.urlsafe_b64encode(str(path).encode()).decode()


def decode_path(encoded: str) -> Path:
    return Path(base64.urlsafe_b64decode(encoded.encode()).decode())


# ── Index operations ────────────────────────────────────────────────────────


def build_index(path: Path) -> tuple[list[int], int]:
    offs = [0]
    with open(path, "rb") as f:
        while True:
            chunk = f.read(16 * 1024 * 1024)
            if not chunk:
                break
            for i, b in enumerate(chunk):
                if b == 0x0A:
                    offs.append(f.tell() - len(chunk) + i + 1)
    if len(offs) > 0:
        fsize = path.stat().st_size
        if offs[-1] >= fsize:
            offs.pop()
    return offs, len(offs)


def open_file(path: Path) -> str:
    """Index and register a file. Returns its encoded key."""
    key = encode_path(path)
    if key in open_files:
        return key
    with _index_lock:
        if key in open_files:
            return key
        offsets, count = build_index(path)
        open_files[key] = FileIndex(path=path, offsets=offsets, count=count)
    return key


def close_file(key: str) -> bool:
    with _index_lock:
        if key in open_files:
            del open_files[key]
            return True
    return False


def get_index(key: str) -> FileIndex | None:
    return open_files.get(key)


# ── Record reading ──────────────────────────────────────────────────────────


def read_record(fi: FileIndex, index: int) -> dict | None:
    if index < 0 or index >= fi.count:
        return None
    start = fi.offsets[index]
    with open(fi.path, "rb") as f:
        f.seek(start)
        line = f.readline().decode("utf-8", errors="replace")
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return {"_raw": line, "_parse_error": True}


def read_raw_line(fi: FileIndex, index: int) -> bytes | None:
    """Read the raw bytes of a record line (no JSON parsing)."""
    if index < 0 or index >= fi.count:
        return None
    start = fi.offsets[index]
    with open(fi.path, "rb") as f:
        f.seek(start)
        return f.readline()


def read_records_batch(fi: FileIndex, start_idx: int, count: int) -> list[dict]:
    results = []
    for i in range(start_idx, min(start_idx + count, fi.count)):
        rec = read_record(fi, i)
        if rec is not None:
            rec["_index"] = i
            results.append(rec)
    return results


def scan_filter(fi: FileIndex, query: str, field: str | None, offset: int, limit: int, negate: bool = False) -> dict:
    matches: list[int] = []
    q = query.lower()
    scan_count = min(fi.count, MAX_FILTER_SCAN)

    for i in range(scan_count):
        rec = read_record(fi, i)
        if rec is None:
            continue
        matched = False
        if field:
            val = rec.get(field)
            if val is not None:
                if q in json.dumps(val, ensure_ascii=False).lower():
                    matched = True
        else:
            raw = json.dumps(rec, ensure_ascii=False).lower()
            if q in raw:
                matched = True
        if matched != negate:
            matches.append(i)

    total_matches = len(matches)
    page_indices = matches[offset : offset + limit]
    records = []
    for idx in page_indices:
        rec = read_record(fi, idx)
        if rec is not None:
            rec["_index"] = idx
            records.append(rec)

    return {"records": records, "total": total_matches, "scanned": scan_count}


def get_available_fields(fi: FileIndex, sample_size: int = 100) -> list[str]:
    fields: set[str] = set()
    for i in range(min(fi.count, sample_size)):
        rec = read_record(fi, i)
        if rec:
            fields.update(rec.keys())
    return sorted(fields)


# ── Helper: get the "default" file (first opened) ───────────────────────────


def _default_key() -> str | None:
    if open_files:
        return next(iter(open_files))
    return None


# ── API Routes: File Management ─────────────────────────────────────────────


class OpenRequest(BaseModel):
    path: str


class CloseRequest(BaseModel):
    path: str


class ExportRequest(BaseModel):
    indices: list[int] | None = None
    query: str = ""
    field: str = ""
    negate: bool = False


@app.get("/api/files")
def api_list_files():
    """List all currently open files with their metadata."""
    files = []
    for key, fi in open_files.items():
        files.append({
            "key": key,
            "path": str(fi.path),
            "name": fi.path.name,
            "total_records": fi.count,
            "file_size": fi.path.stat().st_size,
        })
    return {"files": files}


@app.get("/api/browse")
def api_browse(dir: str = ""):
    """Browse a directory: return subdirectories and .jsonl files."""
    if not dir:
        dir = str(HOME)
    p = Path(dir).resolve()
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=404, detail=f"Directory not found: {dir}")

    try:
        entries = sorted(p.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {dir}")

    dirs = []
    files = []
    for e in entries:
        if e.name.startswith("."):
            continue
        if e.is_dir():
            dirs.append({"name": e.name, "path": str(e)})
        elif e.is_file() and e.suffix.lower() in (".jsonl", ".json"):
            files.append({
                "name": e.name,
                "path": str(e),
                "size": e.stat().st_size,
            })

    return {
        "current_dir": str(p),
        "parent_dir": str(p.parent) if p.parent != p else None,
        "dirs": dirs,
        "files": files,
    }


@app.post("/api/files/open")
def api_open_file(req: OpenRequest):
    """Open (index) a JSONL file and return its metadata."""
    path = Path(req.path).resolve()
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {path}")

    if path.suffix.lower() not in (".jsonl", ".json", ".txt"):
        # Allow .txt but warn — it might be JSONL
        pass

    try:
        key = open_file(path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to index file: {e}")

    fi = open_files[key]
    return {
        "key": key,
        "path": str(fi.path),
        "name": fi.path.name,
        "total_records": fi.count,
        "file_size": fi.path.stat().st_size,
        "fields": get_available_fields(fi),
    }


@app.post("/api/files/close")
def api_close_file(req: CloseRequest):
    """Close a file and remove its index."""
    path = Path(req.path).resolve()
    key = encode_path(path)
    if key not in open_files:
        raise HTTPException(status_code=404, detail="File not open")
    close_file(key)
    return {"ok": True}


# ── API Routes: File-scoped data access ─────────────────────────────────────


@app.get("/api/files/{key}/metadata")
def api_file_metadata(key: str):
    fi = get_index(key)
    if fi is None:
        raise HTTPException(status_code=404, detail="File not found")
    return {
        "key": key,
        "path": str(fi.path),
        "name": fi.path.name,
        "file_size": fi.path.stat().st_size,
        "total_records": fi.count,
        "fields": get_available_fields(fi),
        "max_filter_scan": MAX_FILTER_SCAN,
    }


@app.get("/api/files/{key}/records")
def api_file_records(
    key: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    query: str = Query(""),
    field: str = Query(""),
    negate: bool = Query(False),
):
    fi = get_index(key)
    if fi is None:
        raise HTTPException(status_code=404, detail="File not found")
    if query:
        fname = field if field else None
        return scan_filter(fi, query, fname, offset, limit, negate)
    records = read_records_batch(fi, offset, limit)
    return {"records": records, "total": fi.count}


@app.get("/api/files/{key}/records/{index}")
def api_file_record(key: str, index: int):
    fi = get_index(key)
    if fi is None:
        raise HTTPException(status_code=404, detail="File not found")
    rec = read_record(fi, index)
    if rec is None:
        raise HTTPException(status_code=404, detail="Record not found")
    rec["_index"] = index
    return rec


@app.post("/api/files/{key}/export")
def api_export_file(key: str, req: ExportRequest):
    fi = get_index(key)
    if fi is None:
        raise HTTPException(status_code=404, detail="File not found")

    # Determine which indices to export
    if req.indices is not None:
        indices = sorted(set(req.indices))
    elif req.query:
        indices = []
        q = req.query.lower()
        fname = req.field if req.field else None
        for i in range(fi.count):
            rec = read_record(fi, i)
            if rec is None:
                continue
            matched = False
            if fname:
                val = rec.get(fname)
                if val is not None and q in json.dumps(val, ensure_ascii=False).lower():
                    matched = True
            else:
                if q in json.dumps(rec, ensure_ascii=False).lower():
                    matched = True
            if matched != req.negate:
                indices.append(i)
    else:
        raise HTTPException(status_code=400, detail="Provide indices or query")

    if not indices:
        raise HTTPException(status_code=404, detail="No matching records to export")

    name = fi.path.stem

    def generate():
        for idx in indices:
            line = read_raw_line(fi, idx)
            if line is not None:
                yield line

    return StreamingResponse(
        generate(),
        media_type="application/x-jsonl",
        headers={"Content-Disposition": f'attachment; filename="{name}_export.jsonl"'},
    )


# ── API Routes: Legacy (backward compat, uses default file) ─────────────────


@app.get("/api/metadata")
def api_metadata_legacy():
    key = _default_key()
    if key is None:
        return {"file_name": None, "file_size": 0, "total_records": 0, "fields": [], "max_filter_scan": MAX_FILTER_SCAN}
    fi = open_files[key]
    return {
        "file_name": fi.path.name,
        "file_size": fi.path.stat().st_size,
        "total_records": fi.count,
        "fields": get_available_fields(fi),
        "max_filter_scan": MAX_FILTER_SCAN,
        "key": key,
        "path": str(fi.path),
    }


@app.get("/api/records")
def api_records_legacy(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    query: str = Query(""),
    field: str = Query(""),
    negate: bool = Query(False),
):
    key = _default_key()
    if key is None:
        return {"records": [], "total": 0}
    fi = open_files[key]
    if query:
        fname = field if field else None
        return scan_filter(fi, query, fname, offset, limit, negate)
    records = read_records_batch(fi, offset, limit)
    return {"records": records, "total": fi.count}


@app.get("/api/records/{index}")
def api_record_legacy(index: int):
    key = _default_key()
    if key is None:
        raise HTTPException(status_code=404, detail="No file open")
    fi = open_files[key]
    rec = read_record(fi, index)
    if rec is None:
        raise HTTPException(status_code=404, detail="Record not found")
    rec["_index"] = index
    return rec


# ── Static Files ─────────────────────────────────────────────────────────────

STATIC_DIR = Path(__file__).parent / "static"


@app.get("/")
def serve_index():
    return FileResponse(STATIC_DIR / "index.html")


if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ── Entrypoint ───────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="JSONL Viewer — local web app for browsing .jsonl files")
    parser.add_argument("file", nargs="?", type=str, default=None, help="Optional path to a JSONL file to pre-open")
    parser.add_argument("--port", "-p", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to (default: 127.0.0.1)")
    args = parser.parse_args()

    if args.file:
        path = Path(args.file).resolve()
        if not path.exists():
            print(f"Error: file not found: {path}")
            return
        if not path.is_file():
            print(f"Error: not a file: {path}")
            return
        print(f"Indexing {path.name} ...")
        offsets, count = build_index(path)
        key = encode_path(path)
        open_files[key] = FileIndex(path=path, offsets=offsets, count=count)
        print(f"Found {count:,} records.")
    else:
        print("No initial file specified. Use the web UI to open files.")

    print(f"Starting server at http://{args.host}:{args.port}")

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
