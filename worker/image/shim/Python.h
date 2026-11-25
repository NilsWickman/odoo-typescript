#pragma once
/* Pillow's libImaging only needs a few definitions from Python.h (no Python object is used by the files built here). */
#include <stddef.h>
#include <stdint.h>
#include <limits.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <stdio.h>
typedef long Py_ssize_t;
#define PY_SSIZE_T_MAX LONG_MAX
#define HAVE_PROTOTYPES 1
#define STDC_HEADERS 1
#define SIZEOF_SHORT 2
#define SIZEOF_INT 4
#define SIZEOF_LONG 4
#define WORDS_BIGENDIAN_UNDEFINED
typedef struct _object PyObject;
#define Py_UNUSED(x) x
