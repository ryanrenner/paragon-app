#!/usr/bin/env bash
#
# setup.sh - One-time setup for Paragon MLS Lookup on macOS.
#
# Run this once after cloning or copying the project folder:
#
#   ./setup.sh
#
# It installs dependencies, downloads the Chromium build Playwright needs,
# and creates a .env file from .env.example if you don't have one.

set -e

# Colors for readable output
BOLD=$(tput bold 2>/dev/null || echo "")
DIM=$(tput dim 2>/dev/null || echo "")
GREEN=$(tput setaf 2 2>/dev/null || echo "")
YELLOW=$(tput setaf 3 2>/dev/null || echo "")
RED=$(tput setaf 1 2>/dev/null || echo "")
RESET=$(tput sgr0 2>/dev/null || echo "")

say() { echo "${BOLD}${GREEN}==>${RESET} ${BOLD}$1${RESET}"; }
warn() { echo "${BOLD}${YELLOW}!! $1${RESET}"; }
die() { echo "${BOLD}${RED}xx $1${RESET}"; exit 1; }

# Move into the directory this script lives in, so it works no matter
# where you run it from.
cd "$(dirname "$0")"

say "Paragon MLS Lookup setup"
echo ""

# 1. Check for Node.js
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed.

  Install it first:
    1. Go to https://nodejs.org
    2. Download the LTS version (big green button on the left)
    3. Run the installer
    4. Come back and run ./setup.sh again"
fi

NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Found Node $NODE_VERSION. This app needs Node 20 or newer."
  warn "Install the latest LTS from https://nodejs.org and try again."
  exit 1
fi

say "Node $NODE_VERSION detected"
echo ""

# 2. Install npm packages
say "Installing npm packages (this takes 30 seconds or so)"
npm install
echo ""

# 3. Install Playwright's Chromium browser
say "Installing Chromium for Playwright (this takes a minute or two)"
npx playwright install chromium
echo ""

# 4. Create .env from .env.example if missing
if [ -f .env ]; then
  say ".env already exists, leaving it alone"
else
  if [ -f .env.example ]; then
    cp .env.example .env
    say "Created .env from .env.example"
    warn "You need to open .env and fill in your credentials before running the app."
  else
    warn ".env.example not found, skipping. You will need to create .env manually."
  fi
fi
echo ""

# 5. Create data directory (SQLite lives here)
mkdir -p data
say "data/ directory ready for the SQLite file"
echo ""

# Done
say "Setup complete."
echo ""
echo "${BOLD}Next steps:${RESET}"
echo ""
echo "  1. Open .env and fill in your credentials:"
echo "     ${DIM}open -e .env${RESET}"
echo ""
echo "     You need:"
echo "       PARAGON_USERNAME and PARAGON_PASSWORD (your MLS login)"
echo "       ANTHROPIC_API_KEY (from console.anthropic.com, or leave blank)"
echo "       APP_USERNAME and APP_PASSWORD (for logging into this app)"
echo ""
echo "  2. Start the server:"
echo "     ${DIM}./start.sh${RESET}    (or ${DIM}npm start${RESET})"
echo ""
echo "  3. Open http://localhost:3000 in your browser."
echo ""
