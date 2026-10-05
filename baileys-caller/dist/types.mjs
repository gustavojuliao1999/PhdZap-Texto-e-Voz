/**
 * Shared type definitions for baileys-caller.
 *
 * @author ShellTear
 */
/** Pixel layout of a decoded video frame (WAWebVoipMediaEnums.WAWebVoipVideoFormat). */
export const VideoFormat = { NV12: 0, I420: 1, RGB24: 2, RGBA: 3, H264: 100 };
/** Rotation the renderer should apply (WAWebVoipMediaEnums orientation). */
export const VideoOrientation = { Unknown: 0, Normal: 1, Rotate90: 2, Rotate180: 3, Rotate270: 4 };
/** Mirrors the WhatsApp WASM `CallState` enum. */
export const CallState = {
    Idle: 0,
    Calling: 1,
    PreacceptReceived: 2,
    ReceivedCall: 3,
    AcceptSent: 4,
    AcceptReceived: 5,
    Active: 6,
    ActiveElsewhere: 7,
    Ending: 13,
};
