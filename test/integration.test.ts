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

  it("agenda: contatos do celular e do perfil aparecem na pesquisa por nome e número", async () => {
    await emit({ type: "contacts", contacts: [{ remote: "5581444440000", remoteJid: "5581444440000@s.whatsapp.net", phoneName: "Dona Maria Padaria", pushName: "Maria" }] });
    const byName = await until(async () => { const l = await (await line("GET", "/contacts?q=padaria")).json(); return l.length && l; });
    assert.equal(byName[0].remote, "5581444440000");
    assert.equal(byName[0].name, "Dona Maria Padaria");
    assert.equal(byName[0].hasChat, false);
    const byNumber = await (await line("GET", "/contacts?q=8888")).json();
    assert.ok(byNumber.some((c: any) => c.remote === "5581888880000" && c.pushName === "Bia" && c.hasChat));
    // Nome da agenda vale na lista de conversas (abaixo do nome dado pela equipe).
    await emit({ type: "contacts", contacts: [{ remote: "5581888880000", remoteJid: "5581888880000@s.whatsapp.net", phoneName: "Bia Cliente" }] });
    const chat = await until(async () => (await (await line("GET", "/chats")).json()).find((c: any) => c.remote === "5581888880000" && c.phoneName));
    assert.equal(chat.name, "Bia Cliente");
    assert.equal(chat.profileName, "Bia");
  });

  it("histórico do celular: grava sem duplicar e sem virar não lida", async () => {
    const old = { id: "OLD1", direction: "incoming", remote: "5581888880000", remoteJid: "5581888880000@s.whatsapp.net", type: "text", text: "de 2019", status: "delivered", timestamp: "2019-05-01T12:00:00.000Z" };
    await emit({ type: "history", syncType: "INITIAL_BOOTSTRAP", messages: [{ message: old, raw: "{}" }, { message: old, raw: "{}" }] });
    const list = await until(async () => { const l = await (await line("GET", "/messages?contact=5581888880000&limit=500")).json(); return l.some((m: any) => m.id === "OLD1") && l; });
    assert.equal(list.filter((m: any) => m.id === "OLD1").length, 1);
    assert.equal(list.find((m: any) => m.id === "OLD1").status, "read");
    const chat = (await (await line("GET", "/chats")).json()).find((c: any) => c.remote === "5581888880000");
    assert.equal(chat.unread, 0);
  });

  it("buscar mensagens antigas de uma conversa e sincronizar tudo", async () => {
    assert.equal((await line("POST", "/chats/5581888880000/sync")).status, 202);
    await until(async () => (await (await line("GET", "/messages?contact=5581888880000&limit=500")).json()).some((m: any) => m.id === "H1"));
    // Conversa sem mensagens: não há referência para pedir ao celular.
    assert.equal((await line("POST", "/chats/5581000000000/sync")).status, 409);
    assert.equal((await admin("POST", `/lines/${lineId}/sync-history`)).status, 202);
    const st = await until(async () => { const x = await (await admin("GET", `/lines/${lineId}/sync-history`)).json(); return !x.running && x.finishedAt && x; }, 20_000);
    assert.equal(st.error, undefined);
    assert.ok(st.added >= 1);
    assert.equal(st.contacts, 1);
    const found = await (await line("GET", "/contacts?q=carlos")).json();
    assert.equal(found[0]?.name, "Carlos da Agenda");
  });

  it("contato oculto: gravado, mas fora da API e da pesquisa", async () => {
    const hid = "558133330000"; // gravado sem o 9º dígito
    await emit({ type: "message", raw: "{}", message: { id: "HID1", direction: "incoming", remote: hid, remoteJid: `${hid}@s.whatsapp.net`, pushName: "Particular", type: "text", text: "segredo", status: "delivered", timestamp: new Date().toISOString() } });
    await until(async () => (await (await line("GET", "/chats")).json()).some((c: any) => c.remote === hid));
    // Com o 9º dígito: a comparação ignora.
    const r = await admin("PATCH", `/lines/${lineId}`, { hiddenContacts: "55 81 9 3333-0000" });
    assert.deepEqual((await r.json()).hiddenContacts, ["5581933330000"]);
    assert.ok(!(await (await line("GET", "/chats")).json()).some((c: any) => c.remote === hid));
    assert.ok(!(await (await line("GET", "/messages?limit=500")).json()).some((m: any) => m.remote === hid));
    assert.equal((await line("GET", `/messages?contact=${hid}`)).status, 404);
    assert.equal((await line("GET", `/contacts/${hid}`)).status, 404);
    assert.ok(!(await (await line("GET", "/contacts?q=particular")).json()).length);
    assert.equal((await line("POST", "/messages", { to: hid, text: "x" })).status, 403);
    // Ligação dele vai para o banco, mas não para a API.
    const t = new Date().toISOString();
    await emit({ type: "incoming", call: { id: "CH", direction: "incoming", remote: hid, status: "ringing", startedAt: t } });
    assert.equal((await (await line("GET", "/line")).json()).current, null);
    await emit({ type: "ended", call: { id: "CH", direction: "incoming", remote: hid, status: "ended", startedAt: t, endedAt: t } });
    const db = new PrismaClient({ datasourceUrl: dbUrl });
    try {
      await until(() => db.call.count({ where: { callId: "CH" } }));
      assert.equal(await db.message.count({ where: { remote: hid } }), 1);
    } finally { await db.$disconnect(); }
    assert.ok(!(await (await line("GET", "/calls")).json()).history.some((c: any) => c.remote === hid));
    // Mostrar de novo pelo atalho do painel.
    const un = await admin("POST", `/lines/${lineId}/hidden-contacts`, { remote: hid, hidden: false });
    assert.deepEqual((await un.json()).hiddenContacts, []);
    assert.ok((await (await line("GET", "/chats")).json()).some((c: any) => c.remote === hid));
  });

  it("chamada de vídeo: mostra o vídeo do cliente em MJPEG e encerra com a ligação", async () => {
    await admin("PATCH", `/lines/${lineId}`, { videoCalls: "video" });
    const t = new Date().toISOString();
    const call = { id: "CV1", direction: "incoming", remote: "5581222220000", status: "ringing", startedAt: t, isVideo: true };
    await emit({ type: "incoming", call });
    const cur = await until(async () => (await (await line("GET", "/line")).json()).current);
    assert.equal(cur.isVideo, true);
    assert.equal(cur.videoStream, true);
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    await emit({ t: "video", callId: "CV1", jpegBase64: jpeg.toString("base64") });
    const res = await line("GET", "/calls/CV1/video");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /multipart\/x-mixed-replace/);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = Buffer.from(value!).toString("latin1");
    assert.ok(text.includes("--quadro") && text.includes("image/jpeg"));
    // A ligação acaba: o fluxo fecha.
    await emit({ type: "ended", call: { ...call, status: "ended", endedAt: t } });
    for (;;) { const r = await reader.read(); if (r.done) break; }
    assert.equal((await line("GET", "/calls/CV1/video")).status, 404);
    await admin("PATCH", `/lines/${lineId}`, { videoCalls: "audio" });
  });

  it("chamada de vídeo sem a opção de vídeo: não abre o fluxo", async () => {
    const t = new Date().toISOString();
    await emit({ type: "incoming", call: { id: "CV2", direction: "incoming", remote: "5581222220000", status: "ringing", startedAt: t, isVideo: true } });
    const cur = await until(async () => (await (await line("GET", "/line")).json()).current);
    assert.equal(cur.videoStream, undefined);
    assert.equal((await line("GET", "/calls/CV2/video")).status, 404);
    await emit({ type: "ended", call: { id: "CV2", direction: "incoming", remote: "5581222220000", status: "ended", startedAt: t, endedAt: t } });
    assert.equal((await admin("PATCH", `/lines/${lineId}`, { videoCalls: "talvez" })).status, 400);
  });

  it("ligação com vídeo: troca câmera/tela e envia os quadros do atendente", async () => {
    const r = await line("POST", "/calls", { to: "5581222220000", video: true, clientId: "cli-1" });
    assert.equal(r.status, 201);
    const call = await r.json();
    assert.equal(call.videoStream, true);
    assert.equal(call.videoSource, "camera");
    const sw = await line("POST", `/calls/${call.id}/video-source`, { source: "screen" });
    assert.equal((await sw.json()).videoSource, "screen");
    assert.equal((await line("POST", `/calls/${call.id}/video-source`, { source: "holograma" })).status, 400);
    // Outro cliente não envia vídeo nesta ligação.
    const intruso = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/video-up?call=${call.id}&clientId=outro&token=${token}`);
    await new Promise((resolve) => { intruso.onerror = resolve; intruso.onclose = resolve; });
    assert.notEqual(intruso.readyState, WebSocket.OPEN);
    // O dono envia um JPEG; o worker falso devolve como vídeo do cliente.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/video-up?call=${call.id}&clientId=cli-1&token=${token}`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const stream = await line("GET", `/calls/${call.id}/video`);
    assert.equal(stream.status, 200);
    ws.send(new Uint8Array([0xff, 0xd8, 9, 9, 0xff, 0xd9]));
    const reader = stream.body!.getReader();
    const { value } = await reader.read();
    assert.ok(Buffer.from(value!).toString("latin1").includes("image/jpeg"));
    const t = new Date().toISOString();
    await emit({ type: "ended", call: { id: call.id, direction: "outgoing", remote: "5581222220000", status: "ended", startedAt: t, endedAt: t } });
    await new Promise((resolve) => { ws.onclose = resolve; });
    await reader.cancel();
  });

  it("auditoria registra as alterações sem segredos", async () => {
    await admin("PATCH", `/lines/${lineId}`, { webhookSecret: "super-secreto" });
    const rows = await (await admin("GET", "/audit?action=line.update")).json();
    assert.ok(rows.length >= 1);
    assert.ok(!JSON.stringify(rows).includes("super-secreto"));
  });
});
