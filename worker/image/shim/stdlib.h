#pragma once
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t m);
void *realloc(void *p, size_t n);
void free(void *p);
void abort(void) __attribute__((noreturn));
void exit(int) __attribute__((noreturn));
int abs(int x);
long labs(long x);
char *getenv(const char *name);
int atoi(const char *s);
long strtol(const char *s, char **end, int base);
void qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *));
#define EXIT_FAILURE 1
#define EXIT_SUCCESS 0
int setenv(const char *n, const char *v, int o);
