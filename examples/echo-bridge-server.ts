/**
 * Exemplo de serviço de mídia para CALL_HANDLER=ws-bridge.
 *
 *   npm run bridge:example        (escuta em ws://127.0.0.1:8090/media)
 *
 * Ele detecta fala por energia (VAD simples) e, quando o chamador faz uma pausa,
 * devolve a frase gravada — exatamente o ciclo "ouvir -> pensar -> falar" de um
 * agente de voz. Para virar IA, troque `respond()` por:
 *   - STT (Whisper/Deepgram...) -> LLM (Claude...) -> TTS (ElevenLabs...), ou
 *   - um modelo speech-to-speech em tempo real, repassando o PCM direto.
 * Se o chamador falar enquanto o bot fala, mande {"event":"clear"} (barge-in).
 */
import { WebSocketServer } from "ws";

const PORT = Number(process.env.BRIDGE_PORT) || 8090;
const SPEECH_RMS = 0.02;      // limiar de energia p/ considerar fala (PCM normalizado)
const END_OF_TURN_MS = 700;   // silêncio que encerra a vez do chamador

const rms = (buf: Buffer): number => {
  let sum = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i += 1) { const s = buf.readInt16LE(i * 2) / 0x8000; sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
};

const wss = new WebSocketServer({ port: PORT, path: "/media" });
console.log(`ponte de exemplo em ws://127.0.0.1:${PORT}/media`);

wss.on("connection", (ws) => {
  let sampleRate = 16000;
  let utterance: Buffer[] = [];
  let speaking = false;
  let botTalking = false;
  let silenceTimer: NodeJS.Timeout | null = null;

  /** Ponto de integração da IA: recebe a fala do chamador (PCM16) e devolve a resposta (PCM16). */
  const respond = async (callerAudio: Buffer): Promise<Buffer> => callerAudio;

  const endOfTurn = async (): Promise<void> => {
    speaking = false;
    const audio = Buffer.concat(utterance);
    utterance = [];
    if (audio.length < sampleRate * 2 * 0.3) return; // < 300 ms: ruído
    const reply = await respond(audio);
    botTalking = true;
    const frame = Math.floor(sampleRate * 0.02) * 2; // envia em frames de 20 ms
    for (let i = 0; i < reply.length; i += frame) ws.send(reply.subarray(i, i + frame));
    ws.send(JSON.stringify({ event: "mark", name: "fim-resposta" }));
  };

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(data.toString());
      if (msg.event === "start") {
        sampleRate = msg.sampleRate;
        console.log(`chamada ${msg.callId} (${msg.direction}) de ${msg.from} @ ${sampleRate} Hz`);
      } else if (msg.event === "mark") {
        botTalking = false;
      } else if (msg.event === "stop") {
        console.log(`chamada encerrada: ${msg.reason}`);
      }
      return;
    }
    const chunk = data as Buffer;
    if (rms(chunk) > SPEECH_RMS) {
      if (botTalking) { ws.send(JSON.stringify({ event: "clear" })); botTalking = false; }
      speaking = true;
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    }
    if (speaking) {
      utterance.push(chunk);
      silenceTimer ??= setTimeout(() => { silenceTimer = null; void endOfTurn(); }, END_OF_TURN_MS);
    }
  });
});
