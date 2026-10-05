#!/usr/bin/env bash
# Atualiza o container do gateway: compila o baileys-caller (./baileys-caller) se preciso,
# reconstrói a imagem e recria o app. Se nada mudou, o Docker reaproveita o cache e o container não reinicia.
# Se o app novo não ficar saudável, volta para a imagem anterior.
#
#   ./scripts/deploy.sh
#   BAILEYS_CALLER=/outro/caminho ./scripts/deploy.sh
#
# Disparado sozinho pelos git hooks (scripts/hooks/baileys-caller).
# Log em logs/deploy.log; falhas também vão para ALERT_WEBHOOK_URL (Slack, Discord…).
set -euo pipefail
cd "$(dirname "$0")/.."

HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"
mkdir -p logs
set -a; [ -f .env ] && . ./.env; set +a
BAILEYS_DIR="${BAILEYS_CALLER:-./baileys-caller}"

# Um deploy por vez; os seguintes esperam na fila.
exec 9>logs/deploy.lock
flock 9

say() { echo "[$(date -Is)] $*"; }
alert() {
  say "ERRO: $*"
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  local text="Deploy do gateway: $*"
  curl -fsS -m 10 -H 'content-type: application/json' \
    -d "$(printf '{"text":"%s","content":"%s","level":"warn","key":"deploy"}' "$text" "$text")" \
    "$ALERT_WEBHOOK_URL" >/dev/null || say "falha ao enviar alerta"
}

say "deploy ($(git rev-parse --short HEAD))"

# O dist/ do baileys-caller é o que vai para a imagem: compila se o src/ for mais novo.
# (Compilar sem necessidade regrava o dist/ e geraria uma imagem nova, reiniciando o app à toa.)
stale="$(find "$BAILEYS_DIR/src" "$BAILEYS_DIR"/tsconfig*.json -newer "$BAILEYS_DIR/dist/index.mjs" -print -quit 2>/dev/null || echo sem-dist)"
if [ -z "$stale" ]; then
  say "dist/ do baileys-caller em dia"
elif [ -x "$BAILEYS_DIR/node_modules/.bin/tsc" ]; then
  say "compilando o baileys-caller"
  if ! (cd "$BAILEYS_DIR" && npm run --silent build); then
    alert "a compilação do baileys-caller falhou; o container atual continua no ar."
    exit 1
  fi
else
  say "baileys-caller sem node_modules: usando o dist/ como está"
fi

PROJECT="$(docker compose config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -1)"
IMAGE="${PROJECT:-whatsapp-voice-gateway}-app"
imageId() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }
# Guarda a imagem atual para voltar se a nova não subir.
PREVIOUS="$(imageId "$IMAGE")"
BEFORE="$(docker compose ps -q app)"
[ -n "$PREVIOUS" ] && docker tag "$IMAGE" "$IMAGE:anterior"

if ! docker compose build app; then
  alert "o build da imagem falhou; o container atual continua no ar."
  exit 1
fi
docker compose up -d --no-build --no-deps app
# O Compose só recria o container se a imagem mudou de verdade.
if [ -n "$BEFORE" ] && [ "$(docker compose ps -q app)" = "$BEFORE" ]; then
  say "nada mudou; container mantido"
  exit 0
fi
say "aguardando o app ficar saudável (até ${HEALTH_TIMEOUT}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT))
status=""
while [ $SECONDS -lt $deadline ]; do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || echo starting)"
  [ "$status" = healthy ] && break
  sleep 5
done

if [ "$status" = healthy ]; then
  say "ok: app saudável com a imagem nova"
  docker image prune -f >/dev/null || true
  exit 0
fi

if [ -n "$PREVIOUS" ]; then
  docker tag "$IMAGE:anterior" "$IMAGE"
  docker compose up -d --no-build --no-deps app
  alert "o app novo não ficou saudável ($status); voltei para a imagem anterior."
else
  alert "o app novo não ficou saudável ($status) e não havia imagem anterior."
fi
exit 1
