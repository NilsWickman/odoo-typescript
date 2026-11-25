#pragma once
/* No non-local exits in this build: setjmp returns 0, longjmp traps (the libraries only longjmp on errors). */
typedef int jmp_buf[1];
#define setjmp(b) (0)
void longjmp(jmp_buf b, int v) __attribute__((noreturn));
