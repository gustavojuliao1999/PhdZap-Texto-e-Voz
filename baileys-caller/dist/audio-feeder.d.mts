export declare class AudioFeeder {
    #private;
    private readonly sampleRate;
    private readonly channels;
    private readonly framesPerChunk;
    private readonly onChunk;
    private readonly source;
    droppedChunks: number;
    underflowChunks: number;
    bytesProduced: number;
    chunksEmitted: number;
    constructor(sampleRate: number, channels: number, framesPerChunk: number, onChunk: (chunk: Float32Array) => void, source?: string);
    get isStream(): boolean;
    /** Milliseconds of audio queued but not yet sent. */
    get queuedMs(): number;
    start: () => void;
    /** Queue PCM (Float32, negotiated rate/channels) for the uplink. Stream mode only. */
    push: (pcm: Float32Array) => void;
    /** Drop everything queued (e.g. caller barged in while the bot was talking). */
    clear: () => void;
    stop: () => void;
}
