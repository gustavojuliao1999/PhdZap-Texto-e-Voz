import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { isWithinHours } from "../src/attendance.js";
import { redact } from "../src/audit.js";
import { recordCall } from "../src/audio/recorder.js";
import { parseOutgoing } from "../src/http/messages-api.js";
import { assertPublicUrl, isPrivateIp } from "../src/net/safe-fetch.js";
import { SendLimiter } from "../src/rate-limit.js";
import { WebhookDispatcher } from "../src/webhooks.js";

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("parseOutgoing (corpo de POST /messages)", () => {
  it("texto simples e com type", async () => {
    assert.deepEqual(await parseOutgoing({ text: "oi" }), { type: "text", text: "oi" });
    assert.deepEqual(await parseOutgoing({ type: "text", text: "a" }), { type: "text", text: "a" });
  });
  it("recusa corpo sem conteúdo ou tipo inválido", async () => {
    await assert.rejects(parseOutgoing({}), /text/);
    await assert.rejects(parseOutgoing({ type: "audio" }), /url.*base64/);
    await assert.rejects(parseOutgoing({ type: "foo", url: "https://x" }), /type/);
  });
  it("localização valida coordenadas", async () => {
    assert.equal((await parseOutgoing({ type: "location", latitude: -8, longitude: -34 })).type, "location");
    await assert.rejects(parseOutgoing({ type: "location", latitude: 91, longitude: 0 }), /latitude/);
  });
  it("reação aceita emoji vazio (remover)", async () => {
    assert.deepEqual(await parseOutgoing({ type: "reaction", text: "" }), { type: "reaction", text: "" });
  });
  it("documento em base64 deduz o mimetype pela extensão", async () => {
    const c: any = await parseOutgoing({ base64: Buffer.from("%PDF").toString("base64"), fileName: "b.pdf" });
    assert.equal(c.type, "document");
    assert.equal(c.mimetype, "application/pdf");
  });
  it("data URL define o mimetype", async () => {
    const c: any = await parseOutgoing({ type: "image", base64: `data:image/png;base64,${Buffer.from("x").toString("base64")}` });
    assert.equal(c.mimetype, "image/png");
  });
  it("figurinha precisa ser webp", async () => {
    await assert.rejects(parseOutgoing({ type: "sticker", base64: "data:image/png;base64,eA==" }), /webp/);
  });
  it("URL interna é recusada", async () => {
    await assert.rejects(parseOutgoing({ type: "image", url: "http://127.0.0.1/x.png" }), /interno/);
  });
  it("áudio vira áudio de voz ogg/opus com duração", { skip: !hasFfmpeg && "sem ffmpeg" }, async () => {
    const mp3 = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=3", "-f", "mp3", "-"]);
    const c: any = await parseOutgoing({ type: "audio", base64: mp3.toString("base64") });
    assert.equal(c.mimetype, "audio/ogg; codecs=opus");
    assert.equal(c.ptt, true);
    assert.equal(c.seconds, 3);
    assert.equal(Buffer.from(c.data).subarray(0, 4).toString(), "OggS");
  });
});

describe("bloqueio de endereços internos (SSRF)", () => {
  it("classifica IPs", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.10", "169.254.169.254", "100.64.0.1", "::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "200.147.3.157", "2606:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
  });
  it("recusa protocolos e formatos perigosos", async () => {
    for (const u of ["file:///etc/passwd", "ftp://x.com/a", "http://user:pw@x.com", "http://[::1]/", "http://2130706433/", "http://0x7f000001/"]) {
      await assert.rejects(assertPublicUrl(u), undefined, u);
    }
  });
});

describe("limite de envio", () => {
  it("por minuto", async () => {
    const l = new SendLimiter(async () => 0);
    await l.take("a", 2, 0);
    await l.take("a", 2, 0);
    await assert.rejects(l.take("a", 2, 0), /por minuto/);
    await l.take("b", 2, 0); // outra linha não é afetada
  });
  it("por dia, começando do que já foi enviado hoje", async () => {
    const l = new SendLimiter(async () => 9);
    await l.take("a", 0, 10);
    await assert.rejects(l.take("a", 0, 10), /por dia/);
  });
  it("zero = sem limite", async () => {
    const l = new SendLimiter(async () => 1e9);
    for (let i = 0; i < 50; i++) await l.take("a", 0, 0);
  });
});

describe("horário de atendimento", () => {
  const hours = { "1": [["08:00", "18:00"]] as [string, string][], "0": [] };
  it("dentro e fora", () => {
    assert.equal(isWithinHours(hours, new Date(2026, 9, 5, 9, 30)), true); // segunda 9h30
    assert.equal(isWithinHours(hours, new Date(2026, 9, 5, 18, 0)), false); // fim é exclusivo
    assert.equal(isWithinHours(hours, new Date(2026, 9, 4, 10, 0)), false); // domingo fechado
    assert.equal(isWithinHours(hours, new Date(2026, 9, 6, 10, 0)), false); // terça sem horário
  });
});

describe("auditoria", () => {
  it("mascara segredos em qualquer nível", () => {
    assert.deepEqual(redact({ name: "x", password: "p", nested: { webhookSecret: "s", ok: 1 }, list: [{ token: "t" }] }),
      { name: "x", password: "***", nested: { webhookSecret: "***", ok: 1 }, list: [{ token: "***" }] });
  });
});

describe("gravação de ligação", { skip: !hasFfmpeg && "sem ffmpeg" }, () => {
  it("mistura os dois lados no ritmo do áudio recebido e gera ogg", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    try {
      const s: any = new EventEmitter();
      s.id = "T1";
      const p = recordCall(s, dir);
      const frame = () => new Float32Array(320).fill(0.1);
      for (let i = 0; i < 50; i++) s.emit("sent-audio", frame());
      for (let i = 0; i < 100; i++) s.emit("audio", frame()); // 2 s
      s.emit("ended", "hangup");
      const r = await p;
      assert.ok(r);
      assert.equal(r.seconds, 2);
      const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", r.file]).toString());
      assert.ok(Math.abs(dur - 2) < 0.1, `duração ${dur}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("ligação curta demais não gera arquivo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    const s: any = new EventEmitter();
    s.id = "T2";
    const p = recordCall(s, dir);
    s.emit("audio", new Float32Array(320));
    s.emit("ended", "hangup");
    assert.equal(await p, null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("webhook", () => {
  it("assina o corpo com HMAC-SHA256 (timestamp.corpo)", async () => {
    let got: { headers: http.IncomingHttpHeaders; body: string } | null = null;
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { got = { headers: req.headers, body }; res.end("ok"); });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    const lines: any = Object.assign(new EventEmitter(), {
      get: () => ({ config: { id: "L1", name: "Linha", webhookUrl: `http://127.0.0.1:${port}/h`, webhookSecret: "seg", webhookEvents: [] }, wa: { me: "5581" } }),
    });
    const wh = new WebhookDispatcher(lines, {} as any, { send() {}, reset() {} } as any);
    const r = await wh.test("L1");
    srv.close();
    assert.equal(r.ok, true);
    assert.ok(got);
    const { headers, body } = got!;
    const expected = "sha256=" + createHmac("sha256", "seg").update(`${headers["x-webhook-timestamp"]}.${body}`).digest("hex");
    assert.equal(headers["x-webhook-signature"], expected);
    assert.equal(headers["x-webhook-event"], "ping");
    const json = JSON.parse(body);
    assert.equal(json.event, "ping");
    assert.equal(json.line.id, "L1");
  });
});
