"""Package a read-only Odoo filestore as Workers Static Assets, without an R2 subscription.

python3 gen/filestore.py [--source /path/to/template/filestore ...]
The default sources are the poc filestore used by S1's poc_corpus database copies and poc_erp's (C1), plus the
precompiled bundles of every template (gen/out/bundles, gen/out/<template>/bundles).
Files keep Odoo's content-addressed store_fname; metadata preserves source mtimes.
This is deployment input, not a corpus of recorded HTTP responses. New uploads
require a writable backend and are outside this read-only snapshot.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

WORKER = Path(__file__).resolve().parents[1]
MAX_FILES = 20_000
MAX_SIZE = 25 * 1024 * 1024
STORE_NAME = re.compile(r"[0-9a-f]{2}/[0-9a-f]{40}\Z")


def checked_file(key, path):
    if not STORE_NAME.fullmatch(key) or key[:2] != key[3:5]:
        raise ValueError(f"Invalid Odoo store_fname: {key}")
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Not a regular filestore file: {path}")
    if path.stat().st_size > MAX_SIZE:
        raise ValueError(f"Static Asset exceeds 25 MiB: {path}")
    if hashlib.sha1(path.read_bytes()).hexdigest() != key[3:]:
        raise ValueError(f"Content does not match store_fname: {path}")
    return path


def _paths(value):
    """One Path or several: C1's poc_erp template is packaged next to S1's poc (store_fname is content-addressed,
    so the union of the snapshots serves both templates' databases)."""
    return [value] if isinstance(value, Path) else list(value)


def export(source, assets, bundles, metadata):
    files = {}
    # the packaged filestore belongs to this tree: in a worktree made by run/mkworktree.sh assets/__filestore is a link
    # to the main checkout's, which this tree must not write into; it becomes this tree's own directory (every file is
    # copied below anyway)
    if (assets / "__filestore").is_symlink():
        (assets / "__filestore").unlink()
    for src in _paths(source):
        if not src.is_dir():
            raise ValueError(f"Filestore directory missing: {src}")
        found = {}
        for path in sorted(src.rglob("*")):
            if path.is_file() or path.is_symlink():
                # Odoo's checklist contains GC markers, not attachment contents.
                key = path.relative_to(src).as_posix()
                if key.startswith("checklist/"):
                    continue
                found[key] = checked_file(key, path)
        if not found:
            raise ValueError(f"Filestore is empty: {src}")
        for key, path in found.items():
            files.setdefault(key, path)  # the first template's copy (and mtime) wins; the bytes are the same
    for bdir in _paths(bundles):
        index = json.loads((bdir / "index.json").read_text())
        for name, entry in index.items():
            if name == "_meta":
                continue
            for kind in ("css", "js"):
                row = entry.get(kind)
                if row:
                    path = bdir / row["file"]
                    if path.parent.resolve() != bdir.resolve():
                        raise ValueError(f"Bundle is outside the generated directory: {path}")
                    checked_file(row["store_fname"], path)
                    # Native template files take precedence, including their mtimes.
                    files.setdefault(row["store_fname"], path)

    # Generated data too big for the Worker bundle (src/gen_assets.ts): gen/out/<template>/lang/*.json and
    # gen/out/<template>/chart/*.json as /__gen/<template>/..., read through the ASSETS binding (start.sh does the
    # same locally).
    gen_out = WORKER / "gen/out"
    # and the overlays of templates built over another one (src/orm/overlay.ts, gen/template_delta.py)
    overlays = [t["overlay"] for t in json.loads((gen_out / "templates.json").read_text()).values() if t.get("overlay")]
    for path in sorted([*gen_out.glob("*/lang/*.json"), *gen_out.glob("*/chart/*.json"), *gen_out.glob("*/upgrade/*.json"), *gen_out.glob("*/uninstall/*.json"), *(p for o in overlays for p in (gen_out / o).glob("*.json"))]):
        target = assets / "__gen" / path.relative_to(gen_out)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)

    # Include existing files in the check, so a stale export cannot evade limits.
    # A worktree made by run/mkworktree.sh has its modules' static files as links to the main checkout's directories
    # (assets/<module> -> <main>/worker/assets/<module>): such a link, directly under assets and to a directory, is
    # followed (wrangler follows it too: `deploy --dry-run` in a linked tree read all 7775 entries under the links,
    # 2026-11-11), and its files are counted under the link's name. Any other link is still refused.
    sizes = {}

    def count(root, prefix):
        for path in root.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"Symlink in static assets: {path}")
            if path.is_file():
                sizes[prefix + path.relative_to(root).as_posix()] = path.stat().st_size

    for entry in sorted(assets.iterdir()):
        if entry.is_symlink():
            if not entry.resolve().is_dir():
                raise ValueError(f"Symlink in static assets: {entry}")
            count(entry.resolve(), entry.name + "/")
        elif entry.is_dir():
            count(entry, entry.name + "/")
        elif entry.is_file():
            sizes[entry.name] = entry.stat().st_size
    sizes.update({f"__filestore/{key}": path.stat().st_size for key, path in files.items()})
    if len(sizes) > MAX_FILES:
        raise ValueError(f"Workers Free allows {MAX_FILES} assets; found {len(sizes)}")
    for key, size in sizes.items():
        if size > MAX_SIZE:
            raise ValueError(f"Static Asset exceeds 25 MiB: {key}")

    mtimes = {}
    for key, path in files.items():
        target = assets / "__filestore" / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        mtimes[key] = int(path.stat().st_mtime) * 1000
    metadata.parent.mkdir(parents=True, exist_ok=True)
    metadata.write_text(json.dumps(mtimes, sort_keys=True, indent=1) + "\n")
    result = {"filestore_files": len(files), "asset_files": len(sizes),
              "asset_bytes": sum(sizes.values()), "largest_asset_bytes": max(sizes.values()),
              "file_limit": MAX_FILES, "file_size_limit_bytes": MAX_SIZE}
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, action="append",
                        help="template filestore (repeatable; default: poc for S1 and poc_erp for C1)")
    args = parser.parse_args()
    sources = args.source or [WORKER.parent / "run/filestore/filestore/poc", WORKER.parent / "run/filestore/filestore/poc_erp"]
    bundle_dirs = [WORKER / "gen/out/bundles"] + sorted(p.parent for p in (WORKER / "gen/out").glob("*/bundles/index.json"))
    print(json.dumps(export(sources, WORKER / "assets", bundle_dirs, WORKER / "gen/out/filestore.json"), indent=2))
