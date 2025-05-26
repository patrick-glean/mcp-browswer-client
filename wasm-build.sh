#!/bin/bash
set -e

# Build the WASM module
# Output: target/wasm32-unknown-unknown/release/mcp_browser_client.wasm
cargo build --target wasm32-unknown-unknown --release

# Copy the WASM module to the public directory
# Note: The service worker expects this exact filename
cp target/wasm32-unknown-unknown/release/mcp_browser_client.wasm public/mcp_client_bg.wasm

# Ensure WASM target is installed
rustup target add wasm32-unknown-unknown
