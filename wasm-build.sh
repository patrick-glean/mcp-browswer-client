#!/bin/bash
set -e
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/mcp_browser_client.wasm public/mcp_client_bg.wasm
