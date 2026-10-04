#!/usr/bin/env bash
# Restaura um backup feito pelo scripts/backup.sh.
#
#   ./scripts/restore.sh 20261004-030000
#
# ATENÇÃO: substitui o banco e as sessões do WhatsApp atuais.
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP="${1:?informe o carimbo do backup, ex.: 20261004-030000 (veja ./backups)}"
DIR="${BACKUP_DIR:-./backups}"
DB_FILE="$DIR/db-$STAMP.sql.gz"
DATA_FILE="$DIR/appdata-$STAMP.tar.gz"
[ -f "$DB_FILE" ] && [ -f "$DATA_FILE" ] || { echo "backup $STAMP não encontrado em $DIR"; exit 1; }
set -a; [ -f .env ] && . ./.env; set +a
DB_USER="${POSTGRES_USER:-gateway}"
DB_NAME="${POSTGRES_DB:-gateway}"
PROJECT="$(docker compose config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -1)"
VOLUME="${PROJECT:-whatsapp-voice-gateway}_appdata"
# Imagem com tar para ler o volume (a do banco já está baixada).
HELPER_IMAGE="${HELPER_IMAGE:-postgres:16-alpine}"

read -r -p "Substituir o banco e as sessões atuais pelo backup $STAMP? [s/N] " ok
[ "$ok" = "s" ] || [ "$ok" = "S" ] || exit 1

docker compose stop app
gunzip -c "$DB_FILE" | docker compose exec -T db psql -q -U "$DB_USER" -d "$DB_NAME"
docker run --rm -v "$VOLUME":/data -v "$(realpath "$DIR")":/backup "$HELPER_IMAGE" \
  sh -c "find /data -mindepth 1 -delete && tar xzf /backup/appdata-$STAMP.tar.gz -C /data"
docker compose start app
echo "restaurado: $STAMP"
