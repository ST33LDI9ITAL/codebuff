#!/usr/bin/env bash
# update-codebuff — rebase fork on upstream main, rebuild binary
set -euo pipefail

cd "$(dirname "$0")"

echo "=== Fetching upstream ==="
git fetch upstream

echo "=== Stashing local changes ==="
git stash push -m "update-codebuff-auto-stash" || true

echo "=== Rebasing on upstream/main ==="
git rebase upstream/main

echo "=== Restoring stashed changes ==="
git stash pop || true

echo "=== Installing deps ==="
bun install 2>&1 | tail -1

echo "=== Building standalone binary ==="
cd cli && bun run build:binary 2>&1 | tail -1

echo "=== Installing to ~/.local/bin ==="
cp bin/codebuff ~/.local/bin/codebuff-local
cd ..

echo "=== Pushing to origin ==="
git push origin deepseek-custom

echo "=== Done ==="
echo "Run: DEEPSEEK_API_KEY=*** codebuff-local"