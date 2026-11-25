# Third-party code compiled into `src/image/odoo-image.wasm`

- **Pillow 10.2.0** (`src/libImaging/*.c` subset). License: MIT-CMU (HPND).
  Copyright © 1997-2011 by Secret Labs AB; © 1995-2011 by Fredrik Lundh and contributors; © 2010-2023 by
  Jeffrey A. Clark (Alex) and contributors. Full text: `LICENSE` in the Pillow sdist.
- **libjpeg-turbo 3.0.1**. Licenses: IJG License (libjpeg API library), Modified (3-clause) BSD License
  (TurboJPEG parts), zlib License (SIMD extensions, not compiled here). This software is based in part on the work
  of the Independent JPEG Group. Full text: `LICENSE.md`, `README.ijg` in the release tarball.
- **zlib 1.3**. License: zlib License. Copyright © 1995-2023 Jean-loup Gailly and Mark Adler. Full text:
  `LICENSE` in the tarball.
- **FreeBSD msun** (`k_sin`, `k_cos`, `__rem_pio2` medium path, as in musl), in `shim.c`.
  Copyright © 1993 by Sun Microsystems, Inc.: "Permission to use, copy, modify, and distribute this software is
  freely granted, provided that this notice is preserved."
