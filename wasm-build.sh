#!/bin/bash
set -e

# Ensure wasm-bindgen-cli is installed
cargo install wasm-bindgen-cli

# Build the WASM module
# Output: target/wasm32-unknown-unknown/release/mcp_browser_client.wasm
cargo build --target wasm32-unknown-unknown --release

# Generate JS bindings as a classic script for service worker compatibility
wasm-bindgen --target no-modules --out-dir public target/wasm32-unknown-unknown/release/mcp_browser_client.wasm

# Ensure WASM target is installed
rustup target add wasm32-unknown-unknown
