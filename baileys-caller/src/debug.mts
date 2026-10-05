/**
 * Diagnostic logging, enabled with `VOIP_DEBUG=1` (or `VOIP_DEBUG=wasm` to also
 * include the WASM stack's own logs, which are very verbose).
 *
 * @author ShellTear
 */
const flag = (process.env.VOIP_DEBUG ?? "").toLowerCase();

export const DEBUG = flag !== "" && flag !== "0" && flag !== "false";
export const DEBUG_WASM = flag === "wasm" || flag === "all";

export const debug = (...args: unknown[]): void => {
  if (DEBUG) console.log(new Date().toISOString().slice(11, 23), "[voip]", ...args);
};
