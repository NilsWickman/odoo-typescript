/*
 * odoo/odoo/tools/image.py `image_process(source, size=(w, h), verify_resolution=True)` for baseline/progressive
 * RGB JPEG and 8-bit RGB/RGBA PNG sources, reproducing Pillow 10.2.0's Python layer (PIL/Image.py thumbnail,
 * resize, draft; JpegImagePlugin/PngImagePlugin open and _save; ImageFile load/_save) on top of Pillow's own
 * libImaging C code, libjpeg-turbo 3.0.1 and zlib 1.3, as the Odoo server runs them.
 *
 * Exported: `process(src_ptr, src_len, max_w, max_h) -> status`; the output is read with `out_ptr()`/`out_len()`.
 * status: 1 output bytes, 0 the source is returned unchanged, -1 not handled here (the caller refuses),
 * -2 too large (the UserError of image.py), -3 decoding error.
 */
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include "Imaging.h"
#include "ZipCodecs.h"
#undef HAVE_PROTOTYPES
#undef HAVE_STDLIB_H
#undef HAVE_STDDEF_H
#undef UINT8
#undef UINT16
#undef UINT32
#undef INT16
#undef INT32
#include "Jpeg.h"
#define UINT8 uint8_t

extern ImagingShuffler ImagingFindUnpacker(const char *mode, const char *rawmode, int *bits_out);
extern ImagingShuffler ImagingFindPacker(const char *mode, const char *rawmode, int *bits_out);

/* ------------------------------------------------------------------ output buffer */
static uint8_t *out_buf = 0;
static size_t out_size = 0, out_cap = 0;
static void out_reset(void) { free(out_buf); out_buf = 0; out_size = out_cap = 0; }
static void out_write(const uint8_t *p, size_t n) {
    if (out_size + n > out_cap) {
        size_t cap = out_cap ? out_cap : 65536;
        while (cap < out_size + n) cap *= 2;
        out_buf = realloc(out_buf, cap);
        out_cap = cap;
    }
    memcpy(out_buf + out_size, p, n);
    out_size += n;
}
__attribute__((export_name("out_ptr"))) uint8_t *out_ptr(void) { return out_buf; }
__attribute__((export_name("out_len"))) size_t out_len(void) { return out_size; }
__attribute__((export_name("alloc"))) void *wasm_alloc(size_t n) { return malloc(n); }
__attribute__((export_name("dealloc"))) void wasm_dealloc(void *p) { free(p); }

/* ------------------------------------------------------------------ crc32 / chunk helpers (PngImagePlugin) */
extern unsigned long crc32(unsigned long crc, const unsigned char *buf, unsigned int len);
static void o32(uint8_t *b, uint32_t v) { b[0] = v >> 24; b[1] = v >> 16; b[2] = v >> 8; b[3] = v; }
static void putchunk(const char *cid, const uint8_t *data, size_t n) {
    uint8_t b[4];
    o32(b, (uint32_t)n); out_write(b, 4);
    out_write((const uint8_t *)cid, 4);
    if (n) out_write(data, n);
    /* zlib's crc32 returns 0 for a NULL buffer: an empty chunk passes a valid pointer (Python's b"") */
    static const unsigned char empty[1] = {0};
    unsigned long crc = crc32(crc32(0, (const unsigned char *)cid, 4), n ? data : empty, (unsigned)n);
    o32(b, (uint32_t)crc); out_write(b, 4);
}

/* ------------------------------------------------------------------ source image (the PIL ImageFile state) */
enum { FMT_JPEG = 1, FMT_PNG = 2 };
typedef struct {
    int format;
    const uint8_t *src; size_t len;
    const char *mode, *rawmode;
    int width, height;          /* self.size (changes with draft) */
    int scale;                  /* decoderconfig scale (JPEG draft) */
    int draft_done;             /* decoderconfig set */
    Imaging im;                 /* loaded image or NULL */
    /* PNG */
    uint8_t *idat; size_t idat_len;
    int noop_only;              /* opened and loaded as Pillow does, but no resize/save path here: any operation -1 */
} Source;

