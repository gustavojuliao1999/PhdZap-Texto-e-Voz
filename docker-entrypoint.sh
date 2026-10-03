#!/bin/sh
set -e
# Aplica as migrações do banco antes de subir (idempotente).
echo "aplicando migrações do banco..."
node_modules/.bin/prisma migrate deploy
exec "$@"
