import type { CallHandler } from "./types.js";

/** Devolve ao chamador o que ele fala (~0,5 s de atraso). Bom para testar o áudio. */
export const echoHandler: CallHandler = {
  name: "echo",
  start(session) {
    session.on("audio", (pcm: Float32Array) => session.sendAudio(pcm));
  },
};

/** Não faz nada — chamada fica aberta para controle manual pela API. */
export const silenceHandler: CallHandler = {
  name: "silence",
  start() {},
};

