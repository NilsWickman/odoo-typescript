#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --locked --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/odoo_password_kdf.wasm ../src/session/password-kdf.wasm
cd ..
sha256sum crypto/Cargo.toml crypto/Cargo.lock crypto/rust-toolchain.toml crypto/src/lib.rs src/session/password-kdf.wasm > crypto/SHA256SUMS
