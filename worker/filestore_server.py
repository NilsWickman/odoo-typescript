#!/usr/bin/env python3
"""Local-development filestore for the Worker (src/filestore.ts): GET /<db>/<store_fname> serves
FILESTORE_ROOT/<db>/<store_fname> (harness/dbs.py layout, one directory per database copy) with Last-Modified
from the file's mtime, like Odoo's `_to_http_stream` path streams (ir_attachment.py:1127-1137).

Fallback for the precompiled lazy bundles (gen/out/bundles/index.json and gen/out/<template>/bundles, stream G): when <db>/<store_fname> does not
exist, the sha1 named by store_fname is looked up in the index and the bundle file under gen/out/bundles/ is served,
so the ir_attachment row assets.ts inserts for a lazily compiled bundle has its bytes without any copy.

Started by start.sh on a free port: filestore_server.py <root> <port>. Nothing here is deployed.
"""
import email.utils
import http.server
import json
import os
import sys

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])
BUNDLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gen", "out", "bundles")


def bundle_files():
    """store_fname -> absolute bundle file, from gen/out/bundles/index.json and every template's
    gen/out/<template>/bundles/index.json (poc_erp's lazy bundles differ from poc_corpus'), loaded once, lazily."""
    if not hasattr(bundle_files, "cache"):
        cache = {}
        out = os.path.dirname(BUNDLES)
        dirs = [BUNDLES] + sorted(os.path.join(out, d, "bundles") for d in os.listdir(out) if os.path.isdir(os.path.join(out, d, "bundles")))
        for bdir in dirs:
            try:
                with open(os.path.join(bdir, "index.json"), encoding="utf-8") as f:
                    index = json.load(f)
            except (OSError, ValueError):
                continue
            for name, entry in index.items():
                if name == "_meta":
                    continue
                for kind in ("css", "js"):
                    row = entry.get(kind)
                    if row and row.get("store_fname") and row.get("file"):
                        cache.setdefault(row["store_fname"], os.path.join(bdir, row["file"]))
        bundle_files.cache = cache
    return bundle_files.cache


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def do_GET(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if len(parts) < 2 or any(p in (".", "..") for p in parts):
            return self.send_error(404)
        db, store = parts[0], "/".join(parts[1:])
        path = os.path.join(ROOT, db, store)
        if not os.path.isfile(path):
            path = bundle_files().get(store)
            if not path or not os.path.isfile(path):
                return self.send_error(404)
        st = os.stat(path)
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Last-Modified", email.utils.formatdate(st.st_mtime, usegmt=True))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
