#!/bin/bash
# NanoClaw full clean rebuild
# Usage: bash rebuild.sh
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RESET='\033[0m'

step() { echo -e "\n${BOLD}==> $1${RESET}"; }

step "Stopping service"
systemctl stop nanoclaw 2>/dev/null || true

step "Killing running agent containers"
CONTAINERS=$(docker ps -q --filter name=nanoclaw 2>/dev/null)
if [ -n "$CONTAINERS" ]; then
  docker kill $CONTAINERS
  echo "Killed: $CONTAINERS"
else
  echo "No running containers"
fi

step "Removing old agent image"
docker rmi nanoclaw-agent:latest 2>/dev/null && echo "Image removed" || echo "No image to remove"

step "Pruning Docker builder cache"
docker builder prune -f

step "Cleaning npm build output"
rm -rf dist/

step "Installing npm dependencies"
npm install

step "Building TypeScript"
npm run build

step "Rebuilding agent container (clean)"
./container/build.sh

step "Starting service"
systemctl start nanoclaw
sleep 3
systemctl status nanoclaw --no-pager | head -8

echo -e "\n${GREEN}${BOLD}Rebuild complete.${RESET}"
echo "Monitor logs: tail -f logs/nanoclaw.log"
