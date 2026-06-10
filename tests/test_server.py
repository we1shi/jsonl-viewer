import json
import tempfile
import unittest
from pathlib import Path

import server


def write_jsonl(path: Path, records: list[dict], trailing_newline: bool = True) -> None:
    data = "\n".join(json.dumps(record) for record in records)
    if trailing_newline and data:
        data += "\n"
    path.write_text(data, encoding="utf-8")


class ServerCoreTests(unittest.TestCase):
    def test_build_index_empty_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "empty.jsonl"
            path.write_text("", encoding="utf-8")

            offsets, count = server.build_index(path)

        self.assertEqual(offsets, [])
        self.assertEqual(count, 0)

    def test_build_index_handles_missing_final_newline(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "records.jsonl"
            write_jsonl(path, [{"id": 1}, {"id": 2}], trailing_newline=False)

            offsets, count = server.build_index(path)
            fi = server.FileIndex(path=path, offsets=offsets, count=count)

            first = server.read_record(fi, 0)
            second = server.read_record(fi, 1)

        self.assertEqual(count, 2)
        self.assertEqual(first["id"], 1)
        self.assertEqual(second["id"], 2)

    def test_read_record_returns_parse_error_for_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.jsonl"
            path.write_text('{"ok": true}\nnot-json\n', encoding="utf-8")
            offsets, count = server.build_index(path)
            fi = server.FileIndex(path=path, offsets=offsets, count=count)

            bad = server.read_record(fi, 1)

        self.assertTrue(bad["_parse_error"])
        self.assertIn("not-json", bad["_raw"])

    def test_read_records_batch_adds_source_indices(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "records.jsonl"
            write_jsonl(path, [{"id": 0}, {"id": 1}, {"id": 2}])
            offsets, count = server.build_index(path)
            fi = server.FileIndex(path=path, offsets=offsets, count=count)

            records = server.read_records_batch(fi, 1, 2)

        self.assertEqual([record["_index"] for record in records], [1, 2])
        self.assertEqual([record["id"] for record in records], [1, 2])

    def test_scan_filter_supports_field_and_negate(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "records.jsonl"
            write_jsonl(
                path,
                [
                    {"id": 1, "kind": "alpha"},
                    {"id": 2, "kind": "beta"},
                    {"id": 3, "kind": "alphabet"},
                ],
            )
            offsets, count = server.build_index(path)
            fi = server.FileIndex(path=path, offsets=offsets, count=count)

            matches = server.scan_filter(fi, "alpha", "kind", 0, 10)
            inverted = server.scan_filter(fi, "alpha", "kind", 0, 10, negate=True)

        self.assertEqual(matches["total"], 2)
        self.assertEqual([record["_index"] for record in matches["records"]], [0, 2])
        self.assertEqual(inverted["total"], 1)
        self.assertEqual(inverted["records"][0]["_index"], 1)

    def test_filter_and_export_matching_share_scan_limit(self):
        old_limit = server.MAX_FILTER_SCAN
        server.MAX_FILTER_SCAN = 3
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "records.jsonl"
                write_jsonl(
                    path,
                    [
                        {"id": 1, "kind": "target"},
                        {"id": 2, "kind": "other"},
                        {"id": 3, "kind": "target"},
                        {"id": 4, "kind": "target"},
                    ],
                )
                offsets, count = server.build_index(path)
                fi = server.FileIndex(path=path, offsets=offsets, count=count)

                page = server.scan_filter(fi, "target", "kind", 0, 10)
                export_indices = list(server.iter_matching_indices(fi, "target", "kind"))
        finally:
            server.MAX_FILTER_SCAN = old_limit

        self.assertTrue(page["limited"])
        self.assertEqual(page["scanned"], 3)
        self.assertEqual([record["_index"] for record in page["records"]], export_indices)
        self.assertEqual(export_indices, [0, 2])


if __name__ == "__main__":
    unittest.main()
