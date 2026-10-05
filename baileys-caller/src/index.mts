/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";

import { WasmEngine } from "./wasm-engine.mjs";
import { RelayRtcTransport, type RelayListUpdatePayload } from "./relay-transport.mjs";
import { SignalingBridge, type IncomingOfferInfo } from "./signaling.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { debug, DEBUG, DEBUG_WASM } from "./debug.mjs";
import {
  CallState, VideoFormat, type VoipSdkConfig, type CallDirection, type IncomingCallInfo, type VideoFrame,
  type VideoCaptureRequest,
} from "./types.mjs";

export type {
  VoipSdkConfig, CallOptions, CallEvents, AudioConfig, CallDirection, IncomingCallInfo, VideoFrame,
  VideoCaptureRequest,
} from "./types.mjs";
export { CallState, VideoFormat, VideoOrientation } from "./types.mjs";

const SHA256_LEN = 32;

const loadBaileys = async (): Promise<any> => {
  try {
    return await import("@whiskeysockets/baileys");
  } catch {
    throw new Error(
      "Could not import @whiskeysockets/baileys. Install it as a peer dependency.",
    );
  }
};

const toBareJid = (jid: string): string => {
  if (!jid) return jid;
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(":")[0];
  return `${user}@${jid.slice(at + 1)}`;
};

const computeHkdf = (
  key: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array,
  length: number,
): Uint8Array => {
  const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
  const prk = createHmac("sha256", effectiveSalt).update(key).digest();
  const blocks = Math.ceil(length / SHA256_LEN);
  const okm = Buffer.alloc(blocks * SHA256_LEN);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i += 1) {
    prev = createHmac("sha256", prk)
      .update(prev)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    prev.copy(okm, (i - 1) * SHA256_LEN);
  }
  return new Uint8Array(okm.buffer, okm.byteOffset, length);
};

const computeHmacSha256 = (data: Uint8Array, key: Uint8Array): Uint8Array => {
  const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};

/**
 * Numbers to try for a dial string. Brazil (+55) mobiles gained a leading 9 in
 * 2012–2016, but many WhatsApp accounts are still registered without it (and a
 * few the other way round), so try the alternate form too.
 */
export const phoneNumberCandidates = (digits: string): string[] => {
  const out = [digits];
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const local = digits.slice(4);
    if (local.length === 9 && local[0] === "9") out.push(`55${ddd}${local.slice(1)}`);
    else if (local.length === 8 && /[6-9]/.test(local[0])) out.push(`55${ddd}9${local}`);
  }
  return out;
};

const isCallReceiptNode = (node: any): boolean => {
  if (node?.tag !== "receipt") return false;
  const child = Array.isArray(node.content) ? node.content[0] : null;
  return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};

