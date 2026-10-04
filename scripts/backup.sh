#!/usr/bin/env bash
# Backup do gateway em Docker: banco (pg_dump) + volume appdata (sessões do WhatsApp,
# mídia em cache e gravações). Guarda em ./backups e apaga os mais antigos que KEEP_DAYS.
#
#   ./scripts/backup.sh                 # backup agora
#   KEEP_DAYS=30 ./scripts/backup.sh
#   crontab: 0 3 * * * cd /caminho/whatsapp-voice-gateway && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_DAYS="${KEEP_DAYS:-14}"
DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DIR"
set -a; [ -f .env ] && . ./.env; set +a
DB_USER="${POSTGRES_USER:-gateway}"
DB_NAME="${POSTGRES_DB:-gateway}"
PROJECT="$(docker compose config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -1)"
VOLUME="${PROJECT:-whatsapp-voice-gateway}_appdata"
# Imagem com tar para ler o volume (a do banco já está baixada).
HELPER_IMAGE="${HELPER_IMAGE:-postgres:16-alpine}"

echo "[$(date -Is)] banco → $DIR/db-$STAMP.sql.gz"
docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip > "$DIR/db-$STAMP.sql.gz"

echo "[$(date -Is)] volume $VOLUME → $DIR/appdata-$STAMP.tar.gz"
docker run --rm -v "$VOLUME":/data:ro -v "$(realpath "$DIR")":/backup "$HELPER_IMAGE" \
  tar czf "/backup/appdata-$STAMP.tar.gz" -C /data .

find "$DIR" -name 'db-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$DIR" -name 'appdata-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "[$(date -Is)] ok ($(du -sh "$DIR" | cut -f1) em $DIR)"
