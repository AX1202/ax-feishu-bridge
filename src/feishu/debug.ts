import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { ensureRoot, getRuntimeSource } from "./config.ts";

const MAX_VALUE_LENGTH = 1200;
const MAX_LOG_LINES = 1000;
const TRIM_TRIGGER_LINES = 1200;

function debugLogPath() {
  return getRuntimeSource().debugLogPath;
}

export function debugLog(event: string, details?: Record<string, unknown>) {
  try {
    ensureRoot();
    const path = debugLogPath();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...(details ? { details: truncate(details) } : {}),
    });
    appendFileSync(path, `${line}\n`, "utf8");
    trimDebugLogIfNeeded(path);
  } catch {
    // Debug logging must never break message handling.
  }
}

function trimDebugLogIfNeeded(path: string) {
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  const hasTrailingNewline = lines[lines.length - 1] === "";
  const effectiveLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
  if (effectiveLines.length <= TRIM_TRIGGER_LINES) return;
  const recent = effectiveLines.slice(-MAX_LOG_LINES);
  writeFileSync(path, `${recent.join("\n")}\n`, "utf8");
}

function truncate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}...` : value;
  }
  if (Array.isArray(value)) return value.map((item) => truncate(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = truncate(item);
    }
    return out;
  }
  return value;
}
