#!/bin/bash

# Exit on error
set -e

echo "Setting up MCP Browser Client development environment..."

# Check for required tools
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required but not installed. Aborting."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required but not installed. Aborting."; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "Rust/Cargo is required but not installed. Aborting."; exit 1; }

# Setup Node.js dependencies first (needed for concurrently)
echo "Setting up Node.js dependencies..."
npm install

# Setup Python virtual environment
echo "Setting up Python virtual environment..."
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Setup Rust/WASM
echo "Setting up Rust/WASM..."
cargo install wasm-pack
./wasm-build.sh

echo "Setup complete! You can now run the development environment with:"
echo "npm run dev" 