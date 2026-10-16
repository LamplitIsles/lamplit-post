import { Logger } from "@koishijs/core";
const categories = new Set([
  "app",
  "loader",
  "market",
  "auth",
  "analytics",
  "server",
  "console",
  "logger",
  "post",
]);
const events = new Set([
  "application_ready",
  "application_stopping",
  "configuration_restart",
  "package_install_started",
  "package_install_succeeded",
  "package_install_failed",
]);
/** Reconstruct records from bounded enums. No raw content, metadata, args or errors survive. */
export function safeRecord(record: Logger.Record): Logger.Record {
  const name = categories.has(record.name) ? record.name : "plugin";
  const type = ["debug", "info", "warn", "error", "success"].includes(
    record.type,
  )
    ? record.type
    : "warn";
  return {
    id: Number.isSafeInteger(record.id) && record.id >= 0 ? record.id : 0,
    timestamp:
      Number.isFinite(record.timestamp) &&
      Math.abs(record.timestamp) <= 8640000000000000
        ? record.timestamp
        : Date.now(),
    type,
    level: type === "error" ? 1 : type === "debug" ? 3 : 2,
    name,
    content:
      record.name === "post" && events.has(record.content)
        ? record.content
        : `${name}: ${type}`,
    meta: {},
  };
}
/** Logger's public target registry is the common input seam, including future targets. */
export function installSafeLogging() {
  const wrapped = new WeakSet<Logger.Target>();
  Logger.targets = new Proxy([] as Logger.Target[], {
    set(target, key, value) {
      if (key !== "length" && value && !wrapped.has(value)) {
        wrapped.add(value);
        const record = value.record;
        value.record = (input: Logger.Record) =>
          record.call(value, safeRecord(input));
      }
      return Reflect.set(target, key, value);
    },
  });
}
export function safeLog(
  event:
    | "application_ready"
    | "application_stopping"
    | "configuration_restart"
    | "package_install_started"
    | "package_install_succeeded"
    | "package_install_failed",
) {
  new Logger("post").info(event);
}
