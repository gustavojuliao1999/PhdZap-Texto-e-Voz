/**
 * Integração: sobe o gateway de verdade (com worker falso) contra um banco de teste.
 * Rode com TEST_DATABASE_URL=postgresql://… npm test. Cada execução usa um schema
 * novo, apagado no fim; nada toca no banco "de verdade".
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const BASE_URL = process.env.TEST_DATABASE_URL;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 3900 + Math.floor(Math.random() * 90);
const CONTROL = PORT + 1000;
const KEY = "chave-de-teste";
const GW = `http://127.0.0.1:${PORT}`;

describe("gateway (integração)", { skip: !BASE_URL && "defina TEST_DATABASE_URL para rodar" }, () => {
  const schema = `teste_${Date.now()}`;
  const dbUrl = `${BASE_URL!.replace(/[?&]schema=[^&]*/, "")}${BASE_URL!.includes("?") ? "&" : "?"}schema=${schema}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "wvg-"));
  let app: ChildProcess;
  let token = "";
  let lineId = "";

  const admin = (method: string, p: string, body?: unknown) =>
    fetch(`${GW}/admin/api${p}`, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const line = (method: string, p: string, body?: unknown) =>
    fetch(`${GW}/api/v1${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const emit = (event: unknown) => fetch(`http://127.0.0.1:${CONTROL}/emit`, { method: "POST", body: JSON.stringify(event) });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn().catch(() => undefined);
      if (v) return v as T;
      if (Date.now() > end) throw new Error("tempo esgotado esperando condição");
      await sleep(150);
    }
  };

  before(async () => {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "ignore" });
    app = spawn("npx", ["tsx", "src/main.ts"], {
      cwd: ROOT,
      env: {
        ...process.env, DATABASE_URL: dbUrl, ADMIN_API_KEY: KEY, PORT: String(PORT), HOST: "127.0.0.1",
        DATA_DIR: dataDir, LINE_WORKER_ENTRY: path.join(ROOT, "test/fixtures/fake-worker.ts"), FAKE_CONTROL_PORT: String(CONTROL),
      },
      stdio: "ignore",
    });
    await until(() => fetch(`${GW}/health`).then((r) => r.ok), 30_000);
    const l = await (await admin("POST", "/lines", { name: "Teste" })).json();
    token = l.token;
    lineId = l.id;
    await until(() => line("GET", "/line").then((r) => r.json()).then((x) => x.status === "open"));
  });

  after(async () => {
    app?.kill("SIGTERM");
    await sleep(500);
    const db = new PrismaClient({ datasourceUrl: dbUrl });
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await db.$disconnect();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("recusa sem token e com token errado", async () => {
    assert.equal((await fetch(`${GW}/api/v1/line`)).status, 401);
    assert.equal((await fetch(`${GW}/api/v1/line`, { headers: { authorization: "Bearer x" } })).status, 401);
  });

  it("envia mensagem e aparece no histórico e na conversa", async () => {
    const r = await line("POST", "/messages", { to: "5581999990000", text: "Olá" });
    assert.equal(r.status, 201);
    const m = await r.json();
    assert.equal(m.agent, "API");
    const list = await (await line("GET", "/messages?contact=5581999990000")).json();
    assert.equal(list[0].text, "Olá");
    const chats = await (await line("GET", "/chats")).json();
    assert.equal(chats[0].remote, "5581999990000");
  });

  it("mensagem recebida: grava, deduplica e conta como não lida", async () => {
    const msg = { id: "IN1", direction: "incoming", remote: "5581888880000", remoteJid: "5581888880000@s.whatsapp.net", pushName: "Bia", type: "text", text: "Oi", status: "delivered", timestamp: new Date().toISOString() };
    await emit({ type: "message", message: msg, raw: "{}" });
    await emit({ type: "message", message: msg, raw: "{}" });
    const chat = await until(async () => (await (await line("GET", "/chats")).json()).find((c: any) => c.remote === "5581888880000"));
    assert.equal(chat.unread, 1);
    assert.equal(chat.name, "Bia");
    await line("POST", "/chats/5581888880000/read");
    const after = (await (await line("GET", "/chats")).json()).find((c: any) => c.remote === "5581888880000");
    assert.equal(after.unread, 0);
  });

  it("atendimento: situação, notas e reabertura quando o cliente escreve", async () => {
    const r = await line("PATCH", "/contacts/5581888880000", { status: "resolved", notes: "VIP" });
    assert.equal((await r.json()).status, "resolved");
    await emit({ type: "message", raw: "{}", message: { id: "IN2", direction: "incoming", remote: "5581888880000", remoteJid: "5581888880000@s.whatsapp.net", type: "text", text: "de novo", status: "delivered", timestamp: new Date().toISOString() } });
    const c = await until(async () => { const x = await (await line("GET", "/contacts/5581888880000")).json(); return x.status === "open" && x; });
    assert.equal(c.notes, "VIP");
  });

  it("mensagem editada e apagada", async () => {
    await emit({ type: "message-update", id: "IN1", remoteJid: "5581888880000@s.whatsapp.net", text: "Oi (editado)" });
    await emit({ type: "message-update", id: "IN2", remoteJid: "5581888880000@s.whatsapp.net", deleted: true });
    const list = await until(async () => {
      const l = await (await line("GET", "/messages?contact=5581888880000")).json();
      return l.find((m: any) => m.id === "IN2")?.deletedAt && l;
    });
    assert.equal(list.find((m: any) => m.id === "IN1").text, "Oi (editado)");
    assert.equal(list.find((m: any) => m.id === "IN2").text, undefined);
  });

  it("limite de envio por minuto", async () => {
    await admin("PATCH", `/lines/${lineId}`, { rateLimitPerMinute: 1 });
    await line("POST", "/messages", { to: "5581777770000", text: "1" });
    const r = await line("POST", "/messages", { to: "5581777770000", text: "2" });
    assert.equal(r.status, 429);
    await admin("PATCH", `/lines/${lineId}`, { rateLimitPerMinute: 0 });
  });

  it("bloqueia URL interna para mídia", async () => {
    const r = await line("POST", "/messages", { to: "5581777770000", type: "image", url: "http://169.254.169.254/x" });
    assert.equal(r.status, 400);
  });

  it("ligação encerrada entra no histórico e nas métricas", async () => {
    const t = new Date().toISOString();
    const call = { id: "C1", direction: "incoming", remote: "5581888880000", status: "ended", startedAt: t, connectedAt: t, endedAt: t, endReason: "remote_end" };
    await emit({ type: "incoming", call: { ...call, status: "ringing" } });
    await emit({ type: "ended", call });
    const calls = await until(async () => { const x = await (await line("GET", "/calls?contact=5581888880000")).json(); return x.history.length && x.history; });
    assert.equal(calls[0].id, "C1");
    const m = await (await admin("GET", "/metrics?days=1")).json();
    assert.equal(m.totals.callsIncoming, 1);
    assert.equal(m.totals.callsAnswered, 1);
  });

  it("auditoria registra as alterações sem segredos", async () => {
    await admin("PATCH", `/lines/${lineId}`, { webhookSecret: "super-secreto" });
    const rows = await (await admin("GET", "/audit?action=line.update")).json();
    assert.ok(rows.length >= 1);
    assert.ok(!JSON.stringify(rows).includes("super-secreto"));
  });
});
