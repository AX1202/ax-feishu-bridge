import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseGroupKeywords } from "./group-trigger.js";
import { applyRuntimeOverrides, getRuntimeOverrides } from "./runtime-config.js";
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
  | "domain"
  | "groupPolicy"
  | "groupKeywords"
  | "groupAlsoOnReply"
  | "ignoreBotMessages"
  | "cardActionMode"
  | "cardActionWebhookHost"
  | "cardActionWebhookPort"
  | "cardActionWebhookPath"
  | "language"
  | "reactEmoji"
  | "autoStart"
  | "parseInteractiveCards"
  | "includeQuotedMessage"
  | "quotedMessageMaxChars"
  | "promptNotifySec"
  | "promptTimeoutSec"
  | "sendMaxRetries"
  | "streamingReply"
  | "streamPrintFrequencyMs"
  | "streamPrintStep"
  | "streamPushIntervalMs"
  | "streamFlushMs"
  | "streamFirstFlushMs"
  | "streamMinChars"
  | "streamMaxBodyChars"
> = {
  domain: "feishu",
  groupPolicy: "open",
  groupKeywords: [],
  groupAlsoOnReply: false,
  ignoreBotMessages: true,
  cardActionMode: "webhook",
  cardActionWebhookHost: "0.0.0.0",
  cardActionWebhookPort: 3001,
  cardActionWebhookPath: "/webhook/card",
  language: "zh",
  reactEmoji: "Get",
  autoStart: true,
  parseInteractiveCards: true,
  includeQuotedMessage: true,
  quotedMessageMaxChars: 8000,
  promptNotifySec: 180,
  promptTimeoutSec: 0,
  sendMaxRetries: 2,
  streamingReply: true,
  // CardKit 客户端逐字打印
  streamPrintFrequencyMs: 50,
  streamPrintStep: 1,
  streamPushIntervalMs: 120,
  // 兼容旧 message.patch 参数（CardKit 路径基本忽略）
  streamFlushMs: 350,
  streamFirstFlushMs: 50,
  streamMinChars: 8,
  streamMaxBodyChars: 12000,
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
  try {
    chmodSync(path, 0o600);
  } catch {}
}

