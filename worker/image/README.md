# Image processing in Wasm (`src/image/odoo-image.wasm`)

`odoo.tools.image.image_process` as Odoo's server runs it, byte for byte: the C code of the exact library
versions in Odoo's `.venv`, compiled to WebAssembly, plus a C port of the Pillow Python steps on that path.

| Component | Version | Source | Used for |
|---|---|---|---|
| Pillow libImaging | 10.2.0 | PyPI sdist `pillow-10.2.0.tar.gz` | Storage, Resample (LANCZOS), Reduce, Convert (RGBA/RGBa), Crop, Pack/Unpack, JpegDecode/JpegEncode, ZipDecode/ZipEncode |
| libjpeg-turbo | 3.0.1 (C paths, no SIMD) | GitHub release tarball | JPEG decode (incl. scaled IDCT for `draft`) and encode (quality 95, optimized Huffman) |
| zlib | 1.3 (as `/lib/x86_64-linux-gnu/libz.so.1` on the Odoo host) | zlib.net | PNG IDAT inflate/deflate |

`SHA256SUMS` pins the three tarballs (checked by `build.sh`); `SHA256SUMS.build` records the sources written here
and the resulting `.wasm`.

## What `glue.c` ports

`ImageProcess.__init__` (open, `image_fix_orientation`, `verify_resolution`), `crop_resize`, `resize`
(`Image.thumbnail(size, LANCZOS)` with `reducing_gap=2.0`: `preserve_aspect_ratio`, `JpegImageFile.draft`,
`Image.resize` with `_get_safe_box`/`reduce`, the RGBA -> RGBa -> RGBA detour, `_imaging.c _resize`'s float box)
and `image_quality` (JPEG `quality=95, optimize=True`; PNG `optimize=True`: `JpegImagePlugin._save`,
`PngImagePlugin._save` chunk layout, `ImageFile._save` buffer sizes, one IDAT chunk per encoder call).

Accepted inputs (everything else returns -1 and the Worker raises `NotPorted`): baseline/extended/progressive
8-bit 3-component JPEG without APP1 (Exif/XMP), APP14 (Adobe) or COM markers (APP2 ICC is fine: the JPEG writer
ignores `im.info`); non-interlaced 8-bit RGB/RGBA PNG whose ancillary chunks are only gAMA, cHRM, sRGB, pHYs, tEXt, zTXt, iTXt,
tIME, bKGD. No quality other than 0, no output format change, no colorize/padding/expand.

An 8-bit palette PNG (PLTE with at most 256 entries, tRNS allowed) is opened and loaded as Pillow does (the "P"
unpacker), and only the unchanged source is returned for it (no operation: `image_quality`, image.py:140); a crop or
resize of one returns -1. Before the first IDAT the CRC of every critical chunk is checked (PngStream.crc; Odoo's
server sets `ImageFile.LOAD_TRUNCATED_IMAGES`, base/models/ir_actions_report.py:31, which skips ancillary chunks): a
wrong one is the UserError path (-3). Checked on Fleet's 67 brand logos (65 RGB, 2 palette) against Odoo:
process.test.ts.

## Build

`bash image/build.sh` from `worker/` (needs `clang-18` and `wasm-ld-18`, apt packages `clang-18 lld-18`). No
downloaded binary runs: the tarballs are compiled with `-nostdlib`; `shim.c` is the C library (bump allocator
reset per call, string/memory functions, FreeBSD msun `sin`/`cos`, traps for error-only paths), `shim/*.h` its
headers, `config/` libjpeg-turbo's generated headers, `except.c` libImaging's error hooks.

## Verification

`src/image/process.test.ts` compares sha256 with Odoo's own `image_process` for the S6 uploads (2400x1600 JPEG,
640x480 RGBA PNG): `image_1920` and, from it, 1024/512/256/128 (the stored related fields), and 1024/512/256/128
straight from the source (onchange `avatar_128`), 18 outputs, all identical; the S6 PDF thumbnail
`180x110 crop=top` is identical too (checked once against Odoo, see the S6 gate). S6 strict is green with it.

## Size and time (node 24, this host)

- `odoo-image.wasm`: 738,608 bytes (186,328 gzip -9); no imports; exports `memory`, `alloc`, `dealloc`,
  `heap_reset`, `process`, `out_ptr`, `out_len`.
- Linear memory peaks at 50 MiB for the 2400x1600 JPEG (bump allocator); a fresh instance per call (initial memory 2 MiB) lets it be collected afterwards.
- CPU: photo.jpg -> image_1920 ~395 ms; the related sizes from it 115/81/32/18 ms; logo.png sizes 28-83 ms.
