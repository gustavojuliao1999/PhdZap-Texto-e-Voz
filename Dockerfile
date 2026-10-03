# syntax=docker/dockerfile:1.7
# WhatsApp Voice Gateway. O baileys-caller vem do contexto extra "baileys-caller"
# (docker compose: build.additional_contexts → ../baileys-caller).

FROM node:22-bookworm-slim

# ffmpeg: decodifica áudio (play/arquivos) · openssl: Prisma · tini: sinais/zumbis
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# ── baileys-caller (biblioteca de voz, já compilada em dist/) ──
WORKDIR /app/baileys-caller
COPY --from=baileys-caller package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=baileys-caller dist ./dist
COPY --from=baileys-caller assets/wasm ./assets/wasm

# ── gateway ──
WORKDIR /app/whatsapp-voice-gateway
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY examples ./examples
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
