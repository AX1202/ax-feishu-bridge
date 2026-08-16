/**
 * Agent Runtime 解耦层：
 * 飞书公共代码只依赖本文件的 ConversationRuntime 接口与公共类型，
 * 不直接依赖任何具体的 Agent Runtime（Pi / DeepSeek Harness）。
 * 各 Runtime 的具体实现位于 src/adapters/ 下。
 */
import type { FeishuImageInput } from "./attachments.ts";
import type { ResumeScope, ResumeSessionPage } from "./cards.ts";
import type { ReplyCardSink } from "./reply-card.ts";
import type { ThinkingStatus } from "./thinking.ts";

/** 平台无关的模型信息（由各 Runtime 转换而来，禁止原生 Model 对象泄漏到飞书层）。 */
export type RuntimeModel = {
  provider: string;
  id: string;
  name?: string;
  /** 该模型是否支持图片输入 */
  supportsImage?: boolean;
};

/** 会话运行状态（/status 命令使用）。 */
export type ConversationStatus = {
  cwd: string;
  hasActiveRun: boolean;
  activeStopped: boolean;
};

/** 上下文占用信息（/status 命令使用）。 */
export type ContextUsage = {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
};

export type StopConversationResult =
  | { status: "stopped"; message: string; body: string }
  | { status: "not_running"; message: string }
  | { status: "stale"; message: string }
  | { status: "failed"; message: string };

export type ConversationTimeouts = {
  /** Seconds before a long-running turn sends a non-fatal notice (0 disables). */
  promptNotifySec?: number;
  /** Hard prompt timeout in seconds; 0 waits indefinitely. */
  promptTimeoutSec?: number;
};

/**
 * 飞书消息处理器与卡片回调依赖的 Runtime 能力面。
 * 一个飞书会话 key 对应一个 Runtime 内部会话；
 * key 之外的内部状态（会话句柄、模型、工作区）由实现自行管理。
 */
export interface ConversationRuntime {
  prompt(
    key: string,
    userText: string,
    onReply: (text: string) => Promise<void>,
    onDelta?: (delta: string) => void,
  ): Promise<void>;

  promptWithImages(
    key: string,
    userText: string,
    images: FeishuImageInput[],
    onReply: (text: string) => Promise<void>,
    status?: ReplyCardSink,
    onDelta?: (delta: string) => void,
  ): Promise<void>;

  /** 供 /status 使用 */
  getStatus(key: string): ConversationStatus;

  getActualModel(key: string): Promise<string>;

  getThinkingStatus(key: string): Promise<ThinkingStatus>;

  getContextStatus(key: string): Promise<ContextUsage | null>;

  stopConversation(key: string, onReply: (text: string) => Promise<void>, runId?: string): Promise<StopConversationResult>;

  newConversation(key: string, onReply: (text: string) => Promise<void>): Promise<void>;

  listResumeSessions(key: string, scope: ResumeScope, page: number): Promise<ResumeSessionPage>;

  /**
   * 切换到历史会话。sessionRef 是不透明引用（来自 listResumeSessions 的 item.path），
   * 具体含义（Pi 会话文件路径 / Harness SessionId）由实现解释。
   */
  resumeConversation(key: string, sessionRef: string, onReply: (text: string) => Promise<void>): Promise<void>;

  selectModel(key: string, provider: string, modelId: string, onReply: (text: string) => Promise<void>): Promise<void>;

  selectThinkingLevel(key: string, level: string, onReply: (text: string) => Promise<void>): Promise<void>;

  getWorkspace(key: string): string;

  switchWorkspace(key: string, workspaceInput: string | undefined, onReply: (text: string) => Promise<void>): Promise<void>;

  getAvailableModels(): Promise<RuntimeModel[]>;

  getSelectedModel(key: string): Promise<RuntimeModel | undefined>;

  resetMemory(): void;
}
