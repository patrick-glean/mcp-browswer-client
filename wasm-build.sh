#!/bin/bash
set -euo pipefail

# wasm-bindgen-cli must match the wasm-bindgen crate version or the generated
# bindings will fail to load at runtime.
WASM_BINDGEN_VERSION="0.2.100"
TARGET="wasm32-unknown-unknown"

# Prefer the rustup-managed toolchain. On machines where mise or Homebrew put a
# different rustc first on PATH, that rustc often lacks the wasm32 std and the
# build fails with "can't find crate for `core`". `rustup which` resolves the
# real toolchain binaries regardless of PATH shadowing.
if command -v rustup >/dev/null 2>&1; then
    RUSTC_BIN="$(rustup which rustc)"
    CARGO_BIN="$(rustup which cargo)"
else
    RUSTC_BIN="$(command -v rustc)"
    CARGO_BIN="$(command -v cargo)"
fi

./generate-build-info.sh

if command -v rustup >/dev/null 2>&1; then
    rustup target add "$TARGET"
fi

# Only (re)install the CLI when it is missing or the version drifts from the
# crate; `cargo install` otherwise re-downloads and recompiles on every build.
if ! command -v wasm-bindgen >/dev/null 2>&1 || \
   [ "$(wasm-bindgen --version | awk '{print $2}')" != "$WASM_BINDGEN_VERSION" ]; then
    "$CARGO_BIN" install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"
fi

RUSTC="$RUSTC_BIN" "$CARGO_BIN" build --target "$TARGET" --release

# Respect CARGO_TARGET_DIR when set (e.g. sandboxed/CI builds redirect it).
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
WASM_ARTIFACT="$TARGET_DIR/$TARGET/release/mcp_browser_client.wasm"

wasm-bindgen --target no-modules --out-dir public "$WASM_ARTIFACT"

echo "Build complete: public/mcp_browser_client_bg.wasm"
