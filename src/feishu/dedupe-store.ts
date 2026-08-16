import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEDUPE_PATH, ensureRoot } from "./config.js";
import { debugLog } from "./debug.js";

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 40;

type DedupeStatus = "processing" | "replied" | "ignored" | "failed";

type DedupeRecord = {
  status: DedupeStatus;
  firstSeenAt: number;
  updatedAt: number;
  pid: number;
  error?: string;
};

type DedupeStore = {
  messages?: Record<string, DedupeRecord>;
};

export async function claimFeishuMessage(messageId: string): Promise<boolean> {
  if (!messageId) return true;

  return withStoreLock(() => {
    const now = Date.now();
    const store = readStore();
    const messages = store.messages || {};
    pruneExpired(messages, now);

    const existing = messages[messageId];
    if (existing) {
      existing.updatedAt = now;
      writeStore({ messages });
      debugLog("feishu.dedupe.ignored_message", {
        messageId,
        status: existing.status,
        firstSeenAt: new Date(existing.firstSeenAt).toISOString(),
        ownerPid: existing.pid,
        currentPid: process.pid,
      });
      return false;
    }

    messages[messageId] = {
      status: "processing",
      firstSeenAt: now,
      updatedAt: now,
      pid: process.pid,
    };
    writeStore({ messages });
    debugLog("feishu.dedupe.claimed_message", { messageId, pid: process.pid });
    return true;
  });
}

export async function markFeishuMessage(messageId: string, status: DedupeStatus, error?: string): Promise<void> {
  if (!messageId) return;

  await withStoreLock(() => {
    const now = Date.now();
    const store = readStore();
    const messages = store.messages || {};
    pruneExpired(messages, now);

    const existing = messages[messageId] || {
      status,
      firstSeenAt: now,
      updatedAt: now,
      pid: process.pid,
    };

    messages[messageId] = {
      ...existing,
      status,
      updatedAt: now,
      error: error ? error.slice(0, 500) : undefined,
    };
    writeStore({ messages });
  });
}

function readStore(): DedupeStore {
  try {
    if (!existsSync(DEDUPE_PATH)) return {};
    return JSON.parse(readFileSync(DEDUPE_PATH, "utf8")) as DedupeStore;
  } catch {
    return {};
  }
}

function writeStore(store: DedupeStore) {
  ensureRoot();
  writeFileSync(DEDUPE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function pruneExpired(messages: Record<string, DedupeRecord>, now: number) {
  for (const [messageId, record] of Object.entries(messages)) {
    if (!record.updatedAt || now - record.updatedAt > MESSAGE_TTL_MS) {
      delete messages[messageId];
    }
  }
}

async function withStoreLock<T>(fn: () => T | Promise<T>): Promise<T> {
  ensureRoot();
  const lockPath = `${DEDUPE_PATH}.lock`;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (tryAcquireLock(lockPath)) {
      try {
        return await fn();
      } finally {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
      }
    }
    await sleep(LOCK_RETRY_MS);
  }

  debugLog("feishu.dedupe.lock_timeout", { lockPath });
  return await fn();
}

function tryAcquireLock(lockPath: string) {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {}
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
