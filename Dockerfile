# syntax=docker/dockerfile:1.7
# PhdZap. O baileys-caller vem do contexto extra "baileys-caller"
# (docker compose: build.additional_contexts → ./baileys-caller).

# ── whisper.cpp (transcrição local, TRANSCRIBE=local) ──
# Compilado para rodar em qualquer CPU x86/ARM: escolhe na hora a melhor variante (AVX2, AVX-512…).
FROM node:22-bookworm-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.9.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake g++ make ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
      -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF \
      -DCMAKE_BUILD_RPATH='$ORIGIN' \
 && cmake --build /build -j"$(nproc)" --target whisper-cli \
 && mkdir -p /opt/whisper \
 && cp -a /build/bin/whisper-cli /build/bin/*.so* /opt/whisper/

FROM node:22-bookworm-slim

# ffmpeg: decodifica áudio (play/arquivos) · openssl: Prisma · tini: sinais/zumbis
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=whisper /opt/whisper /opt/whisper
ENV WHISPER_CLI=/opt/whisper/whisper-cli

# ── baileys-caller (biblioteca de voz, já compilada em dist/) ──
WORKDIR /app/whatsapp-voice-gateway/baileys-caller
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
COPY docs ./docs
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
