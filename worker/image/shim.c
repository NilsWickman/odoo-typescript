/*
 * Minimal C library for the image module (no files, no locale, no threads): memory, strings, the few math
 * functions libImaging/libjpeg/zlib call, and traps for everything that would only run on error paths.
 *
 * Memory: a bump allocator over the Wasm linear memory, reset at the start of every `process` call (the output of
 * the previous call is not needed any more by then). Each block has an 8-byte size header so realloc can copy.
 * sin/cos are FreeBSD msun (fdlibm, as in musl), accurate to < 1 ulp; the outputs are checked byte for byte
 * against Pillow's (glibc) results by build.sh's verification.
 */
#include <stddef.h>
#include <stdint.h>

extern unsigned char __heap_base;
static uintptr_t heap_top = 0;

static void *grow_to(uintptr_t end) {
    uintptr_t have = __builtin_wasm_memory_size(0) * 65536u;
    if (end > have) {
        uintptr_t pages = (end - have + 65535u) / 65536u;
        if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
    }
    return (void *)1;
}

__attribute__((export_name("heap_reset"))) void heap_reset(void) { heap_top = (uintptr_t)&__heap_base; }

void *malloc(size_t n) {
    if (!heap_top) heap_top = (uintptr_t)&__heap_base;
    uintptr_t p = (heap_top + 15u) & ~(uintptr_t)15u;
    uintptr_t start = p + 16u;
    uintptr_t end = start + n;
    if (end < start || !grow_to(end)) return 0;
    *(size_t *)(start - 8u) = n;
    heap_top = end;
    return (void *)start;
}
void free(void *p) { (void)p; }
void *calloc(size_t n, size_t m) {
    size_t t = n * m;
    if (m && t / m != n) return 0;
    unsigned char *p = malloc(t);
    if (p) for (size_t i = 0; i < t; i++) p[i] = 0; /* fresh memory may hold earlier calls' data */
    return p;
}
void *memcpy(void *d, const void *s, size_t n);
void *realloc(void *p, size_t n) {
    if (!p) return malloc(n);
    size_t old = *(size_t *)((unsigned char *)p - 8u);
    void *q = malloc(n);
    if (q) memcpy(q, p, old < n ? old : n);
    return q;
}

void *memcpy(void *d, const void *s, size_t n) {
    unsigned char *a = d; const unsigned char *b = s;
    while (n--) *a++ = *b++;
    return d;
}
void *memmove(void *d, const void *s, size_t n) {
    unsigned char *a = d; const unsigned char *b = s;
    if (a < b) { while (n--) *a++ = *b++; }
    else { a += n; b += n; while (n--) *--a = *--b; }
    return d;
}
void *memset(void *d, int c, size_t n) {
    unsigned char *a = d;
    while (n--) *a++ = (unsigned char)c;
    return d;
}
int memcmp(const void *x, const void *y, size_t n) {
    const unsigned char *a = x, *b = y;
    for (; n; n--, a++, b++) if (*a != *b) return *a - *b;
    return 0;
}
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return (unsigned char)*a - (unsigned char)*b; }
int strncmp(const char *a, const char *b, size_t n) {
    for (; n; n--, a++, b++) { if (*a != *b) return (unsigned char)*a - (unsigned char)*b; if (!*a) return 0; }
    return 0;
}
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)); return r; }
char *strncpy(char *d, const char *s, size_t n) {
    size_t i = 0;
    for (; i < n && s[i]; i++) d[i] = s[i];
    for (; i < n; i++) d[i] = 0;
    return d;
}
char *strchr(const char *s, int c) { for (;; s++) { if (*s == (char)c) return (char *)s; if (!*s) return 0; } }
int abs(int x) { return x < 0 ? -x : x; }
long labs(long x) { return x < 0 ? -x : x; }
char *getenv(const char *n) { (void)n; return 0; }
int setenv(const char *n, const char *v, int o) { (void)n; (void)v; (void)o; return 0; }
int errno = 0;

__attribute__((noreturn)) void abort(void) { __builtin_trap(); }
__attribute__((noreturn)) void exit(int c) { (void)c; __builtin_trap(); }
__attribute__((noreturn)) void longjmp(int *b, int v) { (void)b; (void)v; __builtin_trap(); }

/* stdio: only reached by libjpeg's message output (no-op) */
typedef struct _shim_FILE FILE;
FILE *stderr = 0, *stdout = 0;
int fprintf(FILE *f, const char *fmt, ...) { (void)f; (void)fmt; return 0; }
int printf(const char *fmt, ...) { (void)fmt; return 0; }
int sprintf(char *s, const char *fmt, ...) { (void)fmt; if (s) s[0] = 0; return 0; }
int snprintf(char *s, size_t n, const char *fmt, ...) { (void)fmt; if (s && n) s[0] = 0; return 0; }
size_t fread(void *p, size_t s, size_t n, FILE *f) { (void)p; (void)s; (void)n; (void)f; __builtin_trap(); }
size_t fwrite(const void *p, size_t s, size_t n, FILE *f) { (void)p; (void)s; (void)n; (void)f; __builtin_trap(); }
int fflush(FILE *f) { (void)f; return 0; }
int ferror(FILE *f) { (void)f; return 0; }

