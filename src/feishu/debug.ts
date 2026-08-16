import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { DEBUG_LOG_PATH, ensureRoot } from "./config.js";

const MAX_VALUE_LENGTH = 1200;
const MAX_LOG_LINES = 1000;
const TRIM_TRIGGER_LINES = 1200;

export function debugLog(event: string, details?: Record<string, unknown>) {
  try {
    ensureRoot();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...(details ? { details: truncate(details) } : {}),
    });
    appendFileSync(DEBUG_LOG_PATH, `${line}\n`, "utf8");
    trimDebugLogIfNeeded();
  } catch {
    // Debug logging must never break message handling.
  }
}

function trimDebugLogIfNeeded() {
  const content = readFileSync(DEBUG_LOG_PATH, "utf8");
  const lines = content.split("\n");
  const hasTrailingNewline = lines[lines.length - 1] === "";
  const effectiveLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
  if (effectiveLines.length <= TRIM_TRIGGER_LINES) return;
  const recent = effectiveLines.slice(-MAX_LOG_LINES);
  writeFileSync(DEBUG_LOG_PATH, `${recent.join("\n")}\n`, "utf8");
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