export function removePath(path: string) {
  rmSync(path, { recursive: true, force: true });
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseEnvSeconds(value: string | undefined) {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function applyRuntimeDefaults(cfg: FeishuConfig): FeishuConfig {
  return {
    ...cfg,
    groupKeywords: Array.isArray(cfg.groupKeywords)
      ? parseGroupKeywords(cfg.groupKeywords)
      : (cfg.groupKeywords ?? DEFAULT_CONFIG.groupKeywords),
    groupAlsoOnReply: cfg.groupAlsoOnReply ?? DEFAULT_CONFIG.groupAlsoOnReply,
    ignoreBotMessages: cfg.ignoreBotMessages ?? DEFAULT_CONFIG.ignoreBotMessages,
    parseInteractiveCards: cfg.parseInteractiveCards ?? DEFAULT_CONFIG.parseInteractiveCards,
    includeQuotedMessage: cfg.includeQuotedMessage ?? DEFAULT_CONFIG.includeQuotedMessage,
    quotedMessageMaxChars: cfg.quotedMessageMaxChars ?? DEFAULT_CONFIG.quotedMessageMaxChars,
    promptNotifySec: numberOr(cfg.promptNotifySec, DEFAULT_CONFIG.promptNotifySec!),
    promptTimeoutSec: numberOr(cfg.promptTimeoutSec, DEFAULT_CONFIG.promptTimeoutSec!),
    sendMaxRetries: cfg.sendMaxRetries ?? DEFAULT_CONFIG.sendMaxRetries,
    streamingReply: cfg.streamingReply ?? DEFAULT_CONFIG.streamingReply,
    streamPrintFrequencyMs: cfg.streamPrintFrequencyMs ?? DEFAULT_CONFIG.streamPrintFrequencyMs,
    streamPrintStep: cfg.streamPrintStep ?? DEFAULT_CONFIG.streamPrintStep,
    streamPushIntervalMs: cfg.streamPushIntervalMs ?? DEFAULT_CONFIG.streamPushIntervalMs,
    streamFlushMs: cfg.streamFlushMs ?? DEFAULT_CONFIG.streamFlushMs,
    streamFirstFlushMs: cfg.streamFirstFlushMs ?? DEFAULT_CONFIG.streamFirstFlushMs,
    streamMinChars: cfg.streamMinChars ?? DEFAULT_CONFIG.streamMinChars,
    streamMaxBodyChars: cfg.streamMaxBodyChars ?? DEFAULT_CONFIG.streamMaxBodyChars,
  };
}

export function loadConfig(): FeishuConfig | undefined {
  const base = loadBaseConfig();
  if (!base) return undefined;
  // runtime-overrides 覆盖 env/config 中的白名单字段（热更新 + 落盘）
  return applyRuntimeOverrides(base, getRuntimeOverrides());
}

/** 不含 runtime overrides 的基础配置（env 或 config.json） */
export function loadBaseConfig(): FeishuConfig | undefined {
  const envAppId = process.env.FEISHU_APP_ID?.trim();
  const envSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (envAppId && envSecret) {
    return applyRuntimeDefaults({
      appId: envAppId,
      appSecret: envSecret,
      domain: (process.env.FEISHU_DOMAIN as Domain) || DEFAULT_CONFIG.domain,
      groupPolicy: (process.env.FEISHU_GROUP_POLICY as GroupPolicy) || DEFAULT_CONFIG.groupPolicy,
      groupKeywords: parseGroupKeywords(process.env.FEISHU_GROUP_KEYWORDS),
      groupAlsoOnReply: parseBool(process.env.FEISHU_GROUP_ALSO_ON_REPLY, DEFAULT_CONFIG.groupAlsoOnReply!),
      ignoreBotMessages: parseBool(process.env.FEISHU_IGNORE_BOT_MESSAGES, DEFAULT_CONFIG.ignoreBotMessages!),
      cardActionMode: parseCardActionMode(process.env.FEISHU_CARD_ACTION_MODE) || DEFAULT_CONFIG.cardActionMode,
      cardActionWebhookHost: process.env.FEISHU_CARD_ACTION_WEBHOOK_HOST?.trim() || DEFAULT_CONFIG.cardActionWebhookHost,
      cardActionWebhookPort: parsePort(process.env.FEISHU_CARD_ACTION_WEBHOOK_PORT) ?? DEFAULT_CONFIG.cardActionWebhookPort,
      cardActionWebhookPath: normalizeWebhookPath(process.env.FEISHU_CARD_ACTION_WEBHOOK_PATH) || DEFAULT_CONFIG.cardActionWebhookPath,
      language: (process.env.FEISHU_LANGUAGE as "zh" | "en") || DEFAULT_CONFIG.language,
      reactEmoji: process.env.FEISHU_REACT_EMOJI || DEFAULT_CONFIG.reactEmoji,
      autoStart: process.env.FEISHU_AUTO_START ? process.env.FEISHU_AUTO_START !== "0" : DEFAULT_CONFIG.autoStart,
      parseInteractiveCards: parseBool(process.env.FEISHU_PARSE_INTERACTIVE_CARDS, DEFAULT_CONFIG.parseInteractiveCards!),
      includeQuotedMessage: parseBool(process.env.FEISHU_INCLUDE_QUOTED_MESSAGE, DEFAULT_CONFIG.includeQuotedMessage!),
      quotedMessageMaxChars: parsePositiveInt(process.env.FEISHU_QUOTED_MESSAGE_MAX_CHARS, DEFAULT_CONFIG.quotedMessageMaxChars!),
      promptNotifySec: parseEnvSeconds(process.env.FEISHU_PROMPT_NOTIFY_SEC) ?? DEFAULT_CONFIG.promptNotifySec!,
      promptTimeoutSec: parseEnvSeconds(process.env.FEISHU_PROMPT_TIMEOUT_SEC) ?? DEFAULT_CONFIG.promptTimeoutSec!,
      sendMaxRetries: parsePositiveInt(process.env.FEISHU_SEND_MAX_RETRIES, DEFAULT_CONFIG.sendMaxRetries!),
      streamingReply: parseBool(process.env.FEISHU_STREAMING_REPLY, DEFAULT_CONFIG.streamingReply!),
      streamPrintFrequencyMs: parsePositiveInt(process.env.FEISHU_STREAM_PRINT_FREQUENCY_MS, DEFAULT_CONFIG.streamPrintFrequencyMs!),
      streamPrintStep: parsePositiveInt(process.env.FEISHU_STREAM_PRINT_STEP, DEFAULT_CONFIG.streamPrintStep!),
      streamPushIntervalMs: parsePositiveInt(process.env.FEISHU_STREAM_PUSH_INTERVAL_MS, DEFAULT_CONFIG.streamPushIntervalMs!),
      streamFlushMs: parsePositiveInt(process.env.FEISHU_STREAM_FLUSH_MS, DEFAULT_CONFIG.streamFlushMs!),
      streamFirstFlushMs: parsePositiveInt(process.env.FEISHU_STREAM_FIRST_FLUSH_MS, DEFAULT_CONFIG.streamFirstFlushMs!),
      streamMinChars: parsePositiveInt(process.env.FEISHU_STREAM_MIN_CHARS, DEFAULT_CONFIG.streamMinChars!),
      streamMaxBodyChars: parsePositiveInt(process.env.FEISHU_STREAM_MAX_BODY_CHARS, DEFAULT_CONFIG.streamMaxBodyChars!),
    });
  }
  if (!existsSync(CONFIG_PATH)) return undefined;
  const cfg = readJson<Partial<FeishuConfig>>(CONFIG_PATH, {});
  if (!cfg.appId || !cfg.appSecret) return undefined;
  return applyRuntimeDefaults({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain || DEFAULT_CONFIG.domain,
    groupPolicy: cfg.groupPolicy || DEFAULT_CONFIG.groupPolicy,
    groupKeywords: parseGroupKeywords(cfg.groupKeywords),
    groupAlsoOnReply: parseBool(cfg.groupAlsoOnReply, DEFAULT_CONFIG.groupAlsoOnReply!),
    ignoreBotMessages: parseBool(cfg.ignoreBotMessages, DEFAULT_CONFIG.ignoreBotMessages!),
    cardActionMode: parseCardActionMode(cfg.cardActionMode) || DEFAULT_CONFIG.cardActionMode,
    cardActionWebhookHost: cfg.cardActionWebhookHost || DEFAULT_CONFIG.cardActionWebhookHost,
    cardActionWebhookPort: typeof cfg.cardActionWebhookPort === "number" ? cfg.cardActionWebhookPort : DEFAULT_CONFIG.cardActionWebhookPort,
    cardActionWebhookPath: normalizeWebhookPath(cfg.cardActionWebhookPath) || DEFAULT_CONFIG.cardActionWebhookPath,
    language: cfg.language || DEFAULT_CONFIG.language,
    reactEmoji: cfg.reactEmoji || DEFAULT_CONFIG.reactEmoji,
    autoStart: cfg.autoStart ?? DEFAULT_CONFIG.autoStart,
    parseInteractiveCards: cfg.parseInteractiveCards,
    includeQuotedMessage: cfg.includeQuotedMessage,
    quotedMessageMaxChars: cfg.quotedMessageMaxChars,
    promptNotifySec: numberOr(cfg.promptNotifySec, DEFAULT_CONFIG.promptNotifySec!),
    promptTimeoutSec: numberOr(cfg.promptTimeoutSec, DEFAULT_CONFIG.promptTimeoutSec!),
    sendMaxRetries: cfg.sendMaxRetries,
    streamingReply: cfg.streamingReply,
    streamPrintFrequencyMs: cfg.streamPrintFrequencyMs,
    streamPrintStep: cfg.streamPrintStep,
    streamPushIntervalMs: cfg.streamPushIntervalMs,
    streamFlushMs: cfg.streamFlushMs,
    streamFirstFlushMs: cfg.streamFirstFlushMs,
    streamMinChars: cfg.streamMinChars,
    streamMaxBodyChars: cfg.streamMaxBodyChars,
  });
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
