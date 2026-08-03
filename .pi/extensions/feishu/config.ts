import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CardActionMode, Domain, FeishuConfig, GroupPolicy } from "./types.js";

export const ROOT_DIR = join(homedir(), ".pi", "agent", "feishu");
export const CONFIG_PATH = join(ROOT_DIR, "config.json");
export const STATE_PATH = join(ROOT_DIR, "state.json");
export const DEBUG_LOG_PATH = join(ROOT_DIR, "debug.log");
export const DAEMON_LOG_PATH = join(ROOT_DIR, "daemon.log");
export const DEDUPE_PATH = join(ROOT_DIR, "dedupe.json");
export const BRIDGE_PATH = join(ROOT_DIR, "bridge.json");
export const CHILD_SESSION_ENV = "PI_FEISHU_CHILD_SESSION";

export const DEFAULT_CONFIG: Pick<
  FeishuConfig,
  "domain" | "groupPolicy" | "cardActionMode" | "cardActionWebhookHost" | "cardActionWebhookPort" | "cardActionWebhookPath" | "language" | "reactEmoji" | "autoStart" | "promptNotifySec" | "promptTimeoutSec"
> = {
  domain: "feishu",
  groupPolicy: "open",
  cardActionMode: "webhook",
  cardActionWebhookHost: "0.0.0.0",
  cardActionWebhookPort: 3001,
  cardActionWebhookPath: "/webhook/card",
  language: "zh",
  reactEmoji: "THUMBSUP",
  autoStart: true,
  promptNotifySec: 180,
  promptTimeoutSec: 0,
};

export function ensureRoot() {
  mkdirSync(ROOT_DIR, { recursive: true });
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try { chmodSync(path, 0o600); } catch {}
}

export function removePath(path: string) {
  rmSync(path, { recursive: true, force: true });
}

export function loadConfig(): FeishuConfig | undefined {
  const envAppId = process.env.FEISHU_APP_ID?.trim();
  const envSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (envAppId && envSecret) {
    return {
      appId: envAppId,
      appSecret: envSecret,
      domain: (process.env.FEISHU_DOMAIN as Domain) || DEFAULT_CONFIG.domain,
      groupPolicy: (process.env.FEISHU_GROUP_POLICY as GroupPolicy) || DEFAULT_CONFIG.groupPolicy,
      cardActionMode: parseCardActionMode(process.env.FEISHU_CARD_ACTION_MODE) || DEFAULT_CONFIG.cardActionMode,
      cardActionWebhookHost: process.env.FEISHU_CARD_ACTION_WEBHOOK_HOST?.trim() || DEFAULT_CONFIG.cardActionWebhookHost,
      cardActionWebhookPort: parsePort(process.env.FEISHU_CARD_ACTION_WEBHOOK_PORT) ?? DEFAULT_CONFIG.cardActionWebhookPort,
      cardActionWebhookPath: normalizeWebhookPath(process.env.FEISHU_CARD_ACTION_WEBHOOK_PATH) || DEFAULT_CONFIG.cardActionWebhookPath,
      language: (process.env.FEISHU_LANGUAGE as "zh" | "en") || DEFAULT_CONFIG.language,
      reactEmoji: process.env.FEISHU_REACT_EMOJI || DEFAULT_CONFIG.reactEmoji,
      autoStart: process.env.FEISHU_AUTO_START ? process.env.FEISHU_AUTO_START !== "0" : DEFAULT_CONFIG.autoStart,
      promptNotifySec: parseEnvSeconds(process.env.FEISHU_PROMPT_NOTIFY_SEC) ?? DEFAULT_CONFIG.promptNotifySec,
      promptTimeoutSec: parseEnvSeconds(process.env.FEISHU_PROMPT_TIMEOUT_SEC) ?? DEFAULT_CONFIG.promptTimeoutSec,
    };
  }
  if (!existsSync(CONFIG_PATH)) return undefined;
  const cfg = readJson<Partial<FeishuConfig>>(CONFIG_PATH, {});
  if (!cfg.appId || !cfg.appSecret) return undefined;
  return {
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain || DEFAULT_CONFIG.domain,
    groupPolicy: cfg.groupPolicy || DEFAULT_CONFIG.groupPolicy,
    cardActionMode: parseCardActionMode(cfg.cardActionMode) || DEFAULT_CONFIG.cardActionMode,
    cardActionWebhookHost: cfg.cardActionWebhookHost || DEFAULT_CONFIG.cardActionWebhookHost,
    cardActionWebhookPort: typeof cfg.cardActionWebhookPort === "number" ? cfg.cardActionWebhookPort : DEFAULT_CONFIG.cardActionWebhookPort,
    cardActionWebhookPath: normalizeWebhookPath(cfg.cardActionWebhookPath) || DEFAULT_CONFIG.cardActionWebhookPath,
    language: cfg.language || DEFAULT_CONFIG.language,
    reactEmoji: cfg.reactEmoji || DEFAULT_CONFIG.reactEmoji,
    autoStart: cfg.autoStart ?? DEFAULT_CONFIG.autoStart,
    promptNotifySec: numberOr(cfg.promptNotifySec, DEFAULT_CONFIG.promptNotifySec),
    promptTimeoutSec: numberOr(cfg.promptTimeoutSec, DEFAULT_CONFIG.promptTimeoutSec),
  };
}

function parseEnvSeconds(value: string | undefined) {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseCardActionMode(value: unknown): CardActionMode | undefined {
  if (value !== "webhook" && value !== "ws") return undefined;
  return value;
}

function parsePort(value: string | undefined) {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
  return port;
}

function normalizeWebhookPath(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function mask(s: string) {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}
