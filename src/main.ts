/**
 * Gateway de voz do WhatsApp — processo principal.
 * Painel admin, API e iframes; cada telefone roda num processo próprio (src/worker).
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { startServer } from "./http/server.js";
import { LineManager } from "./line-manager.js";
import { log } from "./log.js";
import { Store } from "./store.js";

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

const store = new Store(path.resolve(env("DATA_DIR", "./data")));
const { key: adminKey, generated } = store.adminKey(env("ADMIN_API_KEY") || undefined);
if (generated) {
  log.info("════════════════════════════════════════════════════════════");
  log.info(`Chave de acesso do painel (guarde-a): ${adminKey}`);
  log.info(`Ela fica salva em ${path.join(store.dataDir, "admin.json")}`);
  log.info("════════════════════════════════════════════════════════════");
}

const lines = new LineManager(store);

// Migração da versão de linha única: reaproveita ./auth como a primeira linha.
const legacyAuth = path.resolve("./auth");
if (!store.loadLines().length && existsSync(path.join(legacyAuth, "creds.json"))) {
  const line = store.newLine("Principal");
  const target = store.authDirFor(line.id);
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(legacyAuth, target);
  store.saveLines([line]);
  log.info(`sessão existente em ./auth migrada para a linha "Principal" (${line.id})`);
}
const server = startServer(lines, {
  port: Number(env("PORT", "3000")),
  host: env("HOST", "127.0.0.1"),
  adminKey,
  secureCookies: env("SECURE_COOKIES") === "true",
});
lines.startAll();
log.info(`${lines.lines.length} linha(s) carregada(s)`);

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("encerrando...");
  server.close();
  await lines.stopAll();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
