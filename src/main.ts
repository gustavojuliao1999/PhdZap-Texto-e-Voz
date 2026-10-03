/**
 * Gateway de voz do WhatsApp — processo principal.
 * Painel, API e iframes; cada telefone roda num processo próprio (src/worker).
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { Sessions } from "./auth/sessions.js";
import { prisma } from "./db.js";
import { startServer } from "./http/server.js";
import { LineManager } from "./line-manager.js";
import { log } from "./log.js";
import { Store } from "./store.js";

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

if (!process.env.DATABASE_URL) {
  log.error("DATABASE_URL não definido. Veja o .env.example (ou use docker compose).");
  process.exit(1);
}

try {
  await prisma.$connect();
} catch (err: any) {
  log.error(`não foi possível conectar ao banco: ${err?.message ?? err}`);
  log.error("o PostgreSQL está rodando? (docker compose up -d db) e as migrações aplicadas? (npm run db:migrate)");
  process.exit(1);
}

const store = new Store(path.resolve(env("DATA_DIR", "./data")), prisma);
const { key: adminKey, generated } = store.adminKey(env("ADMIN_API_KEY") || undefined);
if (generated) {
  log.info("════════════════════════════════════════════════════════════");
  log.info(`Chave do super admin (guarde-a): ${adminKey}`);
  log.info(`Ela fica salva em ${path.join(store.dataDir, "admin.json")}. Defina ADMIN_API_KEY no .env para usar a sua.`);
  log.info("════════════════════════════════════════════════════════════");
}

// Migrações das versões anteriores (arquivos JSON e pasta ./auth de linha única).
await store.importLegacyFiles();
const legacyAuth = path.resolve("./auth");
if ((await store.listLines()).length === 0 && existsSync(path.join(legacyAuth, "creds.json"))) {
  const line = store.newLine("Principal");
  const target = store.authDirFor(line.id);
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(legacyAuth, target);
  await store.insertLine(line);
  log.info(`sessão existente em ./auth migrada para o telefone "Principal" (${line.id})`);
}

const lines = new LineManager(store);
const sessions = new Sessions(prisma);
const server = startServer({
  lines, store, db: prisma, sessions,
  port: Number(env("PORT", "3000")),
  host: env("HOST", "127.0.0.1"),
  adminKey,
  secureCookies: env("SECURE_COOKIES") === "true",
});
await lines.startAll();
log.info(`${lines.lines.length} telefone(s) carregado(s)`);

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("encerrando...");
  server.close();
  await lines.stopAll();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
