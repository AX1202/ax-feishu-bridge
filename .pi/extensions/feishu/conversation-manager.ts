import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { FeishuBridgeRuntime } from "./bridge-runtime.js";
import { CHILD_SESSION_ENV, ensureRoot, readJson, STATE_PATH, writeJson } from "./config.js";
import { debugLog } from "./debug.js";
import { waitForPrompt } from "./prompt-timeout.js";
import type { ResumeScope, ResumeSessionPage } from "./cards.js";
import type { ReplyCardSink } from "./reply-card.js";
import { normalizeThinkingLevels, type ThinkingStatus } from "./thinking.js";
import type { FeishuState } from "./types.js";

type ActiveRun = {
  session: AgentSession;
  runId?: string;
  stopped: boolean;
  status?: ReplyCardSink;
  /** 当前轮流式回调（由 promptWithImages 设置） */
  onDelta?: (delta: string) => void;
};

type ModelRuntimeAdapter = {
  getModel(provider: string, id: string): any;
  hasConfiguredAuth(model: any): boolean;
  getAvailable(): Promise<any[]>;
  sessionOptions: Record<string, unknown>;
};

export type ConversationTimeouts = {
  /** Seconds before a long-running turn sends a non-fatal notice (0 disables). */
  promptNotifySec?: number;
  /** Hard prompt timeout in seconds; 0 waits indefinitely. */
  promptTimeoutSec?: number;
};

export type StopConversationResult =
  | { status: "stopped"; message: string; body: string }
  | { status: "not_running"; message: string }
  | { status: "stale"; message: string }
  | { status: "failed"; message: string };

const RESUME_PAGE_SIZE = 10;

export class ConversationManager {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private modelRuntimePromise: Promise<ModelRuntimeAdapter> | undefined;
  private defaultProvider: string | undefined;
  private defaultModelId: string | undefined;
  private state: FeishuState;

  constructor(
    private readonly cwd: string,
    private readonly bridge?: FeishuBridgeRuntime,
    private readonly timeouts: ConversationTimeouts = {},
  ) {
    ensureRoot();
    this.state = readJson<FeishuState>(STATE_PATH, { sessions: {} });
    this.state.sessions ||= {};
    this.state.models ||= {};
    this.state.workspaces ||= {};
    this.loadSettingsDefault();
  }

  /** Read global settings default model for fallback in getSelectedModel. */
  private loadSettingsDefault() {
    try {
      const settingsPath = join(getAgentDir(), "settings.json");
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      if (settings.defaultProvider && settings.defaultModel) {
        this.defaultProvider = settings.defaultProvider;
        this.defaultModelId = settings.defaultModel;
      }
    } catch {}
  }

  async prompt(key: string, userText: string, onReply: (text: string) => Promise<void>, onDelta?: (delta: string) => void) {
    return this.promptWithImages(key, userText, [], onReply, undefined, onDelta);
  }

