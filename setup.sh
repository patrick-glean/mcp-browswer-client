#!/bin/bash

# Exit on error
set -e

echo "Setting up MCP Browser Client development environment..."

# Check for required tools
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required but not installed. Aborting."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required but not installed. Aborting."; exit 1; }

# Check and install Rust if not present
if ! command -v rustc &> /dev/null; then
    echo "Rust not found. Installing Rust using rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # Add Rust to the current shell
    source "$HOME/.cargo/env"
fi

# Setup Node.js dependencies
echo "Setting up Node.js dependencies..."
npm install

# Setup Python virtual environment (for mock MCP server)
echo "Setting up Python virtual environment for mock MCP server..."
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Setup Rust/WASM
echo "Setting up Rust/WASM..."
echo "Adding wasm32-unknown-unknown target..."
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
./wasm-build.sh

echo "Setup complete!"
echo ""
echo "To start the web server:"
echo "npm start"
echo ""
echo "To start the mock MCP server (optional):"
echo "npm run start:mock-mcp"
echo ""
echo "Note: You can use your own MCP server implementation by ensuring it runs on port 8081"
echo "      or by modifying the connection settings in src/lib.rs" 