static int rd16(const uint8_t *p) { return (p[0] << 8) | p[1]; }
static uint32_t rd32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

/* JpegImagePlugin: SOI then marker segments up to SOS; only what the S6-like inputs carry is accepted. */
static int open_jpeg(Source *s) {
    const uint8_t *p = s->src; size_t n = s->len, i = 2;
    int have_sof = 0;
    while (i + 4 <= n) {
        if (p[i] != 0xFF) return -1;
        int m = p[i + 1];
        if (m == 0xFF) { i++; continue; }
        if (m == 0xD8 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
        int len = rd16(p + i + 2);
        const uint8_t *seg = p + i + 4;
        if (m == 0xDA) break; /* SOS */
        if (m == 0xC0 || m == 0xC1 || m == 0xC2) {
            if (seg[0] != 8) return -1;
            s->height = rd16(seg + 1); s->width = rd16(seg + 3);
            if (seg[5] != 3) return -1; /* RGB only */
            have_sof = 1;
        } else if ((m >= 0xC3 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC)) {
            return -1; /* lossless/arithmetic/hierarchical */
        } else if (m == 0xE1) {
            return -1; /* APP1 (Exif/XMP): orientation and exif not handled */
        } else if (m == 0xE2) {
            /* APP2 (ICC profile): only im.info["icc_profile"], which the JPEG writer ignores (encoderinfo only) */
        } else if (m == 0xEE || m == 0xFE) {
            return -1; /* Adobe transform, comment: change the mode or are written back from im.info */
        }
        i += 2 + len;
    }
    if (!have_sof) return -1;
    s->format = FMT_JPEG; s->mode = "RGB"; s->rawmode = "RGB"; s->scale = 1;
    return 0;
}

/* PngImagePlugin: IHDR, IDAT; ancillary chunks that only fill im.info keys PNG/JPEG saving ignores.
 * PngImageFile._open checks the CRC of every chunk before the first IDAT (PngStream.crc); Odoo's server sets
 * ImageFile.LOAD_TRUNCATED_IMAGES (base/models/ir_actions_report.py:31), which skips it for ancillary chunks (bit 5
 * of the first letter): a critical chunk with a wrong CRC is the SyntaxError -> UserError of binary_to_image (-3).
 * An 8-bit palette image (PLTE, and tRNS, which only sets info["transparency"] in mode P) is opened and loaded
 * ("P" unpacker) but not resized or saved here (noop_only): only image_quality's unchanged source (image.py:140). */
static int open_png(Source *s) {
    const uint8_t *p = s->src; size_t n = s->len, i = 8;
    int seen_ihdr = 0, seen_end = 0, seen_idat = 0, seen_plte = 0, palette = 0, texts = 0;
    size_t total = 0;
    while (i + 12 <= n) {
        uint32_t len = rd32(p + i);
        const uint8_t *cid = p + i + 4;
        if (i + 12 + len > n) return -3;
        if (!seen_idat && memcmp(cid, "IDAT", 4) && !(cid[0] & 0x20)) {
            unsigned long crc = crc32(crc32(0, cid, 4), len ? p + i + 8 : cid, len);
            if ((uint32_t)crc != rd32(p + i + 8 + len)) return -3;
        }
        if (!memcmp(cid, "IHDR", 4)) {
            if (len != 13) return -3;
            s->width = rd32(p + i + 8); s->height = rd32(p + i + 12);
            int depth = p[i + 16], type = p[i + 17], comp = p[i + 18], filt = p[i + 19], inter = p[i + 20];
            if (depth != 8 || comp || filt || inter) return -1;
            if (type == 6) { s->mode = "RGBA"; s->rawmode = "RGBA"; }
            else if (type == 2) { s->mode = "RGB"; s->rawmode = "RGB"; }
            else if (type == 3) { s->mode = "P"; s->rawmode = "P"; palette = 1; s->noop_only = 1; }
            else return -1;
            seen_ihdr = 1;
        } else if (!memcmp(cid, "IDAT", 4)) {
            if (palette && !seen_plte) return -1;
            seen_idat = 1;
            total += len;
        } else if (!memcmp(cid, "IEND", 4)) {
            seen_end = 1; break;
        } else if (!memcmp(cid, "PLTE", 4) && palette && !seen_idat && !seen_plte) {
            /* ImagePalette.raw("RGB", data); Image.load's putpalette refuses more than 256 entries (ValueError) */
            if (len < 3 || len > 768 || len % 3) return -1;
            seen_plte = 1;
        } else if (!memcmp(cid, "tRNS", 4) && palette && !seen_idat) {
            /* chunk_tRNS in mode P: info["transparency"] only */
        } else if (!memcmp(cid, "gAMA", 4) || !memcmp(cid, "cHRM", 4) || !memcmp(cid, "sRGB", 4) || !memcmp(cid, "pHYs", 4)
                   || !memcmp(cid, "tEXt", 4) || !memcmp(cid, "tIME", 4) || !memcmp(cid, "bKGD", 4)) {
            /* info keys (gamma, chromaticity, srgb, dpi, text, ...) that neither save path writes */
        } else if (!memcmp(cid, "zTXt", 4) || !memcmp(cid, "iTXt", 4)) {
            /* chunk_zTXt / chunk_iTXt (Pillow 10.2 PngImagePlugin.py:543-618): im.info/im.text only, which neither save
               path writes. A failed decompression or decoding is no error for them (zlib.error, and the ValueError of
               _safe_zlib_decompress under LOAD_TRUNCATED_IMAGES, give an empty or skipped text); zTXt's compression
               method other than 0 raises SyntaxError, refused here. check_text_memory's 64 MB over all text chunks
               (each decompressed to at most 1 MB) cannot be reached by fewer than 64 of them: more refuse. */
            if (++texts > 60) return -1;
            if (!memcmp(cid, "zTXt", 4)) {
                const uint8_t *d = p + i + 8;
                uint32_t k = 0;
                while (k < len && d[k]) k++;
                if (k + 1 < len && d[k + 1] != 0) return -1;
            }
        } else if (cid[1] >= 'a' && cid[1] <= 'z') {
            /* a private chunk (lowercase second letter): Pillow has no handler for it, reads it into
               `private_chunks` (PngImagePlugin.py PngImageFile._open, the AttributeError branch), and `_save` never
               writes those; base/static/img/res_company_logo.png carries one ("orNT") */
        } else {
            return -1; /* iCCP, tRNS outside mode P, PLTE outside mode P, eXIf, animation */
        }
        i += 12 + len;
    }
    if (!seen_ihdr || !seen_end) return -3;
    s->idat = malloc(total ? total : 1); s->idat_len = 0;
    for (i = 8; i + 12 <= n;) {
        uint32_t len = rd32(p + i);
        if (!memcmp(p + i + 4, "IDAT", 4)) { memcpy(s->idat + s->idat_len, p + i + 8, len); s->idat_len += len; }
        if (!memcmp(p + i + 4, "IEND", 4)) break;
        i += 12 + len;
    }
    s->format = FMT_PNG;
    return 0;
}

/* ImageFile.load: decoder.setimage(im, extents) then decode(b) until n < 0 (decode.c _setimage/_decode). */
static int load(Source *s) {
    if (s->im) return 0;
    Imaging im = ImagingNewDirty(s->mode, s->width, s->height);
    if (!im) return -3;
    struct ImagingCodecStateInstance st;
    memset(&st, 0, sizeof st);
    int bits;
    int status;
    if (s->format == FMT_JPEG) {
        const char *rawmode = s->rawmode;
        if (ImagingJpegUseJCSExtensions() && !strcmp(rawmode, "RGB")) rawmode = "RGBX";
        st.shuffle = ImagingFindUnpacker(s->mode, rawmode, &bits);
        if (!st.shuffle) return -1;
        st.bits = bits;
        JPEGSTATE *ctx = calloc(1, sizeof(JPEGSTATE));
        st.context = ctx;
        strncpy(ctx->rawmode, rawmode, 8);
        strncpy(ctx->jpegmode, "", 8);
        ctx->scale = s->scale;
        ctx->draft = 0;
        st.xsize = im->xsize; st.ysize = im->ysize;
        st.bytes = (st.bits * st.xsize + 7) / 8;
        st.buffer = calloc(1, st.bytes);
        /* the whole file in one buffer (ImageFile.load feeds growing prefixes; libjpeg's output does not depend on it) */
        const uint8_t *b = s->src; size_t left = s->len;
        for (;;) {
            status = ImagingJpegDecode(im, &st, (UINT8 *)b, (Py_ssize_t)left);
            if (status < 0) break;
            if (status == 0 && left == 0) { status = -3; break; }
            b += status; left -= status;
            if (left == 0 && status == 0) break;
        }
        ImagingJpegDecodeCleanup(&st);
        free(st.buffer); free(ctx);
        if (st.errcode < 0 && st.errcode != IMAGING_CODEC_END) { ImagingDelete(im); return -3; }
    } else {
        st.shuffle = ImagingFindUnpacker(s->mode, s->rawmode, &bits);
        if (!st.shuffle) return -1;
        st.bits = bits;
        ZIPSTATE *ctx = calloc(1, sizeof(ZIPSTATE));
        st.context = ctx;
        ctx->interlaced = 0;
        st.xsize = im->xsize; st.ysize = im->ysize;
        st.bytes = (st.bits * st.xsize + 7) / 8;
        st.buffer = calloc(1, st.bytes);
        const uint8_t *b = s->idat; size_t left = s->idat_len;
        for (;;) {
            status = ImagingZipDecode(im, &st, (UINT8 *)b, (Py_ssize_t)left);
            if (status < 0) break;
            b += status; left -= status;
            if (status == 0 && left == 0) { status = -3; break; }
        }
        ImagingZipDecodeCleanup(&st);
        free(st.buffer); free(ctx);
        if (st.errcode < 0 && st.errcode != IMAGING_CODEC_END) { ImagingDelete(im); return -3; }
    }
    s->im = im;
    return 0;
}

/* ------------------------------------------------------------------ Image.thumbnail / draft / resize (Pillow 10.2.0) */
static double pyfloor(double x) { return floor(x); }

/* round_aspect(number, key) = max(min(floor(number), ceil(number), key=key), 1) */
static int round_aspect_x(double number, double aspect, double y) {
    double f = pyfloor(number), c = ceil(number);
    double kf = fabs(aspect - f / y), kc = fabs(aspect - c / y);
    double r = kc < kf ? c : f;
    return r < 1 ? 1 : (int)r;
}
static int round_aspect_y(double number, double aspect, double x) {
    double f = pyfloor(number), c = ceil(number);
    double kf = f == 0 ? 0 : fabs(aspect - x / f), kc = c == 0 ? 0 : fabs(aspect - x / c);
    double r = kc < kf ? c : f;
    return r < 1 ? 1 : (int)r;
}
/* preserve_aspect_ratio(): 0 when no resize is needed */
static int preserve_aspect_ratio(int pw, int ph, int w, int h, int *ox, int *oy) {
    int x = pw, y = ph;
    if (x >= w && y >= h) return 0;
    double aspect = (double)w / (double)h;
    if ((double)x / (double)y >= aspect) x = round_aspect_x((double)y * aspect, aspect, (double)y);
    else y = round_aspect_y((double)x / aspect, aspect, (double)x);
    *ox = x; *oy = y;
    return 1;
}

static Imaging convert(Imaging im, const char *mode) {
    Imaging out = ImagingConvert(im, mode, NULL, 0);
    return out;
}

/* Image.resize(size, LANCZOS, box, reducing_gap) */
static Imaging resize(Imaging im, int sx, int sy, double box[4], int has_gap, double gap) {
    double b0 = box[0], b1 = box[1], b2 = box[2], b3 = box[3];
    if (im->xsize == sx && im->ysize == sy && b0 == 0 && b1 == 0 && b2 == im->xsize && b3 == im->ysize) return ImagingCopy(im);
    if (!strcmp(im->mode, "RGBA")) {
        Imaging a = convert(im, "RGBa");
        double nb[4] = {b0, b1, b2, b3};
        Imaging r = resize(a, sx, sy, nb, 0, 0);
        ImagingDelete(a);
        Imaging back = convert(r, "RGBA");
        ImagingDelete(r);
        return back;
    }
    Imaging cur = im; int owned = 0;
    if (has_gap) {
        long fx = (long)((b2 - b0) / sx / gap); if (!fx) fx = 1;
        long fy = (long)((b3 - b1) / sy / gap); if (!fy) fy = 1;
        if (fx > 1 || fy > 1) {
            /* _get_safe_box (LANCZOS support 3.0) */
            double fs = 3.0 - 0.5;
            double scx = (b2 - b0) / sx, scy = (b3 - b1) / sy;
            double sux = fs * scx, suy = fs * scy;
            int rb[4];
            rb[0] = (int)(b0 - sux); if (rb[0] < 0) rb[0] = 0;
            rb[1] = (int)(b1 - suy); if (rb[1] < 0) rb[1] = 0;
            double c2 = ceil(b2 + sux), c3 = ceil(b3 + suy);
            rb[2] = c2 > im->xsize ? im->xsize : (int)c2;
            rb[3] = c3 > im->ysize ? im->ysize : (int)c3;
            /* Image.reduce: RGBA handled above; (1, 1) with the full box copies */
            if (fx == 1 && fy == 1 && rb[0] == 0 && rb[1] == 0 && rb[2] == im->xsize && rb[3] == im->ysize) cur = ImagingCopy(im);
            else cur = ImagingReduce(im, (int)fx, (int)fy, rb);
            owned = 1;
            double nb0 = (b0 - rb[0]) / fx, nb1 = (b1 - rb[1]) / fy, nb2 = (b2 - rb[0]) / fx, nb3 = (b3 - rb[1]) / fy;
            b0 = nb0; b1 = nb1; b2 = nb2; b3 = nb3;
        }
    }
    /* _imaging.c _resize: the box as C floats */
    float fb[4] = {(float)b0, (float)b1, (float)b2, (float)b3};
    Imaging out;
    if (fb[0] - (int)fb[0] == 0 && fb[2] - fb[0] == sx && fb[1] - (int)fb[1] == 0 && fb[3] - fb[1] == sy)
        out = ImagingCrop(cur, (int)fb[0], (int)fb[1], (int)fb[2], (int)fb[3]);
    else
        out = ImagingResample(cur, sx, sy, IMAGING_TRANSFORM_LANCZOS, fb);
    if (owned) ImagingDelete(cur);
    return out;
}

/* ------------------------------------------------------------------ savers */
static int save_png(Imaging im) {
    out_reset();
    static const uint8_t magic[8] = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
    out_write(magic, 8);
    uint8_t ihdr[13];
    o32(ihdr, im->xsize); o32(ihdr + 4, im->ysize);
    const char *rawmode;
    if (!strcmp(im->mode, "RGBA")) { ihdr[8] = 8; ihdr[9] = 6; rawmode = "RGBA"; }
    else if (!strcmp(im->mode, "RGB")) { ihdr[8] = 8; ihdr[9] = 2; rawmode = "RGB"; }
    else return -1;
    ihdr[10] = ihdr[11] = ihdr[12] = 0;
    putchunk("IHDR", ihdr, 13);
    struct ImagingCodecStateInstance st;
    memset(&st, 0, sizeof st);
    int bits;
    st.shuffle = ImagingFindPacker(im->mode, rawmode, &bits);
    if (!st.shuffle) return -1;
    st.bits = bits;
    ZIPSTATE *ctx = calloc(1, sizeof(ZIPSTATE));
    st.context = ctx;
    ctx->optimize = 1; ctx->compress_level = -1; ctx->compress_type = -1; ctx->dictionary = NULL; ctx->dictionary_size = 0;
    st.xsize = im->xsize; st.ysize = im->ysize;
    st.bytes = (st.bits * st.xsize + 7) / 8;
    st.buffer = calloc(1, st.bytes);
    int bufsize = 65536; if (im->xsize * 4 > bufsize) bufsize = im->xsize * 4;
    uint8_t *buf = malloc(bufsize);
    for (;;) {
        int status = ImagingZipEncode(im, &st, buf, bufsize);
        putchunk("IDAT", buf, status > 0 ? status : 0);
        if (st.errcode) break;
    }
    int err = st.errcode;
    ImagingZipEncodeCleanup(&st);
    free(buf); free(st.buffer); free(ctx);
    if (err < 0) return -3;
    putchunk("IEND", 0, 0);
    return 1;
}

static int save_jpeg(Imaging im) {
    out_reset();
    if (strcmp(im->mode, "RGB")) return -1;
    struct ImagingCodecStateInstance st;
    memset(&st, 0, sizeof st);
    int bits;
    const char *rawmode = "RGB";
    if (ImagingJpegUseJCSExtensions()) rawmode = "RGBX";
    st.shuffle = ImagingFindPacker(im->mode, rawmode, &bits);
    if (!st.shuffle) return -1;
    st.bits = bits;
    JPEGENCODERSTATE *ctx = calloc(1, sizeof(JPEGENCODERSTATE));
    st.context = ctx;
    strncpy(ctx->rawmode, rawmode, 8);
    ctx->keep_rgb = 0; ctx->quality = 95; ctx->qtables = NULL; ctx->qtablesLen = 0; ctx->subsampling = -1;
    ctx->progressive = 0; ctx->smooth = 0; ctx->optimize = 1; ctx->streamtype = 0; ctx->xdpi = 0; ctx->ydpi = 0;
    ctx->restart_marker_blocks = 0; ctx->restart_marker_rows = 0;
    ctx->comment = NULL; ctx->comment_size = 0; ctx->extra = NULL; ctx->extra_size = 0; ctx->rawExif = NULL; ctx->rawExifLen = 0;
    st.xsize = im->xsize; st.ysize = im->ysize;
    st.bytes = (st.bits * st.xsize + 7) / 8;
    st.buffer = calloc(1, st.bytes);
    /* bufsize: optimize, quality >= 95 -> 2 * w * h; ImageFile._save: max(MAXBLOCK, bufsize, w * 4) */
    long bufsize = 2L * im->xsize * im->ysize;
    if (bufsize < 65536) bufsize = 65536;
    if (bufsize < im->xsize * 4L) bufsize = im->xsize * 4L;
    uint8_t *buf = malloc(bufsize);
    for (;;) {
        int status = ImagingJpegEncode(im, &st, buf, (int)bufsize);
        if (status > 0) out_write(buf, status);
        if (st.errcode) break;
    }
    int err = st.errcode;
    free(buf); free(st.buffer);
    free(ctx);
    if (err < 0) return -3;
    return 1;
}

/* ------------------------------------------------------------------ image.py image_process */
#define IMAGE_MAX_RESOLUTION 50e6

/* crop: 0 none, 1 center, 2 top, 3 bottom (image_process `crop`); verify: verify_resolution */
__attribute__((export_name("process")))
int process(const uint8_t *src, size_t len, int max_w, int max_h, int crop, int verify) {
    out_reset();
    if (!src || !len || src[0] == '<') return 0;
    if (len >= 15 && !memcmp(src, "RIFF", 4) && !memcmp(src + 8, "WEBPVP8", 7)) return -1;
    Source s;
    memset(&s, 0, sizeof s);
    s.src = src; s.len = len;
    int r;
    if (len > 3 && src[0] == 0xFF && src[1] == 0xD8 && src[2] == 0xFF) r = open_jpeg(&s);
    else if (len > 8 && !memcmp(src, "\x89PNG\r\n\x1a\n", 8)) r = open_png(&s);
    else return -1;
    if (r < 0) { free(s.idat); return r; }
    /* image_fix_orientation: no exif in the accepted sources; PNG getexif() loads the image */
    if (s.format == FMT_PNG) { r = load(&s); if (r < 0) { free(s.idat); return r; } }
    if (verify && (double)s.width * (double)s.height > IMAGE_MAX_RESOLUTION) { if (s.im) ImagingDelete(s.im); free(s.idat); return -2; }
    int operations = 0;
    if (crop && max_w && max_h) {
        /* ImageProcess.crop_resize (image.py:201-232) */
        int w = s.width, h = s.height;
        long nw, nh;
        if ((double)w / max_w > (double)h / max_h) { nw = w; nh = ((long)max_h * w) / max_w; }
        else { nw = ((long)max_w * h) / max_h; nh = h; }
        if (nw > w) { nh = (nh * w) / nw; nw = w; }
        if (nh > h) { nw = (nw * h) / nh; nh = h; }
        if (nw < 1) nw = 1;
        if (nh < 1) nh = 1;
        double cy = crop == 2 ? 0.0 : crop == 3 ? 1.0 : 0.5;
        int xo = (int)((w - nw) * 0.5), yo = (int)((h - nh) * cy);
        if (nw != w || nh != h) {
            if (s.noop_only) { if (s.im) ImagingDelete(s.im); free(s.idat); return -1; }
            r = load(&s); if (r < 0) { free(s.idat); return r; }
            Imaging c = ImagingCrop(s.im, xo, yo, xo + (int)nw, yo + (int)nh);
            ImagingDelete(s.im);
            s.im = c; s.width = (int)nw; s.height = (int)nh;
            if (s.width != w || s.height != h) operations++;
        }
    }
    int w0 = s.width, h0 = s.height;
    if (max_w || max_h) {
        int aw = max_w ? max_w : (int)(((long long)w0 * max_h) / h0);
        int ah = max_h ? max_h : (int)(((long long)h0 * max_w) / w0);
        if (aw != w0 || ah != h0) {
            /* thumbnail((aw, ah), LANCZOS, reducing_gap=2.0) */
            int tx, ty;
            if (preserve_aspect_ratio(aw, ah, s.width, s.height, &tx, &ty)) {
                int has_box = 0; double box[4];
                if (s.format == FMT_JPEG && !s.im && !s.draft_done) {
                    /* JpegImageFile.draft(None, (tx * 2.0, ty * 2.0)) */
                    double dw = tx * 2.0, dh = ty * 2.0;
                    double scale = fmin(floor(s.width / dw), floor(s.height / dh));
                    int sc = 1;
                    if (scale >= 8) sc = 8; else if (scale >= 4) sc = 4; else if (scale >= 2) sc = 2; else sc = 1;
                    int ow = s.width, oh = s.height;
                    s.width = (s.width + sc - 1) / sc; s.height = (s.height + sc - 1) / sc;
                    s.scale = sc; s.draft_done = 1;
                    box[0] = 0; box[1] = 0; box[2] = (double)ow / sc; box[3] = (double)oh / sc;
                    has_box = 1;
                }
                if (!has_box) {
                    r = load(&s); if (r < 0) { free(s.idat); return r; }
                    if (!preserve_aspect_ratio(aw, ah, s.width, s.height, &tx, &ty)) goto done_resize;
                    box[0] = 0; box[1] = 0; box[2] = s.im->xsize; box[3] = s.im->ysize;
                }
                if (s.width != tx || s.height != ty) {
                    if (s.noop_only) { if (s.im) ImagingDelete(s.im); free(s.idat); return -1; }
                    r = load(&s); if (r < 0) { free(s.idat); return r; }
                    Imaging out = resize(s.im, tx, ty, box, 1, 2.0);
                    if (!out) { ImagingDelete(s.im); free(s.idat); return -3; }
                    ImagingDelete(s.im);
                    s.im = out;
                    s.width = tx; s.height = ty;
                }
                if (s.width != w0 || s.height != h0) operations++;
            }
        }
    }
done_resize:
    /* image_quality(quality=0, output_format='') */
    if (!operations) { if (s.im) ImagingDelete(s.im); free(s.idat); return 0; }
    if (s.noop_only) { if (s.im) ImagingDelete(s.im); free(s.idat); return -1; }
    r = load(&s); if (r < 0) { free(s.idat); return r; }
    int res = s.format == FMT_PNG ? save_png(s.im) : save_jpeg(s.im);
    ImagingDelete(s.im); free(s.idat);
    if (res == 1 && out_size >= len && 0) return 0; /* (only when no operation was applied) */
    return res;
}
