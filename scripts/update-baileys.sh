#!/usr/bin/env bash
# Clona ou atualiza o baileys-caller em ./baileys-caller (usado pelo build do Docker).
#   scripts/update-baileys.sh            # clona na primeira vez, depois puxa o último commit
#   BAILEYS_REPO=... BAILEYS_BRANCH=...  # para usar outro repositório ou branch
set -euo pipefail

REPO="${BAILEYS_REPO:-https://github.com/gustavojuliao1999/baileys-caller.git}"
BRANCH="${BAILEYS_BRANCH:-feat/expor-socket}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/baileys-caller"

if [ -d "$DIR/.git" ]; then
  # Só avança (fast-forward): nunca descarta commits ou alterações locais.
  git -C "$DIR" pull --ff-only "$REPO" "$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
echo "baileys-caller em $(git -C "$DIR" log -1 --format='%h %s')"
