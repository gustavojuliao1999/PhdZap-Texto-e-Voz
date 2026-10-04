/**
 * Worker de linha falso para testes de integração: finge um WhatsApp conectado.
 * POST http://127.0.0.1:$FAKE_CONTROL_PORT/emit {evento} injeta eventos como se viessem do WhatsApp.
 */
import http from "node:http";
const send = (m: any) => process.send!(m);
send({ t: "wa", state: { status: "open", me: "5581900000000" } });
let n = 0;
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { send({ t: "event", event: JSON.parse(b) }); res.end("ok"); });
}).listen(Number(process.env.FAKE_CONTROL_PORT), "127.0.0.1");
process.on("message", (m: any) => {
  if (m.t !== "req") return;
  const ok = (data?: any) => send({ t: "res", reqId: m.reqId, ok: true, data });
  if (m.cmd === "send-message") {
    const c = m.content;
    return ok({ message: { id: `S${++n}`, direction: "outgoing", remote: m.to, remoteJid: `${m.to}@s.whatsapp.net`, status: "sent", timestamp: new Date().toISOString(), type: c.type, text: c.text }, raw: "{}" });
  }
  if (m.cmd === "profile-picture") return ok(null);
  ok();
});
setInterval(() => {}, 1 << 30);