  async promptWithImages(
    key: string,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    onReply: (text: string) => Promise<void>,
    status?: ReplyCardSink,
    onDelta?: (delta: string) => void,
  ) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      debugLog("feishu.prompt.start", { key, textLength: userText.length, imageCount: images.length });
      const session = await this.getSession(key);
      const run: ActiveRun = { session, runId: status?.runId, stopped: false, status, onDelta };
      this.activeRuns.set(key, run);
      this.bridge?.beginFeishuInput(session.sessionId);
      // 流式走 session 级订阅（createSession 里）→ run.onDelta，避免漏事件
      let unsub: (() => void) | undefined;
      let deltaCount = 0;
      let deltaChars = 0;
      if (onDelta) {
        const userOnDelta = onDelta;
        run.onDelta = (delta: string) => {
          deltaCount += 1;
          deltaChars += delta.length;
          userOnDelta(delta);
        };
      }
      try {
        try {
          await this.runPromptWithTimeouts(session, userText, images, key, onReply, status);
        } catch (error) {
          if (run.stopped) {
            debugLog("feishu.prompt.stopped", { key });
            return;
          }
          throw error;
        }
      } finally {
        try { unsub?.(); } catch {}
        run.onDelta = undefined;
        if (this.activeRuns.get(key) === run) this.activeRuns.delete(key);
        this.bridge?.endFeishuInput(session.sessionId);
      }
      if (run.stopped) return;
      const answer = extractLastAssistantText(session);
      debugLog("feishu.prompt.done", {
        key,
        answerLength: answer.length,
        deltaCount,
        deltaChars,
      });
      await onReply(answer || "No response.");
      // onReply（ReplyCard.completeWithAnswer）已切到 done；此处仅兜底
      await status?.finish("done");
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.prompt.error", { key, error: message });
      // 错误也写进同一张卡；onReply 若已是 completeWithAnswer 会 no-op（status 非 running）
      if (status && "ensureFinal" in status && typeof (status as any).ensureFinal === "function") {
        (status as any).ensureFinal(`出错了：${message}`);
        await status.finish("failed", message);
      } else {
        await status?.finish("failed", message);
        await onReply(`Pi error: ${message}`);
      }
    });
    this.queues.set(key, next);
    await next;
  }

  /** 供 /status 使用 */
  getStatus(key: string) {
    const active = this.activeRuns.get(key);
    return {
      cwd: this.getWorkspace(key),
      hasActiveRun: Boolean(active),
      activeStopped: Boolean(active?.stopped),
      sessionFile: this.state.sessions[key],
    };
  }

  async getActualModel(key: string) {
    const model = await this.getSelectedModel(key);
    if (!model) return "默认模型";
    return `${(model as any).provider}/${(model as any).id}`;
  }

  /** 当前 Pi 会话的思考强度和该模型可用的档位。 */
  async getThinkingStatus(key: string): Promise<ThinkingStatus> {
    const session = await this.getSession(key);
    return this.getThinkingStatusForSession(session);
  }

  async getContextStatus(key: string) {
    try {
      const session = await this.getSession(key);
      const anySession = session as any;
      const tokens = anySession.contextTokens ?? anySession.tokenCount ?? null;
      const contextWindow = anySession.contextWindow ?? anySession.model?.contextWindow ?? null;
      const percent = tokens != null && contextWindow ? (Number(tokens) / Number(contextWindow)) * 100 : null;
      return { tokens: tokens != null ? Number(tokens) : null, contextWindow: contextWindow != null ? Number(contextWindow) : null, percent };
    } catch {
      return null;
    }
  }

  async stopConversation(key: string, onReply: (text: string) => Promise<void>, runId?: string): Promise<StopConversationResult> {
    const active = this.activeRuns.get(key);
    if (!active) {
      const message = "当前没有进行中的处理。";
      await onReply(message);
      return { status: "not_running", message };
    }
    if (runId && active.runId && active.runId !== runId) {
      const message = "这张任务卡片已不是当前进行中的任务。";
      await onReply(message);
      debugLog("feishu.prompt.stop_stale", { key, runId, activeRunId: active.runId });
      return { status: "stale", message };
    }

    active.stopped = true;
    const body = active.status?.bodyText || "";
    await active.status?.stopImmediately("已停止");
    try {
      await active.session.abort();
      debugLog("feishu.prompt.abort", { key });
      const message = "已停止";
      await onReply(message);
      return { status: "stopped", message, body };
    } catch (error) {
      active.stopped = false;
      debugLog("feishu.prompt.abort_error", { key, error: error instanceof Error ? error.message : String(error) });
      const message = "停止失败，请重试。";
      await onReply(message);
      return { status: "failed", message };
    }
  }

  async newConversation(key: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      delete this.state.sessions[key];
      writeJson(STATE_PATH, this.state);
      await onReply("已创建新会话。旧会话历史已保留，下一条消息会从新上下文开始。");
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async listResumeSessions(key: string, scope: ResumeScope, page: number): Promise<ResumeSessionPage> {
    const sessions = await this.getResumeSessions(key, scope);
    const normalizedPage = Math.max(0, Math.floor(page));
    const total = sessions.length;
    const totalPages = Math.max(1, Math.ceil(total / RESUME_PAGE_SIZE));
    const clampedPage = Math.min(normalizedPage, totalPages - 1);
    const currentSessionPath = this.normalizeSessionPath(this.state.sessions[key]);
    const start = clampedPage * RESUME_PAGE_SIZE;
    const items = sessions.slice(start, start + RESUME_PAGE_SIZE).map((session) => {
      const sessionPath = this.normalizeSessionPath(session.path) || session.path;
      return {
        path: session.path,
        title: session.name?.trim() || summarizeFirstMessage(session.firstMessage),
        subtitle: session.name?.trim()
          ? summarizeFirstMessage(session.firstMessage)
          : `消息数：${session.messageCount}`,
        modifiedLabel: formatModifiedLabel(session.modified),
        workspaceLabel: scope === "all" ? formatWorkspaceLabel(session.cwd) : undefined,
        isCurrent: Boolean(currentSessionPath && sessionPath && currentSessionPath === sessionPath),
      };
    });

    return {
      key,
      workspacePath: this.getWorkspace(key),
      scope,
      page: clampedPage,
      total,
      totalPages,
      items,
    };
  }

  async resumeConversation(key: string, sessionPathInput: string, onReply: (text: string) => Promise<void>) {
    if (this.activeRuns.has(key)) {
      await onReply("当前还有进行中的处理，请先发送 /stop，再切换历史会话。");
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const sessionPath = this.normalizeExistingSessionPath(sessionPathInput);
      const sessionInfo = await this.findSessionInfo(sessionPath);
      if (!sessionInfo) {
        await onReply("这条历史会话不存在，可能已经被删除。请重新打开 /resume 选择。");
        return;
      }

      const currentPath = this.normalizeSessionPath(this.state.sessions[key]);
      if (currentPath === sessionPath) {
        this.state.workspaces![key] = sessionInfo.cwd || this.getWorkspace(key);
        writeJson(STATE_PATH, this.state);
        await onReply(`你已经在这个历史会话里了。\n当前工作区：${this.state.workspaces![key]}`);
        return;
      }

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }

      this.sessions.delete(key);
      this.state.sessions[key] = sessionPath;
      this.state.workspaces![key] = sessionInfo.cwd || this.cwd;
      writeJson(STATE_PATH, this.state);
      await onReply([
        `已切换到历史会话：${sessionInfo.name?.trim() || summarizeFirstMessage(sessionInfo.firstMessage)}`,
        `工作区：${this.state.workspaces![key]}`,
        "下一条消息会继续接着这个会话往下聊。",
      ].join("\n"));
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectModel(key: string, provider: string, modelId: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const modelRuntime = await this.getModelRuntime();
      const model = modelRuntime.getModel(provider, modelId);
      if (!model || !modelRuntime.hasConfiguredAuth(model.provider)) {
        await onReply(`这个模型当前不可用：${provider}/${modelId}。请发送 /model 重新选择。`);
        return;
      }

      this.state.models![key] = { provider, id: modelId };
      writeJson(STATE_PATH, this.state);

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      await onReply(`已切换到 ${provider}/${modelId}。当前飞书会话后续都会使用这个模型。`);
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectThinkingLevel(key: string, level: string, onReply: (text: string) => Promise<void>) {
    if (this.activeRuns.has(key)) {
      await onReply("当前正在生成回复，请等待完成后再调整思考强度。");
      return;
    }
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const session = await this.getSession(key);
      const status = this.getThinkingStatusForSession(session);
      if (status.source !== "pi") {
        await onReply("无法从 Pi 读取当前模型可用的 thinking levels，未做任何修改。请稍后重试。");
        return;
      }
      if (!status.availableLevels.includes(level)) {
        await onReply(`Pi 当前模型不支持 thinking level \`${level}\`。请重新发送 /thinking 选择。`);
        return;
      }

      const sessionApi = session as any;
      if (typeof sessionApi.setThinkingLevel !== "function") {
        await onReply("当前 Pi 版本不支持从飞书调整思考强度。请升级 Pi 后重试。");
        return;
      }
      sessionApi.setThinkingLevel(level);
      const effective = this.getThinkingStatusForSession(session).currentLevel || level;
      await onReply(`Thinking level set to: ${effective}`);
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  getWorkspace(key: string) {
    return this.state.workspaces?.[key] || this.cwd;
  }

  async switchWorkspace(key: string, workspaceInput: string | undefined, onReply: (text: string) => Promise<void>) {
    if (!workspaceInput) {
      const current = this.getWorkspace(key);
      await onReply([
        `当前工作区：${current}`,
        "用法：/workspace /绝对路径",
        "也支持：/workspace ~/your/project",
      ].join("\n"));
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const workspace = resolveWorkspacePath(workspaceInput);
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      delete this.state.sessions[key];
      this.state.workspaces![key] = workspace;
      writeJson(STATE_PATH, this.state);
      await onReply(`已切换到工作区：${workspace}\n下一条消息会在这个目录里创建新的 Pi 会话。`);
    }).catch(async (error) => {
      await onReply(error instanceof Error ? error.message : `Pi error: ${String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async getAvailableModels() {
    const modelRuntime = await this.getModelRuntime();
    const available = await modelRuntime.getAvailable();
    return [...available].sort((a, b) => {
      const providerCmp = a.provider.localeCompare(b.provider);
      if (providerCmp !== 0) return providerCmp;
      return a.id.localeCompare(b.id);
    });
  }

  async getSelectedModel(key: string) {
    const modelRuntime = await this.getModelRuntime();
    const selected = this.state.models?.[key];
    if (selected) {
      const model = modelRuntime.getModel(selected.provider, selected.id);
      if (model && modelRuntime.hasConfiguredAuth(model.provider)) return model;
    }
    const cached = this.sessions.get(key);
    if (cached) {
      return (await cached).model;
    }
    // Check settings default model before falling back to first available
    if (this.defaultProvider && this.defaultModelId) {
      const defaultModel = modelRuntime.getModel(this.defaultProvider, this.defaultModelId);
      if (defaultModel && modelRuntime.hasConfiguredAuth(defaultModel.provider)) {
        return defaultModel;
      }
    }
    const available = await this.getAvailableModels();
    return available[0];
  }

  private getModelRuntime() {
    this.modelRuntimePromise ||= createModelRuntimeAdapter();
    return this.modelRuntimePromise;
  }

  resetMemory() {
    for (const session of this.sessions.values()) {
      void session.then((s) => s.dispose()).catch(() => undefined);
    }
    this.sessions.clear();
    this.queues.clear();
    this.state = { sessions: {}, models: {}, workspaces: {} };
  }

  private getSession(key: string): Promise<AgentSession> {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const created = this.createSession(key);
    this.sessions.set(key, created);
    return created;
  }

  private getThinkingStatusForSession(session: AgentSession): ThinkingStatus {
    const sessionApi = session as any;
    const currentLevel = typeof sessionApi.thinkingLevel === "string" && sessionApi.thinkingLevel.trim()
      ? sessionApi.thinkingLevel
      : undefined;
    if (typeof sessionApi.getAvailableThinkingLevels !== "function") {
      return { currentLevel, availableLevels: [], source: "unavailable" };
    }
    try {
      return {
        currentLevel,
        availableLevels: normalizeThinkingLevels(sessionApi.getAvailableThinkingLevels()),
        source: "pi",
      };
    } catch {
      return { currentLevel, availableLevels: [], source: "unavailable" };
    }
  }

  private previousTurn(key: string) {
    // Keep a conversation serial for as long as Pi needs. A bridge-side queue
    // timeout can start a second turn while the first is still streaming.
    return this.queues.get(key) || Promise.resolve();
  }

  private notifyMs() {
    const sec = this.timeouts.promptNotifySec;
    return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  }

  private hardTimeoutMs() {
    const sec = this.timeouts.promptTimeoutSec;
    return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  }

  private async runPromptWithTimeouts(
    session: AgentSession,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    key: string,
    onReply: (text: string) => Promise<void>,
    status?: ReplyCardSink,
  ) {
    const notifyMs = this.notifyMs();
    const hardMs = this.hardTimeoutMs();
    const hardSec = Math.round(hardMs / 1000);
    await waitForPrompt(session.prompt(userText, images.length ? { images } : undefined), {
      notifyMs,
      hardMs,
      hardTimeoutMessage: `Pi 模型处理超时（超过 ${hardSec} 秒）仍未完成，已中止处理。可调大 config.json 中的 promptTimeoutSec。`,
      onStillRunning: () => {
        debugLog("feishu.prompt.notify_still_running", { key, elapsedMs: notifyMs });
        // A ReplyCard stays visibly "replying"; sending this as a final answer
        // would prematurely close the same card, so only non-card callers get
        // the legacy notice.
        if (status) return;
        void onReply("⏳ 仍在处理中，没有失败。请耐心等待，也可以点击「停止」中止。")
          .catch(() => undefined);
      },
      onHardTimeout: async () => {
        debugLog("feishu.prompt.hard_timeout", { key, elapsedMs: hardMs });
        try {
          await session.abort();
        } catch {}
      },
    });
  }

  private async createSession(key: string): Promise<AgentSession> {
    const workspaceCwd = this.getWorkspace(key);
    ensureWorkspaceExists(workspaceCwd);
    const existingFile = this.state.sessions[key];
    const selected = this.state.models?.[key];
    const modelRuntime = await this.getModelRuntime();
    const model = selected ? modelRuntime.getModel(selected.provider, selected.id) : undefined;
    const sessionManager = existingFile && existsSync(existingFile)
      ? SessionManager.open(existingFile, undefined, workspaceCwd)
      : SessionManager.create(workspaceCwd);

    const loader = new DefaultResourceLoader({
      cwd: workspaceCwd,
      agentDir: getAgentDir(),
      systemPromptOverride: (base) => {
        const extra = "You are replying through Feishu/Lark. Keep answers concise and readable in chat. Do not use markdown tables.";
        return base?.trim() ? `${base}\n\n${extra}` : extra;
      },
    });

    const previousChildEnv = process.env[CHILD_SESSION_ENV];
    process.env[CHILD_SESSION_ENV] = "1";
    try {
      await loader.reload();
    } finally {
      if (previousChildEnv === undefined) delete process.env[CHILD_SESSION_ENV];
      else process.env[CHILD_SESSION_ENV] = previousChildEnv;
    }

    const { session } = await createAgentSession({
      cwd: workspaceCwd,
      agentDir: getAgentDir(),
      ...modelRuntime.sessionOptions,
      model,
      sessionManager,
      resourceLoader: loader,
    } as any);

    await session.bindExtensions({});
    this.bridge?.attachSession(key, session.sessionId);
    // 会话级长期订阅：保证 text_delta 在 prompt 期间一定能收到
    session.subscribe((event: any) => {
      const run = this.activeRuns.get(key);
      run?.status?.updateFromEvent(event);
      const delta = extractAssistantTextDelta(event);
      if (delta && run && !run.stopped) {
        // 优先 onDelta（与 prompt 绑定）；否则直接 append 到 status 卡
        if (run.onDelta) run.onDelta(delta);
        else if (run.status && typeof (run.status as any).append === "function") {
          (run.status as any).append(delta);
        }
      }
      if (event.type === "message_end") {
        this.bridge?.handleMessageEnd(session.sessionId, key, event.message);
      }
    });

    if (session.sessionFile && this.state.sessions[key] !== session.sessionFile) {
      this.state.sessions[key] = session.sessionFile;
      writeJson(STATE_PATH, this.state);
    }
    return session;
  }

  private async getResumeSessions(key: string, scope: ResumeScope) {
    const base = scope === "all"
      ? await SessionManager.listAll()
      : await SessionManager.list(this.getWorkspace(key));
    return [...base].sort((a, b) => toTimeMs(b.modified) - toTimeMs(a.modified));
  }

  private async findSessionInfo(sessionPath: string): Promise<SessionInfo | undefined> {
    const currentWorkspace = this.getWorkspaceFromSessionFile(sessionPath);
    const localSessions = currentWorkspace ? await SessionManager.list(currentWorkspace) : [];
    const normalizedTarget = this.normalizeSessionPath(sessionPath);
    const fromLocal = localSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
    if (fromLocal) return fromLocal;
    const allSessions = await SessionManager.listAll();
    return allSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
  }

  private getWorkspaceFromSessionFile(sessionPath: string) {
    try {
      return SessionManager.open(sessionPath).getCwd();
    } catch {
      return undefined;
    }
  }

  private normalizeExistingSessionPath(path: string) {
    if (!path || !existsSync(path)) {
      throw new Error("历史会话不存在，可能已经被删除。");
    }
    return realpathSync(path);
  }

  private normalizeSessionPath(path: string | undefined) {
    if (!path) return undefined;
    try {
      return existsSync(path) ? realpathSync(path) : path;
    } catch {
      return path;
    }
  }
}

/**
 * Pi changed its model-session API between releases. Keep the bridge usable
 * with both the AuthStorage/ModelRegistry API and the newer ModelRuntime API.
 */
async function createModelRuntimeAdapter(): Promise<ModelRuntimeAdapter> {
  const sdk = PiSdk as any;
  if (typeof sdk.ModelRuntime?.create === "function") {
    const runtime = await sdk.ModelRuntime.create();
    return {
      getModel: (provider, id) => runtime.getModel(provider, id),
      hasConfiguredAuth: (model) => runtime.hasConfiguredAuth(model.provider),
      getAvailable: async () => [...await runtime.getAvailable()],
      sessionOptions: { modelRuntime: runtime },
    };
  }

  if (typeof sdk.AuthStorage?.create === "function" && typeof sdk.ModelRegistry?.create === "function") {
    const authStorage = sdk.AuthStorage.create();
    const modelRegistry = sdk.ModelRegistry.create(authStorage);
    return {
      getModel: (provider, id) => modelRegistry.find(provider, id),
      hasConfiguredAuth: (model) => modelRegistry.hasConfiguredAuth(model),
      getAvailable: async () => [...await modelRegistry.getAvailable()],
      sessionOptions: { authStorage, modelRegistry },
    };
  }

  throw new Error("当前 Pi 版本不支持创建飞书会话所需的模型运行时。");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


/** 从 Pi AgentSession 事件中提取 assistant 最终可见文本增量 */
function extractAssistantTextDelta(event: any): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  // 标准：message_update + assistantMessageEvent.text_delta
  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent;
    if (ame?.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
      return ame.delta;
    }
    // 兼容：delta 挂在 event 上
    if (typeof event.delta === "string" && event.delta) return event.delta;
  }
  // 兼容：顶层 text_delta
  if (event.type === "text_delta" && typeof event.delta === "string" && event.delta) {
    return event.delta;
  }
  return undefined;
}

function extractLastAssistantText(session: AgentSession): string {
  const messages = [...(session.messages || [])].reverse();
  for (const msg of messages as any[]) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((p) => p?.type === "text" ? p.text : "")
        .join("")
        .trim();
    }
  }
  return "";
}

function resolveWorkspacePath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("请在 /workspace 后面带上目录路径，例如：/workspace /Users/ax/project");
  }

  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? join(homedir(), trimmed.slice(2))
    : trimmed;

  if (!isAbsolute(expanded)) {
    throw new Error("当前只支持绝对路径或 ~/ 开头的路径。");
  }

  const resolved = resolve(expanded);
  ensureWorkspaceExists(resolved);
  return realpathSync(resolved);
}

function ensureWorkspaceExists(path: string) {
  if (!existsSync(path)) {
    throw new Error(`工作区不存在：${path}`);
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`无法访问工作区：${path}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`工作区不是目录：${path}`);
  }
}

function summarizeFirstMessage(text: string) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "未命名会话";
  return normalized.length > 36 ? `${normalized.slice(0, 35)}...` : normalized;
}

function formatModifiedLabel(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatWorkspaceLabel(cwd: string) {
  if (!cwd) return "(unknown)";
  return `${basename(cwd)} · ${cwd}`;
}

function toTimeMs(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
