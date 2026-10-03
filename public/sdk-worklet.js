// Processadores de áudio do SDK (microfone -> chamada, chamada -> alto-falante).
class Capture extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice()); return true; }
}
class Playback extends AudioWorkletProcessor {
  constructor() {
    super(); this.q = []; this.off = 0; this.size = 0;
    this.port.onmessage = (e) => {
      this.q.push(e.data); this.size += e.data.length;
      while (this.size > sampleRate * 0.4 && this.q.length > 1) { this.size -= this.q.shift().length - this.off; this.off = 0; }
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      const buf = this.q[0];
      if (!buf) { out[i] = 0; continue; }
      out[i] = buf[this.off++]; this.size--;
      if (this.off >= buf.length) { this.q.shift(); this.off = 0; }
    }
    return true;
  }
}
registerProcessor("capture", Capture);
registerProcessor("playback", Playback);
