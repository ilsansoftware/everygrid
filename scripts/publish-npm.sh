#!/bin/bash
# Publish the staged tarball to the npm registry. Extra args pass through (e.g. --dry-run).
# npm versions are immutable: a version can be published once, ever — bump before re-publishing.
set -e

RESET="\033[0m"
BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
BLUE="\033[34m"

source "$(dirname "$0")/pack.sh"

echo -e "${BLUE}📤 Publishing to npm...${RESET}"
npm publish "$OUT_TMP/$INT_TGZ_NAME" --access public "$@"
echo -e "   ${GREEN}✓${RESET} @everygrid/grid@$VERSION"