/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
  #state: CallState = CallState.Idle;
  #endResolver!: (reason: string) => void;
  readonly #endPromise: Promise<string>;
  #endTimer: NodeJS.Timeout | null = null;
  #durationMs: number;
  #ended = false;
  #answered = false;
  #feeder: AudioFeeder | null = null;
  #prebuffer: Float32Array[] = [];

  /** @internal mirrors the source path for the audio feeder */
  _audioSource: string = "silence";

  /** Set for inbound calls. */
  readonly incoming: IncomingCallInfo | null;

  /** Outbound: the number actually dialed (may differ from the input, e.g. BR 9th digit). */
  remoteNumber?: string;

  constructor(
    public readonly callId: string,
    private readonly engine: WasmEngine,
    durationMs: number,
    public readonly direction: CallDirection = "outgoing",
    incoming: IncomingCallInfo | null = null,
  ) {
    super();
    this.incoming = incoming;
    this.#endPromise = new Promise((res) => { this.#endResolver = res; });
    // Swallow unhandled "error" events so a missing listener can't crash the process.
    this.on("error", () => {});
    this.#durationMs = durationMs;
    // Outbound: limit starts now. Inbound: limit starts once answered.
    if (direction === "outgoing") this.#armEndTimer();
  }

  get state(): CallState { return this.#state; }
  get ended(): boolean { return this.#ended; }

  /** Answer a ringing inbound call (`camera`: answer sending video). */
  accept = (opts: { camera?: boolean } = {}): void => {
    if (this.direction !== "incoming" || this.#ended || this.#answered) return;
    this.#answered = true;
    debug(`accept call=${this.callId} (state=${this.#state}) camera=${!!opts.camera}`);
    this.engine.acceptCall(true, !!opts.camera);
    this.#armEndTimer();
  };

  // ─── video (send) ─────────────────────────────────────────────────────

  /** Current capture the WASM asked for (null = not sending video). */
  videoCapture: VideoCaptureRequest | null = null;

  /** Turn our camera on: a voice call is upgraded to video first. */
  startCamera = (): void => {
    if (this.#ended) return;
    if (!this.isVideo) { this.engine.requestVideoUpgrade(); this.isVideo = true; }
    this.engine.setVideoMute(false);
  };
  stopCamera = (): void => { if (!this.#ended) this.engine.setVideoMute(true); };
  /** Share the screen (frames go with `sendVideoFrame` while `videoCapture.kind === "screen"`). */
  startScreenShare = (width: number, height: number): void => {
    if (this.#ended) return;
    if (!this.isVideo) { this.engine.requestVideoUpgrade(); this.isVideo = true; }
    this.engine.setScreenShareCaptureSize(width, height);
    this.engine.startScreenShare();
  };
  stopScreenShare = (): void => { if (!this.#ended) this.engine.stopScreenShare(); };

  /** Send one raw frame (NV12 by default) for the current capture. */
  sendVideoFrame = (data: Uint8Array, width: number, height: number, format: number = VideoFormat.NV12): void => {
    const cap = this.videoCapture;
    if (this.#ended || !cap) return;
    if (cap.kind === "screen" && (width !== this.#shareW || height !== this.#shareH)) {
      this.#shareW = width; this.#shareH = height;
      this.engine.setScreenShareCaptureSize(width, height);
    }
    try {
      this.engine.sendVideoFrame(cap.kind, data, width, height, cap.maxFps, format);
    } catch (err) {
      if (!this.#videoErrorLogged) { this.#videoErrorLogged = true; debug(`sendVideoFrame failed: ${(err as Error)?.message ?? err}`); }
    }
  };
  #shareW = 0;
  #shareH = 0;
  #videoErrorLogged = false;
  /** Video call (offered/answered with video, or upgraded). */
  isVideo = false;

  /** @internal */
  _videoCapture = (req: VideoCaptureRequest | null, kind?: "camera" | "screen"): void => {
    if (req) {
      debug(`video capture start call=${this.callId} ${req.kind} ${req.width}x${req.height}@${req.maxFps}`);
      this.videoCapture = req;
      this.emit("video-capture", req);
    } else if (!this.videoCapture || this.videoCapture.kind === kind) {
      debug(`video capture stop call=${this.callId} ${kind}`);
      this.videoCapture = null;
      this.emit("video-capture-stop", kind ?? "camera");
    }
  };

  /** Decline a ringing inbound call. */
  reject = (): void => {
    if (this.direction !== "incoming" || this.#ended || this.#answered) return;
    try { this.engine.rejectCall(); } catch {}
    this._forceEnd("rejected");
  };

  /**
   * Send PCM to the peer (Float32 in [-1, 1], 16 kHz mono). Only works when
   * the call was created with `audioSource: "stream"`. Audio pushed before the
   * uplink opens is buffered.
   */
  sendAudio = (pcm: Float32Array): void => {
    if (this.#ended) return;
    if (this.#feeder) this.#feeder.push(pcm);
    else this.#prebuffer.push(pcm.slice());
  };

  /** Discard queued outbound audio (barge-in). */
  clearAudio = (): void => {
    this.#prebuffer = [];
    this.#feeder?.clear();
  };

  /** Milliseconds of outbound audio still queued. */
  get queuedAudioMs(): number { return this.#feeder?.queuedMs ?? 0; }

  end = (): void => {
    if (this.#ended) return;
    // Sends <terminate> to the peer. Don't mark #ended before _forceEnd, or the
    // "ended" event never fires and the client keeps the call as active.
    try { this.engine.endCall(0, true); } catch {}
    this._forceEnd("hangup");
  };

  mute = (muted: boolean): void => {
    try { this.engine.setMute(muted); } catch {}
  };

  waitForEnd = (): Promise<string> => this.#endPromise;

  /** @internal — called by VoipClient on WASM call-state change */
  _updateState = (state: number): void => {
    const prev = this.#state;
    if (state === prev) return;
    debug(`call=${this.callId} state ${prev} -> ${state}`);
    this.#state = state as CallState;
    this.emit("state", state);
    if (state === CallState.PreacceptReceived) this.emit("ringing");
    else if (state === CallState.Active) this.emit("connected");
    else if (state === CallState.Ending || (state === CallState.Idle && prev !== CallState.Idle)) {
      this._forceEnd("ended");
    }
  };

  /**
   * @internal — media started flowing (capture/playback opened by the WASM).
   * For an answered inbound call that proves the call is up even if the
   * "Active" state event never arrives, so report it as connected.
   */
  _mediaStarted = (source: string): void => {
    debug(`call=${this.callId} media started (${source}) state=${this.#state} answered=${this.#answered}`);
    if (this.#ended || this.direction !== "incoming" || !this.#answered) return;
    if (this.#state === CallState.Active) return;
    this.#state = CallState.Active;
    this.emit("state", CallState.Active);
    this.emit("connected");
  };

  /** @internal — the WASM reuses its playback buffer, so hand out a copy. */
  _emitAudio = (pcm: Float32Array): void => { this.emit("audio", pcm.slice()); };
  /** @internal */
  _emitVideo = (frame: VideoFrame): void => {
    if (!this.#videoLogged) {
      this.#videoLogged = true;
      debug(`video call=${this.callId} first frame ${frame.width}x${frame.height} format=${frame.format} orientation=${frame.orientation}`);
    }
    this.emit("video", frame);
  };
  #videoLogged = false;

  /** @internal */
  _attachFeeder = (feeder: AudioFeeder | null): void => {
    this.#feeder = feeder;
    if (!feeder) return;
    for (const chunk of this.#prebuffer) feeder.push(chunk);
    this.#prebuffer = [];
  };

  #armEndTimer = (): void => {
    if (this.#durationMs > 0 && !this.#endTimer) {
      this.#endTimer = setTimeout(() => this.end(), this.#durationMs);
    }
  };

  /** @internal */
  _forceEnd = (reason: string): void => {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    this.emit("ended", reason);
    this.#endResolver(reason);
  };
}

/**
 * Top-level client. Connects to WhatsApp and lets you place and receive calls.
 *
 * Events:
 *   - `incoming` (call: ActiveCall) — an inbound call is ringing; call
 *     `call.accept()` or `call.reject()`.
 *   - `busy` (info: IncomingCallInfo) — an inbound offer arrived while another
 *     call was active and was ignored.
 *   - `qr` (qr: string) — pairing QR payload (refreshes every ~20 s until scanned).
 */
export class VoipClient extends EventEmitter {
  readonly #config: VoipSdkConfig;
  #engine: WasmEngine | null = null;
  #relay: RelayRtcTransport | null = null;
  #signaling: SignalingBridge | null = null;
  #sock: any = null;
  #activeCall: ActiveCall | null = null;
  #baileys: any = null;

  // Capture state populated when WASM negotiates audio params
  #capturePtr = 0;
  #captureChunkBytes = 0;
  #captureSampleRate = 16000;
  #captureChannels = 1;
  #captureFramesPerChunk = 320;
  #feeder: AudioFeeder | null = null;

  constructor(config: VoipSdkConfig) {
    super();
    this.#config = config;
  }

  /** JID of the linked account once connected (e.g. `5511999999999:12@s.whatsapp.net`). */
  get selfJid(): string | undefined { return this.#sock?.authState?.creds?.me?.id; }

  /**
   * The underlying Baileys socket (null until connected). Use it for messages
   * and anything else besides calls — never open a second socket with the same
   * auth, WhatsApp keeps only one connection per linked device.
   */
  get socket(): any { return this.#sock; }

  /** The loaded Baileys module (helpers such as `downloadMediaMessage`). */
  get baileys(): any { return this.#baileys; }

  /** The call currently in progress (or ringing), if any. */
  get activeCall(): ActiveCall | null { return this.#activeCall; }

  /** Connect to WhatsApp and bring up the WASM VoIP stack. */
  connect = async (): Promise<void> => {
    this.#baileys = await loadBaileys();
    const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
    const makeSocket: (opts: any) => any =
      makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;

    const authDir = resolve(this.#config.authDir);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const silentLogger: any = {
      level: "silent",
      child: () => silentLogger,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    // The WA Web version bundled with Baileys goes stale and the server then
    // refuses the login ("Connection Failure" / 405) — always use the latest.
    let version: number[] | undefined;
    try {
      ({ version } = await this.#baileys.fetchLatestBaileysVersion());
    } catch {}

    const extra = typeof this.#config.socketOptions === "function"
      ? this.#config.socketOptions(this.#baileys)
      : this.#config.socketOptions ?? {};
    const createSocket = () => makeSocket({
      emitOwnEvents: true,
      ...extra,
      auth: state,
      ...(version ? { version } : {}),
      logger: silentLogger,
    });

    // Connect with auto-reconnect on the post-QR 515 stream-error path.
    await new Promise<void>((resolveOpen, rejectOpen) => {
      let opened = false;
      let retries = 0;
      const maxRetries = 5;

      const connectSocket = () => {
        this.#sock = createSocket();
        this.#sock.ev.on("creds.update", saveCreds);

        process.removeAllListeners("uncaughtException");
        process.on("uncaughtException", (err: any) => {
          const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
          if ((code === 515 || code === "515") && !opened && retries < maxRetries) {
            retries += 1;
            setTimeout(connectSocket, 1500);
          } else if (!opened) {
            rejectOpen(err);
          }
        });

        this.#sock.ev.on("connection.update", (update: any) => {
          if (update.qr) {
            this.emit("qr", update.qr);
            if (this.#config.printQrInTerminal !== false) {
              void import("qrcode-terminal")
                .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
                .catch(() => {
                  console.log("Scan this QR code in WhatsApp > Linked Devices:");
                  console.log(update.qr);
                });
            }
          }
          if (update.connection === "open") {
            opened = true;
            process.removeAllListeners("uncaughtException");
            resolveOpen();
            return;
          }
          if (update.connection === "close" && !opened) {
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect =
              statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
            if (shouldReconnect && retries < maxRetries) {
              retries += 1;
              setTimeout(connectSocket, 1000);
            } else {
              rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
            }
          }
          if (update.connection === "close" && opened) {
            // Dropped after being connected (network, server restart, logged out from the phone).
            // The WASM stack can't be re-attached to a new socket: callers should restart.
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            this.emit("connection-lost", {
              statusCode,
              loggedOut: statusCode === DisconnectReason?.loggedOut,
              error: update.lastDisconnect?.error?.message,
            });
          }
        });
      };

      connectSocket();
    });

    this.#signaling = new SignalingBridge({
      sock: this.#sock,
      onIncomingOffer: (info) => this.#handleIncomingOffer(info),
      onPeerTerminate: (callId) => this.#handlePeerTerminate(callId),
    });
    await this.#signaling.init();

    this.#relay = new RelayRtcTransport({
      onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
      onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
    });

    this.#engine = new WasmEngine({
      callbacks: {
        onSignalingXmpp: (peerJid, callId, xmlPayload) =>
          this.#signaling!.sendSignaling(peerJid, callId, xmlPayload),
        onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
        // VOIP_DEBUG=1: avisos/erros do WASM; VOIP_DEBUG=wasm: tudo.
        onLog: DEBUG
          ? (level, msg) => { if (DEBUG_WASM || level === "error" || level === "warn") debug(`[wasm:${level}]`, msg); }
          : undefined,
        sendDataToRelay: (data, ip, port) => this.#relay!.send(data, ip, port),
        onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
        onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
        onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
        onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
        onVideoFrame: (frame) => this.#activeCall?._emitVideo(frame),
        onVideoCaptureStart: (req) => this.#activeCall?._videoCapture(req),
        onVideoCaptureStop: (kind) => this.#activeCall?._videoCapture(null, kind),
        onAudioPlaybackStart: () => this.#activeCall?._mediaStarted("playback"),
        cryptoHkdf: computeHkdf,
        hmacSha256: computeHmacSha256,
      },
    });

    await this.#engine.initialize();
    this.#signaling.attachEngine(this.#engine);

    const selfPnJid = this.#sock.authState.creds.me?.id;
    const selfLidJid = this.#sock.authState.creds.me?.lid;
    this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
    await this.#engine.waitForVoipStackReady();
    try { this.#engine.updateNetworkMedium(2, 0); } catch {}

    this.#sock.ws.on("CB:call", (node: any) => {
      this.#signaling!.processIncomingCall(node, this.#engine!, this.#activeCall?.callId ?? "");
    });
    this.#sock.ws.on("CB:receipt", (node: any) => {
      if (!isCallReceiptNode(node)) return;
      this.#signaling!.processIncomingReceipt(node, this.#engine!, this.#activeCall?.callId ?? "");
    });
  };

  /** Place an outbound voice call. */
  call = async (
    phoneNumber: string,
    opts: { audioSource?: string; durationMs?: number; video?: boolean } = {},
  ): Promise<ActiveCall> => {
    if (!this.#engine || !this.#signaling) throw new Error("Not connected. Call connect() first.");
    if (this.#activeCall) throw new Error("A call is already active.");

    const durationMs = opts.durationMs ?? 120_000;
    const audioSource = opts.audioSource ?? "silence";

    const { number: targetNumber, pnJid: targetPnJid, lid: peerLid } =
      await this.#resolveTarget(phoneNumber.replace(/\D/g, ""));

    for (const jid of [targetPnJid, peerLid]) {
      try { await this.#sock.presenceSubscribe(jid); } catch {}
    }
    await new Promise((r) => setTimeout(r, 750));

    const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
    const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];

    await this.#signaling.ensureSessionsForPeers(deviceList);

    await new Promise((r) => setTimeout(r, 500));
    await this.#signaling.issueTcToken(peerLid);
    const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);

    const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();

    const call = new ActiveCall(callId, this.#engine, durationMs);
    call._audioSource = audioSource;
    call.remoteNumber = targetNumber;
    call.isVideo = !!opts.video;
    this.#trackCall(call);

    this.#engine.startCall({
      peerJid: peerLid,
      peerPn: targetPnJid,
      peerList: deviceList,
      callId,
      isVideo: !!opts.video,
      isLidCall: true,
      isFromDialer: false,
      extraData: tcToken,
    });

    return call;
  };

  /**
   * Unlink this device from the WhatsApp account (it disappears from
   * "Linked devices" on the phone), then tear everything down. The auth state
   * becomes useless afterwards — delete `authDir` before connecting again.
   * Note: the WASM stack can't be re-initialised in the same process, so start
   * a new process to pair again.
   */
  logout = async (): Promise<void> => {
    this.#activeCall?.end();
    try { await this.#sock?.logout?.(); } finally { this.disconnect(); }
  };

  /** Tear down the WhatsApp socket and release resources. */
  disconnect = (): void => {
    this.#activeCall?._forceEnd("disconnect");
    this.#activeCall = null;
    this.#relay?.closeAll();
    this.#engine?.destroy();
    this.#sock?.end?.();
    this.#engine = null;
    this.#relay = null;
    this.#signaling = null;
    this.#sock = null;
  };

  // ─── private ──────────────────────────────────────────────────────────────

  /**
   * Find the WhatsApp account behind a phone number. Brazilian mobiles may be
   * registered with or without the extra 9th digit, so both forms are tried.
   */
  #resolveTarget = async (digits: string): Promise<{ number: string; pnJid: string; lid: string }> => {
    const candidates = phoneNumberCandidates(digits);
    for (const candidate of candidates) {
      let pnJid = `${candidate}@s.whatsapp.net`;
      try {
        const [result] = (await this.#sock.onWhatsApp(pnJid)) ?? [];
        if (result && !result.exists) {
          debug(`${candidate} is not on WhatsApp`);
          continue;
        }
        if (result?.jid) pnJid = toBareJid(String(result.jid));
      } catch (err: any) {
        debug(`onWhatsApp(${candidate}) failed: ${err?.message ?? err}`);
      }
      const lid = await this.#signaling!.resolveLid(pnJid).catch(() => undefined);
      if (lid) {
        const number = pnJid.split("@")[0];
        if (number !== digits) debug(`dialing ${number} instead of ${digits}`);
        return { number, pnJid, lid };
      }
      debug(`could not resolve LID for ${pnJid}`);
    }
    throw new Error(
      `O número ${digits} não foi encontrado no WhatsApp` +
      (candidates.length > 1 ? ` (tentado também ${candidates.slice(1).join(", ")})` : ""),
    );
  };

  #trackCall = (call: ActiveCall): void => {
    this.#activeCall = call;
    call.once("ended", () => {
      if (this.#activeCall === call) this.#activeCall = null;
    });
  };

  #handleIncomingOffer = (offer: IncomingOfferInfo): void => {
    debug(`incoming offer call=${offer.callId} creator=${offer.callCreator} pn=${offer.callerPn ?? "-"} offline=${offer.offline}`);
    if (!this.#engine || !offer.callId) return;
    const info: IncomingCallInfo = {
      callId: offer.callId,
      from: offer.callCreator || offer.peerJid,
      fromPhone: offer.callerPn ? offer.callerPn.split("@")[0].split(":")[0] : undefined,
      pushName: offer.notify,
      isVideo: offer.isVideo,
      offline: offer.offline,
    };
    const current = this.#activeCall;
    if (current) {
      // Same call re-offered (retransmit) — nothing to do.
      if (current.callId !== offer.callId) this.emit("busy", info);
      return;
    }
    if (offer.offline) return; // stale offer delivered after reconnect

    const call = new ActiveCall(
      offer.callId,
      this.#engine,
      this.#config.incomingDurationMs ?? 0,
      "incoming",
      info,
    );
    call._audioSource = this.#config.incomingAudioSource ?? "stream";
    call.isVideo = !!offer.isVideo;
    this.#trackCall(call);
    // Let the WASM process the offer first so accept()/reject() have a call context.
    setImmediate(() => { if (!call.ended) this.emit("incoming", call); });
  };

  /**
   * The peer hung up. The WASM normally moves the call to Ending; in video calls it sometimes
   * never does, leaving the call "connected" forever. If it hasn't ended shortly after the
   * peer's terminate, end it here and reset the WASM call state.
   */
  #handlePeerTerminate = (callId: string): void => {
    const call = this.#activeCall;
    if (!call || call.callId !== callId) return;
    setTimeout(() => {
      if (call.ended || this.#activeCall !== call) return;
      debug(`call=${callId} peer terminated but the WASM did not end it; ending locally`);
      try { this.#engine?.endCall(0, false); } catch {}
      call._forceEnd("remote_end");
    }, 2500);
  };

  #handleCallEvent = (eventType: number, eventData?: string): void => {
    if (eventType !== 156) debug(`wasm event ${eventType}${eventData ? ` ${eventData.slice(0, 300)}` : ""}`);
    if (eventType === 16 && eventData) {
      try {
        const parsed = JSON.parse(eventData);
        const info = parsed.call_info ?? parsed.callInfo ?? {};
        const callState = Number(info.call_state ?? info.callState ?? 0);
        this.#activeCall?._updateState(callState);
      } catch {}
    } else if (eventType === 156 && eventData) {
      try {
        const update = JSON.parse(eventData) as RelayListUpdatePayload;
        this.#relay?.updateRelayList(update);
      } catch {}
    } else if (eventType === 2) {
      // For inbound calls the WASM fires event 2 right after the offer creates
      // the call (state ReceivedCall) — it is not an end signal there. The real
      // end arrives as a state change to Idle/Ending, handled above.
      if (this.#activeCall?.direction === "outgoing") this.#activeCall._forceEnd("remote_end");
    }
  };

  #handleAudioCaptureInit = (config: {
    sampleRate: number; channels: number; bitsPerSample: number; framesPerChunk: number;
  }): void => {
    if (!this.#engine) return;
    this.#captureSampleRate = config.sampleRate || 16000;
    this.#captureChannels = config.channels || 1;
    this.#captureFramesPerChunk = config.framesPerChunk || 320;
    const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
    this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
  };

  #handleAudioCaptureStart = (): void => {
    this.#activeCall?._mediaStarted("capture");
    if (!this.#engine || !this.#capturePtr) return;
    const audioSource = this.#activeCall?._audioSource ?? "silence";
    this.#feeder = new AudioFeeder(
      this.#captureSampleRate,
      this.#captureChannels,
      this.#captureFramesPerChunk,
      (chunk) => {
        if (this.#engine && this.#capturePtr) this.#engine.sendAudioData(chunk, this.#capturePtr);
      },
      audioSource,
    );
    this.#feeder.start();
    this.#activeCall?._attachFeeder(this.#feeder);
  };

  #handleAudioCaptureStop = (): void => {
    this.#activeCall?._attachFeeder(null);
    this.#feeder?.stop();
    this.#feeder = null;
    if (this.#engine && this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
      this.#capturePtr = 0;
    }
  };
}
