/**
 * Signaling bridge.
 *
 * Glues the WASM VoIP stack to Baileys: encrypts outbound `offer` / `enc_rekey`
 * stanzas, decrypts inbound ones, manages TC tokens, multi-device JID routing,
 * and signal-session refresh.
 *
 * @author ShellTear
 */
export type BaileysSocket = {
    authState: any;
    signalRepository: any;
    generateMessageTag: () => string;
    query: (node: any) => Promise<any>;
    sendNode: (node: any) => Promise<void>;
    waitForMessage: (tag: string, timeoutMs: number) => Promise<any>;
    getUSyncDevices: (jids: string[], ignoreZeroDevices: boolean, forceQuery: boolean) => Promise<any[]>;
    presenceSubscribe: (jid: string) => Promise<void>;
    ws: any;
    ev: any;
};
/** Metadata of an inbound `offer` stanza, surfaced before it reaches the WASM. */
export type IncomingOfferInfo = {
    callId: string;
    /** JID that sent the offer (usually `<lid>:<device>@lid`). */
    peerJid: string;
    /** `call-creator` attr — the caller's account JID. */
    callCreator: string;
    /** Caller phone-number JID when WhatsApp includes it (`caller_pn`). */
    callerPn?: string;
    /** Push name when present (`notify`). */
    notify?: string;
    isVideo: boolean;
    offline: boolean;
};
export type SignalingBridgeConfig = {
    sock: BaileysSocket;
    /** Called for every inbound offer, right before it is handed to the WASM. */
    onIncomingOffer?: (info: IncomingOfferInfo) => void;
    /** The peer ended (terminate) or declined (reject) a call. */
    onPeerTerminate?: (callId: string) => void;
};
export declare class SignalingBridge {
    #private;
    constructor(config: SignalingBridgeConfig);
    /** Hand the WASM engine in so we can dispatch ack callbacks back to it. */
    attachEngine: (voip: any) => void;
    init: () => Promise<void>;
    sendSignaling: (peerJid: string, callId: string, xmlPayload: Uint8Array) => void;
    processIncomingCall: (node: any, voip: any, activeCallId: string) => void;
    processIncomingReceipt: (node: any, voip: any, activeCallId: string) => void;
    requestTcToken: (jid: string) => Promise<Uint8Array | undefined>;
    ensureTcToken: (...jids: string[]) => Promise<Uint8Array | undefined>;
    discoverPeerDevices: (peerLidJid: string) => Promise<string[]>;
    ensureSessionsForPeers: (jids: string[]) => Promise<void>;
    resolveLid: (pnJid: string) => Promise<string | undefined>;
    issueTcToken: (jid: string) => Promise<boolean>;
    getRemoteDeviceJid: (callId: string) => string | undefined;
}
