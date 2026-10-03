const ts = (): string => new Date().toISOString().slice(11, 23);
const prefix = process.env.LOG_PREFIX ? `${process.env.LOG_PREFIX} ` : "";

export const log = {
  info: (...args: unknown[]): void => console.log(ts(), "INFO ", prefix + String(args[0]), ...args.slice(1)),
  warn: (...args: unknown[]): void => console.warn(ts(), "WARN ", prefix + String(args[0]), ...args.slice(1)),
  error: (...args: unknown[]): void => console.error(ts(), "ERROR", prefix + String(args[0]), ...args.slice(1)),
};
