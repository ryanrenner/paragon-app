#!/usr/bin/env bash
#
# start.sh - Start the Paragon MLS Lookup server.
#
# Usage:
#   ./start.sh              Normal mode (headless, fast)
#   ./start.sh --watch      Watch the scraper drive a visible Chromium window
#
# Stop the server with Ctrl+C.

set -e

BOLD=$(tput bold 2>/dev/null || echo "")
GREEN=$(tput setaf 2 2>/dev/null || echo "")
YELLOW=$(tput setaf 3 2>/dev/null || echo "")
RED=$(tput setaf 1 2>/dev/null || echo "")
RESET=$(tput sgr0 2>/dev/null || echo "")

cd "$(dirname "$0")"

# Sanity check: make sure setup has been run.
if [ ! -d node_modules ]; then
  echo "${BOLD}${RED}xx node_modules is missing.${RESET}"
  echo "   Run ./setup.sh first."
  exit 1
fi

if [ ! -f .env ]; then
  echo "${BOLD}${RED}xx .env is missing.${RESET}"
  echo "   Run ./setup.sh first, then fill in your credentials."
  exit 1
fi

# Warn if .env still has the example placeholders
if grep -q "your-paragon-username" .env 2>/dev/null; then
  echo "${BOLD}${YELLOW}!! .env looks like it still has example placeholders.${RESET}"
  echo "   Open it and fill in your real credentials:"
  echo "     open -e .env"
  echo ""
fi

if [ "$1" = "--watch" ] || [ "$1" = "-w" ]; then
  echo "${BOLD}${GREEN}==>${RESET} Starting in ${BOLD}watch${RESET} mode (Chromium window will be visible)"
  export PLAYWRIGHT_HEADFUL=1
else
  echo "${BOLD}${GREEN}==>${RESET} Starting server"
fi

echo ""
echo "   Open http://localhost:3000 in your browser."
echo "   Press Ctrl+C here to stop the server."
echo ""

npm start
