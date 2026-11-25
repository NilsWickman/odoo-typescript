"""Check that packaging preserves native bytes/mtime and refuses invalid or oversized inputs."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("filestore_export", Path(__file__).parents[1] / "gen/filestore.py")
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source, self.assets, self.bundles = [root / n for n in ("source", "assets", "bundles")]
        for directory in (self.source, self.assets, self.bundles):
            directory.mkdir()
        self.metadata = root / "filestore.json"
        self.data = b"native attachment bytes\x00\xff"
        sha = hashlib.sha1(self.data).hexdigest()
        self.key = f"{sha[:2]}/{sha}"
        self.file = self.source / self.key
        self.file.parent.mkdir()
        self.file.write_bytes(self.data)
        os.utime(self.file, (1700000000, 1700000000))
        (self.bundles / "index.json").write_text("{}")

    def export(self):
        return exporter.export(self.source, self.assets, self.bundles, self.metadata)

    def test_template_wins_over_duplicate_bundle_and_keeps_mtime(self):
        (self.bundles / "test.min.js").write_bytes(self.data)
        (self.bundles / "index.json").write_text(json.dumps({"test": {"js": {
            "file": "test.min.js", "store_fname": self.key}}}))
        stats = self.export()
        self.assertEqual(stats["filestore_files"], 1)
        self.assertEqual((self.assets / "__filestore" / self.key).read_bytes(), self.data)
        self.assertEqual(json.loads(self.metadata.read_text())[self.key], 1700000000000)
        self.assertEqual(self.export(), stats)

    def test_rejects_wrong_content_hash(self):
        self.file.write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "Content does not match"):
            self.export()

    def test_rejects_oversized_existing_static_file_before_copying(self):
        with (self.assets / "too-large").open("wb") as f:
            f.truncate(exporter.MAX_SIZE + 1)
        with self.assertRaisesRegex(ValueError, "exceeds 25 MiB"):
            self.export()
        self.assertFalse(self.metadata.exists())

    def test_counts_all_existing_assets_toward_free_limit(self):
        (self.assets / "existing").write_bytes(b"existing asset")
        with patch.object(exporter, "MAX_FILES", 1):
            with self.assertRaisesRegex(ValueError, "Workers Free allows"):
                self.export()


if __name__ == "__main__":
    unittest.main()
