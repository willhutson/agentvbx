#!/usr/bin/env bash
# AGENTVBX Development Setup Script
# Run this after cloning the repo to get everything configured.

set -euo pipefail

echo "=== AGENTVBX Setup ==="
echo ""

# Check Node.js version
NODE_VERSION=$(node --version 2>/dev/null || echo "none")
if [[ "$NODE_VERSION" == "none" ]]; then
  echo "ERROR: Node.js is not installed. Install Node.js >= 20.0.0"
  exit 1
fi
echo "Node.js: $NODE_VERSION"

# Check npm
NPM_VERSION=$(npm --version 2>/dev/null || echo "none")
echo "npm: $NPM_VERSION"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Create required directories
echo ""
echo "Creating directory structure..."
mkdir -p tenants
mkdir -p logs
mkdir -p data

# Copy .env if it doesn't exist
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it with your API keys."
else
  echo ".env already exists, skipping."
fi

# Check for Redis
if command -v redis-server &> /dev/null; then
  echo "Redis: $(redis-server --version | head -1)"
else
  echo "WARNING: Redis not found. Install Redis for the message queue."
fi

# Check for Ollama
if command -v ollama &> /dev/null; then
  echo "Ollama: $(ollama --version 2>/dev/null || echo 'installed')"
else
  echo "WARNING: Ollama not found. Install Ollama for local model inference."
fi

# Build packages
echo ""
echo "Building packages..."
npm run build || echo "Build had errors — check TypeScript configs."

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your API keys (Telnyx, Deepgram, etc.)"
echo "  2. Start Redis: redis-server"
echo "  3. Start Ollama: ollama serve"
echo "  4. Pull Ollama models: ollama pull qwen2.5:7b"
echo "  5. Run the orchestrator: npm run dev"
echo ""
