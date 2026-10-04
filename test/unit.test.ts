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
import { hiddenMatcher, hiddenRemotes, normalizeHiddenList } from "../src/hidden.js";
import { recordCall } from "../src/audio/recorder.js";
import { parseOutgoing } from "../src/http/messages-api.js";
import { assertPublicUrl, isPrivateIp } from "../src/net/safe-fetch.js";
import { SendLimiter } from "../src/rate-limit.js";
import { groupWords, mergeTurns, sidesFileOf, turnsToText } from "../src/transcribe.js";
import { VideoRelay } from "../src/video.js";
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
  it("com keepSides, guarda os lados em canais separados (esq. contato, dir. atendente)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    try {
      const s: any = new EventEmitter();
      s.id = "T3";
      const p = recordCall(s, dir, true);
      // 1 s só o atendente (contato em silêncio), depois 1 s só o contato. Tom de 440 Hz.
      const tone = (i: number) => Float32Array.from({ length: 320 }, (_, n) => 0.5 * Math.sin((2 * Math.PI * 440 * (i * 320 + n)) / 16000));
      for (let i = 0; i < 50; i++) s.emit("sent-audio", tone(i));
      for (let i = 0; i < 50; i++) s.emit("audio", new Float32Array(320));
      for (let i = 0; i < 50; i++) s.emit("audio", tone(i));
      s.emit("ended", "hangup");
      const r = await p;
      assert.ok(r);
      const sides = sidesFileOf(r.file);
      const probe = (f: string, entry: string) => execFileSync("ffprobe", ["-v", "error", "-show_entries", entry, "-of", "csv=p=0", f]).toString().trim();
      assert.equal(probe(sides, "stream=channels"), "2");
      assert.equal(probe(r.file, "stream=channels"), "1");
      // Volume de cada canal em cada metade: o atendente fala no 1º segundo, o contato no 2º.
      const rms = (ch: 0 | 1, start: number) => {
        const out = execFileSync("ffmpeg", ["-v", "error", "-ss", String(start + 0.2), "-t", "0.6", "-i", sides, "-af", `pan=mono|c0=c${ch}`, "-f", "s16le", "-ac", "1", "-"]);
        let sum = 0;
        for (let i = 0; i < out.length; i += 2) sum += (out.readInt16LE(i) / 32768) ** 2;
        return Math.sqrt(sum / (out.length / 2));
      };
      assert.ok(rms(1, 0) > 0.1 && rms(0, 0) < 0.05, `1º segundo: contato ${rms(0, 0)}, atendente ${rms(1, 0)}`);
      assert.ok(rms(0, 1) > 0.1 && rms(1, 1) < 0.05, `2º segundo: contato ${rms(0, 1)}, atendente ${rms(1, 1)}`);
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

describe("contatos ocultos", () => {
  it("compara com e sem o 9º dígito e ignora a formatação", () => {
    const hidden = hiddenMatcher(normalizeHiddenList("+55 (81) 9 9999-0000\n5511988887777"));
    assert.ok(hidden("5581999990000"));
    assert.ok(hidden("558199990000"));
    assert.ok(hidden("551188887777"));
    assert.ok(!hidden("5581999990001"));
    assert.ok(!hidden(undefined));
  });
  it("lista: só números válidos, sem repetir o mesmo número", () => {
    assert.deepEqual(normalizeHiddenList(["5581999990000", "558199990000", "123", ""]), ["558199990000"]);
  });
  it("variantes para filtrar no banco", () => {
    assert.deepEqual(hiddenRemotes(["5581999990000"]).sort(), ["558199990000", "5581999990000"].sort());
    assert.deepEqual(hiddenRemotes(["14155550000"]), ["14155550000"]);
  });
});

describe("vídeo do cliente (VideoRelay)", () => {
  /** Lê largura x altura do JPEG (marcador SOF0). */
  const jpegSize = (b: Buffer): [number, number] => {
    for (let i = 2; i < b.length - 9; i++) if (b[i] === 0xff && b[i + 1] === 0xc0) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    return [0, 0];
  };
  it("converte quadros I420 em JPEG, aplicando a rotação pedida", async () => {
    const relay = new VideoRelay();
    const got = new Promise<Buffer>((resolve) => relay.once("jpeg", resolve));
    const w = 320, h = 240;
    const data = new Uint8Array(w * h * 1.5).fill(128);
    const timer = setInterval(() => relay.push({ data, width: w, height: h, format: 1, orientation: 2, timestamp: 0, isKeyFrame: true }), 120);
    try {
      const jpeg = await got;
      assert.equal(jpeg[0], 0xff);
      assert.equal(jpeg[1], 0xd8);
      assert.deepEqual(jpegSize(jpeg), [240, 320]); // girado 90°
    } finally {
      clearInterval(timer);
      relay.stop();
    }
  });
  it("ignora formato desconhecido ou quadro incompleto", () => {
    const relay = new VideoRelay();
    relay.on("jpeg", () => assert.fail("não deveria gerar imagem"));
    relay.push({ data: new Uint8Array(10), width: 320, height: 240, format: 1, orientation: 1, timestamp: 0, isKeyFrame: true });
    relay.push({ data: new Uint8Array(320 * 240 * 4), width: 320, height: 240, format: 100, orientation: 1, timestamp: 0, isKeyFrame: true });
    relay.stop();
  });
});

describe("transcrição: quem falou", () => {
  it("junta os dois lados em ordem de tempo e une falas seguidas do mesmo lado", () => {
    const turns = mergeTurns(
      [{ start: 0.5, end: 2, text: "Oi, bom dia." }, { start: 6, end: 8, text: "Quero saber do pedido." }, { start: 8.2, end: 9, text: "É o 123." }],
      [{ start: 2.5, end: 5, text: "Bom dia! Em que posso ajudar?" }],
    );
    assert.deepEqual(turns, [
      { at: 0.5, who: "contact", text: "Oi, bom dia." },
      { at: 2.5, who: "agent", text: "Bom dia! Em que posso ajudar?" },
      { at: 6, who: "contact", text: "Quero saber do pedido. É o 123." },
    ]);
    assert.equal(turnsToText(turns, "Maria"), "Cliente: Oi, bom dia.\nMaria: Bom dia! Em que posso ajudar?\nCliente: Quero saber do pedido. É o 123.");
  });
  it("separa as palavras em falas nas pausas (intervalo ou palavra que engole o silêncio)", () => {
    const w = (start: number, end: number, text: string) => ({ start, end, text });
    // Saída real do whisper.cpp com VAD: "pedido," vai de 4,22 s a 8,55 s (a pausa ficou dentro dela).
    const out = groupWords([w(0.5, 1.09, " Olá,"), w(1.09, 1.46, " bom"), w(3.98, 4.22, " meu"), w(4.22, 8.55, " pedido,"),
      w(8.55, 9, " o"), w(9, 9.52, " número"), w(12, 12.4, " três.")]);
    assert.deepEqual(out.map((s) => [s.start, s.text]), [[0.5, " Olá, bom"], [3.98, " meu pedido,"], [8.55, " o número"], [12, " três."]]);
    assert.ok(out[1].end <= 5.1, `fim da fala antes da pausa: ${out[1].end}`);
  });
  it("arquivo dos lados fica ao lado da gravação", () => {
    assert.equal(sidesFileOf("recordings/ABC.ogg"), "recordings/ABC.sides.ogg");
  });
});