/* math */
double fabs(double x) { return __builtin_fabs(x); }
double floor(double x) { return __builtin_floor(x); }
double ceil(double x) { return __builtin_ceil(x); }
double sqrt(double x) { return __builtin_sqrt(x); }
double fmin(double a, double b) { return a < b ? a : b; }
float floorf(float x) { return __builtin_floorf(x); }
double round(double x) { double t = __builtin_trunc(x); if (__builtin_fabs(x - t) >= 0.5) t += (x > 0 ? 1.0 : -1.0); return t; }
float roundf(float x) { float t = __builtin_truncf(x); if (__builtin_fabsf(x - t) >= 0.5f) t += (x > 0 ? 1.0f : -1.0f); return t; }
double pow(double x, double y) { (void)x; (void)y; __builtin_trap(); }
double exp(double x) { (void)x; __builtin_trap(); }
double log(double x) { (void)x; __builtin_trap(); }
double fmod(double x, double y) { (void)x; (void)y; __builtin_trap(); }

/* FreeBSD msun k_sin.c / k_cos.c / e_rem_pio2.c (medium arguments) / s_sin.c / s_cos.c */
static const double
S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
static double k_sin(double x, double y, int iy) {
    double z = x * x, w = z * z, r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6), v = z * x;
    if (iy == 0) return x + v * (S1 + z * r);
    return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}
static const double
C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
static double k_cos(double x, double y) {
    double z = x * x, w = z * z, r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
    double hz = 0.5 * z, ww = 1.0 - hz;
    return ww + (((1.0 - ww) - hz) + (z * r - x * y));
}
typedef union { double f; uint64_t i; } dbits;
static uint32_t hi(double x) { dbits u = {x}; return (uint32_t)(u.i >> 32); }
static uint32_t lo(double x) { dbits u = {x}; return (uint32_t)u.i; }
static const double
toint = 1.5 / 2.22044604925031308085e-16,
invpio2 = 6.36619772367581382433e-01,
pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11,
pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21,
pio2_3 = 2.02226624871116645580e-21, pio2_3t = 8.47842766036889956997e-32;
/* musl __rem_pio2 medium path (|x| < 2^20 * pi/2); larger arguments trap (never reached: |x| <= 3 pi here) */
static int rem_pio2(double x, double *y) {
    uint32_t ix = hi(x) & 0x7fffffff;
    if (ix >= 0x413921fb) __builtin_trap();
    double fn = (x * invpio2 + toint) - toint;
    int n = (int)fn;
    double r = x - fn * pio2_1, w = fn * pio2_1t;
    y[0] = r - w;
    uint32_t ey = (hi(y[0]) >> 20) & 0x7ff, ex = ix >> 20;
    if (ex - ey > 16) {
        double t = r; w = fn * pio2_2; r = t - w; w = fn * pio2_2t - ((t - r) - w); y[0] = r - w;
        ey = (hi(y[0]) >> 20) & 0x7ff;
        if (ex - ey > 49) { t = r; w = fn * pio2_3; r = t - w; w = fn * pio2_3t - ((t - r) - w); y[0] = r - w; }
    }
    y[1] = (r - y[0]) - w;
    return n;
}
double sin(double x) {
    uint32_t ix = hi(x) & 0x7fffffff;
    double y[2];
    if (ix <= 0x3fe921fb) {
        if (ix < 0x3e500000) return x;
        return k_sin(x, 0.0, 0);
    }
    if (ix >= 0x7ff00000) return x - x;
    int n = rem_pio2(x, y);
    switch (n & 3) {
    case 0: return k_sin(y[0], y[1], 1);
    case 1: return k_cos(y[0], y[1]);
    case 2: return -k_sin(y[0], y[1], 1);
    default: return -k_cos(y[0], y[1]);
    }
}
double cos(double x) {
    uint32_t ix = hi(x) & 0x7fffffff;
    double y[2];
    if (ix <= 0x3fe921fb) {
        if (ix < 0x3e46a09e) return 1.0;
        return k_cos(x, 0.0);
    }
    if (ix >= 0x7ff00000) return x - x;
    int n = rem_pio2(x, y);
    switch (n & 3) {
    case 0: return k_cos(y[0], y[1]);
    case 1: return -k_sin(y[0], y[1], 1);
    case 2: return -k_cos(y[0], y[1]);
    default: return k_sin(y[0], y[1], 1);
    }
}
