#!/usr/bin/env bash
# Builds src/image/odoo-image.wasm from the exact C sources Odoo's Pillow runs with (README.md), with clang-18 and
# wasm-ld-18. Sources are fetched into src-dl/ (gitignored) and checked against SHA256SUMS.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p src-dl obj
fetch() { [ -f "src-dl/$2" ] || curl -sSfL -o "src-dl/$2" "$1"; }
fetch https://zlib.net/fossils/zlib-1.3.tar.gz zlib-1.3.tar.gz
fetch https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.0.1/libjpeg-turbo-3.0.1.tar.gz libjpeg-turbo-3.0.1.tar.gz
fetch https://files.pythonhosted.org/packages/source/p/pillow/pillow-10.2.0.tar.gz pillow-10.2.0.tar.gz
(cd src-dl && sha256sum -c ../SHA256SUMS)
for t in zlib-1.3 libjpeg-turbo-3.0.1 pillow-10.2.0; do [ -d "src-dl/$t" ] || tar -C src-dl -xzf "src-dl/$t.tar.gz"; done
Z=src-dl/zlib-1.3; J=src-dl/libjpeg-turbo-3.0.1; P=src-dl/pillow-10.2.0/src/libImaging
CC=(clang-18 --target=wasm32 -O2 -nostdlib -ffreestanding -fno-builtin -isystem shim -Iconfig -w -DNO_GETENV -DNO_PUTENV)
rm -f obj/*.o
for f in adler32 crc32 deflate inflate inftrees inffast trees zutil; do "${CC[@]}" -I$Z -c $Z/$f.c -o obj/z_$f.o; done
J16="jcapistd jccolor jcdiffct jclossls jcmainct jcprepct jcsample jdapistd jdcolor jddiffct jdlossls jdmainct jdpostct jdsample jutils"
J12="$J16 jccoefct jcdctmgr jdcoefct jddctmgr jdmerge jfdctfst jfdctint jidctflt jidctfst jidctint jidctred jquant1 jquant2"
J8="$J12 jcapimin jchuff jcicc jcinit jclhuff jcmarker jcmaster jcomapi jcparam jcphuff jctrans jdapimin jdatadst jdatasrc jdhuff jdicc jdinput jdlhuff jdmarker jdmaster jdphuff jdtrans jerror jfdctflt jmemmgr jmemnobs jaricom jcarith jdarith"
for f in $J8; do "${CC[@]}" -I$J -c $J/$f.c -o obj/j8_$f.o; done
for f in $J12; do "${CC[@]}" -DBITS_IN_JSAMPLE=12 -I$J -c $J/$f.c -o obj/j12_$f.o; done
for f in $J16; do "${CC[@]}" -DBITS_IN_JSAMPLE=16 -I$J -c $J/$f.c -o obj/j16_$f.o; done
PC=("${CC[@]}" -I$J -I$Z -I$P -DHAVE_LIBJPEG -DHAVE_LIBZ)
for f in Storage Resample Reduce Convert ConvertYCbCr Unpack UnpackYCC Pack JpegDecode JpegEncode ZipEncode ZipDecode Palette Access Copy Crop Fill Paste; do "${PC[@]}" -c $P/$f.c -o obj/p_$f.o; done
"${PC[@]}" -c except.c -o obj/except.o
"${PC[@]}" -c glue.c -o obj/glue.o
"${CC[@]}" -c shim.c -o obj/shim.o
mkdir -p ../src/image
wasm-ld-18 --no-entry --export-dynamic --strip-all --gc-sections -z stack-size=1048576 --initial-memory=2097152 --max-memory=268435456 \
  obj/*.o -o ../src/image/odoo-image.wasm
ls -l ../src/image/odoo-image.wasm
sha256sum ../src/image/odoo-image.wasm glue.c shim.c except.c build.sh config/*.h shim/*.h shim/sys/*.h > SHA256SUMS.build
