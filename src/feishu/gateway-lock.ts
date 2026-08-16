import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { debugLog } from "./debug.js";

const LOCK_KEY = "pi-feishu-lark.feishu-gateway";
const LOCKS_PATH = join(homedir(), ".pi", "agent", "locks.json");
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 40;
const HEARTBEAT_MS = 5_000;

export type GatewayOwner = {
  key: typeof LOCK_KEY;
  pid: number;
  token: string;
  cwd: string;
  startedAt: string;
  heartbeatAt: string;
  status: "starting" | "connected" | "disconnected";
};

type LocksFile = Record<string, unknown>;

export type GatewayLockResult =
  | { status: "acquired"; handle: GatewayLockHandle }
  | { status: "busy"; owner: GatewayOwner };

export class GatewayLockHandle {
  private heartbeat: NodeJS.Timeout | undefined;
  private onLost: (() => void | Promise<void>) | undefined;

  constructor(readonly owner: GatewayOwner) {}

  setOnLost(handler: () => void | Promise<void>) {
    this.onLost = handler;
  }

  startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.update("connected").catch((error) => {
        debugLog("feishu.gateway.heartbeat_error", { error: error instanceof Error ? error.message : String(error) });
      });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  async update(status: GatewayOwner["status"]) {
    let lostOwnership = false;
    await withLocksFileLock(() => {
      const locks = readLocksFile();
      const current = asGatewayOwner(locks[LOCK_KEY]);
      if (!current || current.token !== this.owner.token || current.pid !== this.owner.pid) {
        this.stopHeartbeat();
        lostOwnership = true;
        return;
      }
      const next: GatewayOwner = {
        ...current,
        heartbeatAt: new Date().toISOString(),
        status,
      };
      locks[LOCK_KEY] = next;
      writeLocksFile(locks);
    });
    if (lostOwnership) {
      debugLog("feishu.gateway.lock_lost", { pid: this.owner.pid });
      await this.onLost?.();
    }
  }

  async release() {
    this.stopHeartbeat();
    await withLocksFileLock(() => {
      const locks = readLocksFile();
      const current = asGatewayOwner(locks[LOCK_KEY]);
      if (current?.token === this.owner.token && current.pid === this.owner.pid) {
        delete locks[LOCK_KEY];
        writeLocksFile(locks);
        debugLog("feishu.gateway.lock_released", { pid: this.owner.pid });
      }
    });
  }

  private stopHeartbeat() {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

export async function acquireGatewayLock(cwd: string, force = false): Promise<GatewayLockResult> {
  return withLocksFileLock(() => {
    const locks = readLocksFile();
    const existing = asGatewayOwner(locks[LOCK_KEY]);
    if (existing && !force && !isStale(existing)) {
      debugLog("feishu.gateway.lock_busy", {
        ownerPid: existing.pid,
        heartbeatAt: existing.heartbeatAt,
        currentPid: process.pid,
      });
      return { status: "busy", owner: existing };
    }

    const owner: GatewayOwner = {
      key: LOCK_KEY,
      pid: process.pid,
      token: randomToken(),
      cwd,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "starting",
    };
    locks[LOCK_KEY] = owner;
    writeLocksFile(locks);
    debugLog("feishu.gateway.lock_acquired", {
      pid: owner.pid,
      cwd,
      replacedPid: existing?.pid,
      force,
    });
    return { status: "acquired", handle: new GatewayLockHandle(owner) };
  });
}

export function readGatewayOwner(): GatewayOwner | undefined {
  const owner = asGatewayOwner(readLocksFile()[LOCK_KEY]);
  return owner && !isStale(owner) ? owner : undefined;
}

export function gatewayLockPath() {
  return LOCKS_PATH;
}

function asGatewayOwner(value: unknown): GatewayOwner | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<GatewayOwner>;
  if (raw.key !== LOCK_KEY) return undefined;
  if (typeof raw.pid !== "number" || typeof raw.token !== "string") return undefined;
  if (typeof raw.cwd !== "string" || typeof raw.startedAt !== "string" || typeof raw.heartbeatAt !== "string") return undefined;
  if (raw.status !== "starting" && raw.status !== "connected" && raw.status !== "disconnected") return undefined;
  return raw as GatewayOwner;
}

function isStale(owner: GatewayOwner) {
  if (!isProcessAlive(owner.pid)) return true;
  const heartbeatAt = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatAt)) return true;
  return Date.now() - heartbeatAt > LOCK_STALE_MS;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function randomToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readLocksFile(): LocksFile {
  try {
    if (!existsSync(LOCKS_PATH)) return {};
    return JSON.parse(readFileSync(LOCKS_PATH, "utf8")) as LocksFile;
  } catch {
    return {};
  }
}

function writeLocksFile(locks: LocksFile) {
  mkdirSync(dirname(LOCKS_PATH), { recursive: true });
  writeFileSync(LOCKS_PATH, `${JSON.stringify(locks, null, 2)}\n`, "utf8");
}

async function withLocksFileLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const lockPath = `${LOCKS_PATH}.lock`;
  mkdirSync(dirname(LOCKS_PATH), { recursive: true });

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (tryAcquireFileLock(lockPath)) {
      try {
        return await fn();
      } finally {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
      }
    }
    await sleep(LOCK_RETRY_MS);
  }

  debugLog("feishu.gateway.file_lock_timeout", { lockPath });
  return await fn();
}

function tryAcquireFileLock(lockPath: string) {
  try {
    mkdirSync(lockPath);
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) rmSync(lockPath, { recursive: true, force: true });
    } catch {}
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
