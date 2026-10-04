import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { MessageService } from "../src/worker/messages.js";

// Baileys real (dependência do baileys-caller) para normalizar as mensagens como em produção.
// @ts-ignore
const baileysMod = await import("../../baileys-caller/node_modules/@whiskeysockets/baileys/lib/index.js").catch(() => null);
const baileys = baileysMod ? { ...(baileysMod.default ?? {}), ...baileysMod } : null;

const setup = (groups = false) => {
  const ev = new EventEmitter();
  const sent: any[] = [];
  const sock: any = {
    ev,
    onWhatsApp: async (jid: string) => [{ exists: jid.startsWith("5581992338229"), jid }],
    sendMessage: async (jid: string, content: any) => {
      sent.push({ jid, content });
      return { key: { remoteJid: jid, fromMe: true, id: `OUT${sent.length}` }, message: { conversation: content.text ?? "" }, messageTimestamp: 1760000000, status: 1 };
    },
    groupMetadata: async () => ({ subject: "Equipe Vendas" }),
    signalRepository: { lidMapping: { getPNForLID: async (lid: string) => (lid === "123@lid" ? "5511988887777@s.whatsapp.net" : null) } },
  };
  const svc = new MessageService({ socket: sock, baileys } as any, () => groups);
  svc.attach();
  const out: any[] = [];
  svc.on("message", (m) => out.push(["message", m]));
  svc.on("update", (u) => out.push(["update", u]));
  svc.on("status", (s) => out.push(["status", s]));
  const flush = () => new Promise((r) => setTimeout(r, 50));
  return { ev, svc, out, sent, flush };
};

describe("MessageService (normalização de mensagens)", { skip: !baileys && "baileys-caller não encontrado" }, () => {
  it("texto, LID resolvido para telefone e resposta", async () => {
    const { ev, out, flush } = setup();
    ev.emit("messages.upsert", { type: "notify", messages: [
      { key: { remoteJid: "5581992338229@s.whatsapp.net", fromMe: false, id: "A" }, pushName: "Maria", messageTimestamp: 1760000000, message: { conversation: "Oi" } },
      { key: { remoteJid: "123@lid", fromMe: false, id: "B" }, messageTimestamp: 1760000001, message: { extendedTextMessage: { text: "r", contextInfo: { stanzaId: "A" } } } },
    ] });
    await flush();
    const [a, b] = out.map((o) => o[1]);
    assert.equal(a.text, "Oi");
    assert.equal(a.remote, "5581992338229");
    assert.equal(a.pushName, "Maria");
    assert.equal(b.remote, "5511988887777");
    assert.equal(b.replyTo, "A");
  });
  it("ignora histórico (append), status e grupos desligados", async () => {
    const { ev, out, flush } = setup(false);
    ev.emit("messages.upsert", { type: "append", messages: [{ key: { remoteJid: "5581@s.whatsapp.net", id: "H" }, message: { conversation: "x" } }] });
    ev.emit("messages.upsert", { type: "notify", messages: [
      { key: { remoteJid: "status@broadcast", id: "S" }, message: { conversation: "x" } },
      { key: { remoteJid: "1203@g.us", id: "G" }, message: { conversation: "x" } },
    ] });
    await flush();
    assert.equal(out.length, 0);
  });
  it("grupo ligado: nome do grupo e de quem mandou", async () => {
    const { ev, out, flush } = setup(true);
    ev.emit("messages.upsert", { type: "notify", messages: [
      { key: { remoteJid: "1203@g.us", participant: "5581222222222@s.whatsapp.net", id: "G" }, pushName: "Carla", message: { conversation: "Bom dia" } },
    ] });
    await flush();
    const m = out[0][1];
    assert.equal(m.remote, "1203@g.us");
    assert.equal(m.participant, "5581222222222");
    assert.equal(m.participantName, "Carla");
    assert.equal(m.chatName, "Equipe Vendas");
    assert.equal(m.pushName, undefined);
  });
  it("edição e exclusão viram update", async () => {
    const { ev, out, flush } = setup();
    ev.emit("messages.upsert", { type: "notify", messages: [
      { key: { remoteJid: "5581@s.whatsapp.net", id: "P1" }, message: { protocolMessage: { type: 14, key: { remoteJid: "5581@s.whatsapp.net", id: "X" }, editedMessage: { conversation: "novo" } } } },
      { key: { remoteJid: "5581@s.whatsapp.net", id: "P2" }, message: { protocolMessage: { type: 0, key: { remoteJid: "5581@s.whatsapp.net", id: "Y" } } } },
    ] });
    await flush();
    assert.deepEqual(out.map((o) => o[1]), [
      { id: "X", remoteJid: "5581@s.whatsapp.net", text: "novo" },
      { id: "Y", remoteJid: "5581@s.whatsapp.net", deleted: true },
    ]);
  });
  it("mídias: áudio de voz, documento, localização, reação", async () => {
    const { ev, out, flush } = setup();
    const j = "5581@s.whatsapp.net";
    ev.emit("messages.upsert", { type: "notify", messages: [
      { key: { remoteJid: j, id: "1" }, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 7, ptt: true, fileLength: 100 } } },
      { key: { remoteJid: j, id: "2" }, message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: "application/pdf", fileName: "a.pdf", caption: "c" } } } } },
      { key: { remoteJid: j, id: "3" }, message: { locationMessage: { degreesLatitude: -8, degreesLongitude: -34, name: "Loja" } } },
      { key: { remoteJid: j, id: "4" }, message: { reactionMessage: { text: "👍", key: { id: "1" } } } },
    ] });
    await flush();
    const [a, d, l, r] = out.map((o) => o[1]);
    assert.deepEqual([a.type, a.media.seconds, a.media.ptt, a.media.size], ["audio", 7, true, 100]);
    assert.deepEqual([d.type, d.media.fileName, d.text], ["document", "a.pdf", "c"]);
    assert.deepEqual([l.type, l.location.name], ["location", "Loja"]);
    assert.deepEqual([r.type, r.text, r.replyTo], ["reaction", "👍", "1"]);
  });
  it("envio resolve o número e recusa número inexistente", async () => {
    const { svc, sent } = setup();
    const r = await svc.send("5581992338229", { type: "text", text: "olá" });
    assert.equal(sent[0].jid, "5581992338229@s.whatsapp.net");
    assert.equal(r.message.status, "sent");
    await assert.rejects(svc.send("5511000000000", { type: "text", text: "x" }), /não foi encontrado/);
    await assert.rejects(svc.send("1203@g.us", { type: "text", text: "x" }), /Grupos estão desativados/);
  });
});
