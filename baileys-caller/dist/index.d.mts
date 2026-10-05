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
import { WasmEngine } from "./wasm-engine.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { CallState, type VoipSdkConfig, type CallDirection, type IncomingCallInfo, type VideoFrame, type VideoCaptureRequest } from "./types.mjs";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig, CallDirection, IncomingCallInfo, VideoFrame, VideoCaptureRequest, } from "./types.mjs";
export { CallState, VideoFormat, VideoOrientation } from "./types.mjs";
/**
 * Numbers to try for a dial string. Brazil (+55) mobiles gained a leading 9 in
 * 2012–2016, but many WhatsApp accounts are still registered without it (and a
 * few the other way round), so try the alternate form too.
 */
export declare const phoneNumberCandidates: (digits: string) => string[];
/** A live or recently-ended call. */
export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;
    readonly direction: CallDirection;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource: string;
    /** Set for inbound calls. */
    readonly incoming: IncomingCallInfo | null;
    /** Outbound: the number actually dialed (may differ from the input, e.g. BR 9th digit). */
    remoteNumber?: string;
    constructor(callId: string, engine: WasmEngine, durationMs: number, direction?: CallDirection, incoming?: IncomingCallInfo | null);
    get state(): CallState;
    get ended(): boolean;
    /** Answer a ringing inbound call (`camera`: answer sending video). */
    accept: (opts?: {
        camera?: boolean;
    }) => void;
    /** Current capture the WASM asked for (null = not sending video). */
    videoCapture: VideoCaptureRequest | null;
    /** Turn our camera on: a voice call is upgraded to video first. */
    startCamera: () => void;
    stopCamera: () => void;
    /** Share the screen (frames go with `sendVideoFrame` while `videoCapture.kind === "screen"`). */
    startScreenShare: (width: number, height: number) => void;
    stopScreenShare: () => void;
    /** Send one raw frame (NV12 by default) for the current capture. */
    sendVideoFrame: (data: Uint8Array, width: number, height: number, format?: number) => void;
    /** Video call (offered/answered with video, or upgraded). */
    isVideo: boolean;
    /** @internal */
    _videoCapture: (req: VideoCaptureRequest | null, kind?: "camera" | "screen") => void;
    /** Decline a ringing inbound call. */
    reject: () => void;
    /**
     * Send PCM to the peer (Float32 in [-1, 1], 16 kHz mono). Only works when
     * the call was created with `audioSource: "stream"`. Audio pushed before the
     * uplink opens is buffered.
     */
    sendAudio: (pcm: Float32Array) => void;
    /** Discard queued outbound audio (barge-in). */
    clearAudio: () => void;
    /** Milliseconds of outbound audio still queued. */
    get queuedAudioMs(): number;
    end: () => void;
    mute: (muted: boolean) => void;
    waitForEnd: () => Promise<string>;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState: (state: number) => void;
    /**
     * @internal — media started flowing (capture/playback opened by the WASM).
     * For an answered inbound call that proves the call is up even if the
     * "Active" state event never arrives, so report it as connected.
     */
    _mediaStarted: (source: string) => void;
    /** @internal — the WASM reuses its playback buffer, so hand out a copy. */
    _emitAudio: (pcm: Float32Array) => void;
    /** @internal */
    _emitVideo: (frame: VideoFrame) => void;
    /** @internal */
    _attachFeeder: (feeder: AudioFeeder | null) => void;
    /** @internal */
    _forceEnd: (reason: string) => void;
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
export declare class VoipClient extends EventEmitter {
    #private;
    constructor(config: VoipSdkConfig);
    /** JID of the linked account once connected (e.g. `5511999999999:12@s.whatsapp.net`). */
    get selfJid(): string | undefined;
    /**
     * The underlying Baileys socket (null until connected). Use it for messages
     * and anything else besides calls — never open a second socket with the same
     * auth, WhatsApp keeps only one connection per linked device.
     */
    get socket(): any;
    /** The loaded Baileys module (helpers such as `downloadMediaMessage`). */
    get baileys(): any;
    /** The call currently in progress (or ringing), if any. */
    get activeCall(): ActiveCall | null;
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect: () => Promise<void>;
    /** Place an outbound voice call. */
    call: (phoneNumber: string, opts?: {
        audioSource?: string;
        durationMs?: number;
        video?: boolean;
    }) => Promise<ActiveCall>;
    /**
     * Unlink this device from the WhatsApp account (it disappears from
     * "Linked devices" on the phone), then tear everything down. The auth state
     * becomes useless afterwards — delete `authDir` before connecting again.
     * Note: the WASM stack can't be re-initialised in the same process, so start
     * a new process to pair again.
     */
    logout: () => Promise<void>;
    /** Tear down the WhatsApp socket and release resources. */
    disconnect: () => void;
}
