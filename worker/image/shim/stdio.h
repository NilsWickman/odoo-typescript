#pragma once
#include <stddef.h>
#include <stdarg.h>
typedef struct _shim_FILE FILE;
extern FILE *stderr;
extern FILE *stdout;
#define EOF (-1)
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
int fprintf(FILE *f, const char *fmt, ...);
int printf(const char *fmt, ...);
int sprintf(char *s, const char *fmt, ...);
int snprintf(char *s, size_t n, const char *fmt, ...);
int vsnprintf(char *s, size_t n, const char *fmt, va_list ap);
size_t fread(void *p, size_t s, size_t n, FILE *f);
size_t fwrite(const void *p, size_t s, size_t n, FILE *f);
int fflush(FILE *f);
int ferror(FILE *f);
int putc(int c, FILE *f);
int getc(FILE *f);
FILE *fopen(const char *a, const char *b);
int fclose(FILE *f);
int fseek(FILE *f, long o, int w);
long ftell(FILE *f);
FILE *tmpfile(void);
