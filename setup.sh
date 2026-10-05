#!/bin/bash

# Exit on error
set -e

echo "Setting up MCP Browser Client development environment..."

# Check for required tools
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required but not installed. Aborting."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required but not installed. Aborting."; exit 1; }

# wasm-build.sh needs rustup to install the wasm32 target
if ! command -v rustup &> /dev/null; then
    echo "rustup not found. Installing Rust using rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # Add Rust to the current shell
    source "$HOME/.cargo/env"
fi

# Setup Node.js dependencies
echo "Setting up Node.js dependencies..."
npm install

# Only the official-SDK reference server needs this; the mock server uses the standard library.
echo "Setting up the Python virtual environment for the reference MCP server..."
python3 -m venv venv
venv/bin/pip install -r requirements.txt

echo "Building the TypeScript SDK MCP client library (the default)..."
npm run build:sdk

echo "Building the Rust/WASM MCP client library..."
./wasm-build.sh

echo "Setup complete! To try it:"
echo ""
echo "  npm start                 # the app on http://localhost:8080"
echo "  npm run start:mock-mcp    # in a second terminal: a mock MCP server on http://127.0.0.1:8081"
echo ""
echo "Then open http://localhost:8080. The Guide (top right) walks through connecting and calling a tool,"
echo "and Runtime (top bar) switches the MCP client library."
echo "Tests: npm run test:browser && npm run test:browser:wasm && npm run test:rust (README.md has the full testing guide)"
echo "Tool-call load test of every MCP client library: npm run bench"
