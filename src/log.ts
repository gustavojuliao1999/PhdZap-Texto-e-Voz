const ts = (): string => new Date().toISOString().slice(11, 23);
const prefix = process.env.LOG_PREFIX ? `${process.env.LOG_PREFIX} ` : "";
/** LOG_FORMAT=json: uma linha JSON por evento (para Loki, Datadog, CloudWatch…). */
const json = process.env.LOG_FORMAT === "json";
const line = process.env.LOG_PREFIX?.replace(/^\[|\]$/g, "");

const text = (a: unknown): string => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a));

const write = (level: "info" | "warn" | "error", args: unknown[]): void => {
  const out = level === "info" ? console.log : level === "warn" ? console.warn : console.error;
  if (json) {
    out(JSON.stringify({ time: new Date().toISOString(), level, ...(line ? { line } : {}), msg: args.map(text).join(" ") }));
    return;
  }
  out(ts(), level === "info" ? "INFO " : level === "warn" ? "WARN " : "ERROR", prefix + String(args[0]), ...args.slice(1));
};

export const log = {
  info: (...args: unknown[]): void => write("info", args),
  warn: (...args: unknown[]): void => write("warn", args),
  error: (...args: unknown[]): void => write("error", args),
};
