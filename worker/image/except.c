/* libImaging's error and threading hooks (Except.c and _imaging.c talk to Python): errors become NULL/0 results. */
#include "Imaging.h"
void *ImagingError_OSError(void) { return NULL; }
void *ImagingError_MemoryError(void) { return NULL; }
void *ImagingError_ModeError(void) { return NULL; }
void *ImagingError_Mismatch(void) { return NULL; }
void *ImagingError_ValueError(const char *message) { (void)message; return NULL; }
void ImagingError_Clear(void) {}
void ImagingSectionEnter(ImagingSectionCookie *cookie) { (void)cookie; }
void ImagingSectionLeave(ImagingSectionCookie *cookie) { (void)cookie; }
