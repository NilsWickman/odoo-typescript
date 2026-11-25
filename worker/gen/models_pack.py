"""models.pack beside a models.json: what the Worker bundles of the model metadata (src/gen_models.ts).

  python3 worker/gen/models_pack.py [models.json ...]     (default: gen/out/models.json and gen/out/poc_erp/models.json)

The Worker keeps the metadata for an isolate's whole life and parses a model when it is first read. As text that was
21.6 MB of the heap (docs/infra-2026-11-13.md section 12); here every model is its own raw-deflate chunk, 1.5 MB in
all, inflated at that first read. The file: one line of JSON, {"format": "models.pack/1", the JSON's other keys,
"models": [[name, bytes of its chunk], ...]} in the JSON's order, a newline, then the chunks one after another. A
chunk inflates to the model's compact ASCII JSON. gen/_odoo.py write_models_json writes it with every models.json;
src/gen_models.test.ts compares the two, model by model.
"""
import json
import os
import sys
import zlib


def write(json_path):
    with open(json_path, encoding='ascii') as f:
        data = json.load(f)
    dump = lambda v: json.dumps(v, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(',', ':'))  # noqa: E731
    chunks = []
    for name, model in data['models'].items():
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        chunks.append((name, c.compress(dump(model).encode('ascii')) + c.flush()))
    head = {'format': 'models.pack/1', **{k: v for k, v in data.items() if k != 'models'},
            'models': [[name, len(chunk)] for name, chunk in chunks]}
    path = os.path.join(os.path.dirname(json_path), 'models.pack')
    with open(path, 'wb') as f:
        f.write(json.dumps(head, ensure_ascii=True, separators=(',', ':')).encode('ascii') + b'\n')
        for _, chunk in chunks:
            f.write(chunk)
    return path


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
    for p in sys.argv[1:] or [os.path.join(out, 'models.json'), os.path.join(out, 'poc_erp', 'models.json')]:
        path = write(p)
        print(f'{path}: {os.path.getsize(path)} bytes from {os.path.getsize(p)}')
