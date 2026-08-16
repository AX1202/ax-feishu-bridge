/**
 * DeepSeek Harness Runtime 适配器：
 * 把飞书公共层需要的会话能力映射到 Harness 的公开 Service API
 * （ctx.agents / ctx.sessions / ctx.sessionQuery / ctx.llm），
 * 不调用任何 Harness 内部私有实现。
 *
 * 第一阶段能力范围（文本版）：
 * - 创建/恢复 Agent（ctx.agents.create / resume）
 * - 投递用户消息（Agent.followup）并等待完成（Agent.whenIdle）
 * - /stop（Agent.cancel）
 * - 流式输出（session/event 的 assistant/chunk）
 * - 历史会话列表与 /resume（ctx.sessionQuery）
 * - 模型列表与切换（ctx.llm + installModelSelection）
 * - 思考强度（模型 reasoning metadata + agent/request 配置）
 * - 图片输入暂不支持（后续阶段）
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle, ModelSelection } from "@deepseek-ai/dsh-agent";
import { installModelSelection, type ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { SessionRecord } from "@deepseek-ai/dsh-session-query";
import type { FeishuBridgeRuntime } from "../../feishu/bridge-runtime.ts";
import { ensureRoot, readJson, STATE_HARNESS_PATH, writeJson } from "../../feishu/config.ts";
import { debugLog } from "../../feishu/debug.ts";
import { waitForPrompt } from "../../feishu/prompt-timeout.ts";
import type { ResumeScope, ResumeSessionPage } from "../../feishu/cards.ts";
import type { ReplyCardSink } from "../../feishu/reply-card.ts";
import { normalizeThinkingLevels, type ThinkingStatus } from "../../feishu/thinking.ts";
import type { FeishuState } from "../../feishu/types.ts";
import type {
  ContextUsage,
  ConversationRuntime,
  ConversationStatus,
  ConversationTimeouts,
  RuntimeModel,
  StopConversationResult,
} from "../../feishu/runtime.ts";
import { ensureWorkspaceExists, resolveWorkspacePath } from "../../feishu/workspace.ts";

const RESUME_PAGE_SIZE = 10;

type ActiveRun = {
  agent: Agent;
  runId?: string;
  stopped: boolean;
  status?: ReplyCardSink;
  /** 当前轮流式回调（由 promptWithImages 设置） */
  onDelta?: (delta: string) => void;
};

export class HarnessConversationRuntime implements ConversationRuntime {
  private readonly agents = new Map<string, AgentHandle>();
  private readonly selectionRefs = new Map<string, ModelSelectionRef>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private modelCatalogPromise: Promise<RuntimeModel[]> | undefined;
  private state: FeishuState;
  private readonly ctx: Context;
  private readonly cwd: string;
  private readonly bridge?: FeishuBridgeRuntime;
  private readonly timeouts: ConversationTimeouts;

  constructor(
    ctx: Context,
    cwd: string,
    bridge?: FeishuBridgeRuntime,
    timeouts: ConversationTimeouts = {},
  ) {
    this.ctx = ctx;
    this.cwd = cwd;
    this.bridge = bridge;
    this.timeouts = timeouts;
    ensureRoot();
    this.state = readJson<FeishuState>(STATE_HARNESS_PATH, { sessions: {} });
    this.state.sessions ||= {};
    this.state.models ||= {};
    this.state.workspaces ||= {};
    // 会话级事件监听：assistant/chunk 流式更新、turn 结果收集。
    // 注册在插件 ctx 上，插件卸载时由 Cordis 自动清理。
    this.ctx.on("session/event", (session, event) => {
      this.handleSessionEvent(session, event);
    });
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
    // 第一阶段：Harness 核心 Message 没有通用 multimodal block，图片输入后续阶段支持。
    if (images.length > 0) {
      await onReply("当前 DeepSeek Harness 版本暂不支持图片输入，请发送文字或文件。");
      await status?.finish("failed", "unsupported image input");
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      debugLog("feishu.harness.prompt.start", { key, textLength: userText.length });
      const handle = await this.getAgent(key);
      const agent = handle.agent;
      const run: ActiveRun = { agent, runId: status?.runId, stopped: false, status, onDelta };
      this.activeRuns.set(key, run);
      this.bridge?.beginFeishuInput(agent.id);
      const firstSeq = agent.session.seq;
      try {
        agent.followup(createUserMessage({
          content: [{ type: "text", text: userText }],
          source: { kind: "user" },
        }));
        await this.runPromptWithTimeouts(key, agent, run, firstSeq, onReply, status);
        // 落盘当前会话日志，保证 /resume 与重启后可以恢复
        await this.ctx.sessions.flush(agent.session).catch(() => undefined);
      } catch (error) {
        if (run.stopped) {
          debugLog("feishu.harness.prompt.stopped", { key });
          return;
        }
        throw error;
      } finally {
        if (this.activeRuns.get(key) === run) this.activeRuns.delete(key);
        this.bridge?.endFeishuInput(agent.id);
      }
      if (run.stopped) return;
      const answer = summarizeAssistantText(agent.session.events, firstSeq);
      debugLog("feishu.harness.prompt.done", { key, answerLength: answer.length });
      await onReply(answer || "本轮处理已完成，但没有生成最终回答文本。可以再问一次试试。");
      // onReply（ReplyCard.completeWithAnswer）已切到 done；此处仅兜底
      await status?.finish("done");
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.harness.prompt.error", { key, error: message });
      // 错误也写进同一张卡；onReply 若已是 completeWithAnswer 会 no-op（status 非 running）
      if (status && "ensureFinal" in status && typeof (status as any).ensureFinal === "function") {
        (status as any).ensureFinal(`出错了：${message}`);
        await status.finish("failed", message);
      } else {
        await status?.finish("failed", message);
        await onReply(`Agent error: ${message}`);
      }
    });
    this.queues.set(key, next);
    await next;
  }

  /** 供 /status 使用 */
  getStatus(key: string): ConversationStatus {
    const active = this.activeRuns.get(key);
    return {
      cwd: this.getWorkspace(key),
      hasActiveRun: Boolean(active),
      activeStopped: Boolean(active?.stopped),
    };
  }

  async getActualModel(key: string) {
    const model = await this.getSelectedModel(key);
    if (!model) return "默认模型";
    return `${model.provider}/${model.id}`;
  }

  async getThinkingStatus(key: string): Promise<ThinkingStatus> {
    const model = await this.getSelectedModel(key);
    if (!model) {
      return { currentLevel: undefined, availableLevels: [], available: false };
    }
    try {
      const info = await this.ctx.llm.resolveModelInfo(model.provider, model.id);
      if (!info.reasoning) {
        return { currentLevel: undefined, availableLevels: [], available: false };
      }
      const ref = this.selectionRefs.get(key);
      const currentLevel = ref?.current?.reasoningEffort ?? info.reasoning.defaultEffort;
      return {
        currentLevel: currentLevel !== undefined ? String(currentLevel) : undefined,
        availableLevels: normalizeThinkingLevels(info.reasoning.efforts.map((effort) => String(effort.id))),
        available: true,
      };
    } catch (error) {
      debugLog("feishu.harness.thinking_error", { key, error: error instanceof Error ? error.message : String(error) });
      return { currentLevel: undefined, availableLevels: [], available: false };
    }
  }

  async getContextStatus(key: string): Promise<ContextUsage | null> {
    // 第一阶段不接入 Harness token-meter，/status 显示"暂无数据"。
    return null;
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
      debugLog("feishu.harness.stop_stale", { key, runId, activeRunId: active.runId });
      return { status: "stale", message };
    }

    active.stopped = true;
    const body = active.status?.bodyText || "";
    await active.status?.stopImmediately("已停止");
    try {
      active.agent.cancel({ kind: "user" });
      debugLog("feishu.harness.prompt.abort", { key });
      const message = "已停止";
      await onReply(message);
      return { status: "stopped", message, body };
    } catch (error) {
      active.stopped = false;
      debugLog("feishu.harness.prompt.abort_error", { key, error: error instanceof Error ? error.message : String(error) });
      const message = "停止失败，请重试。";
      await onReply(message);
      return { status: "failed", message };
    }
  }

  async newConversation(key: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      await this.disposeAgent(key);
      delete this.state.sessions[key];
      writeJson(STATE_HARNESS_PATH, this.state);
      await onReply("已创建新会话。旧会话历史已保留，下一条消息会从新上下文开始。");
    }).catch(async (error) => {
      await onReply(`Agent error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async listResumeSessions(key: string, scope: ResumeScope, page: number): Promise<ResumeSessionPage> {
    const records = await this.ctx.sessionQuery.listSessions();
    const workspaceCwd = this.getWorkspace(key);
    const filtered = scope === "current"
      ? records.filter((record) => record.header.cwd === workspaceCwd)
      : records;
    // listSessions 已按 newest-first 返回；标题分批读取
    const normalizedPage = Math.max(0, Math.floor(page));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / RESUME_PAGE_SIZE));
    const clampedPage = Math.min(normalizedPage, totalPages - 1);
    const currentSessionId = this.state.sessions[key];
    const start = clampedPage * RESUME_PAGE_SIZE;
    const pageRecords = filtered.slice(start, start + RESUME_PAGE_SIZE);

    const items = await Promise.all(pageRecords.map(async (record) => {
      const id = String(record.header.id);
      const summary = await this.loadSessionSummary(record.header.id);
      const titleSnapshot = await this.ctx.sessionQuery.readTitle(record.header.id).catch(() => undefined);
      const hasTitle = Boolean(titleSnapshot?.title?.trim());
      return {
        path: id,
        title: hasTitle ? titleSnapshot!.title.trim() : summarizeFirstMessage(summary.firstText),
        subtitle: hasTitle ? summarizeFirstMessage(summary.firstText) : `消息数：${summary.userCount}`,
        modifiedLabel: formatModifiedLabel(record.header.createdAt),
        workspaceLabel: scope === "all" ? formatWorkspaceLabel(record.header.cwd) : undefined,
        isCurrent: Boolean(currentSessionId && currentSessionId === id),
      };
    }));

    return {
      key,
      workspacePath: workspaceCwd,
      scope,
      page: clampedPage,
      total,
      totalPages,
      items,
    };
  }

  async resumeConversation(key: string, sessionRef: string, onReply: (text: string) => Promise<void>) {
    if (this.activeRuns.has(key)) {
      await onReply("当前还有进行中的处理，请先发送 /stop，再切换历史会话。");
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const records = await this.ctx.sessionQuery.listSessions();
      const target = records.find((record) => String(record.header.id) === sessionRef);
      if (!target) {
        await onReply("这条历史会话不存在，可能已经被删除。请重新打开 /resume 选择。");
        return;
      }

      const currentSessionId = this.state.sessions[key];
      if (currentSessionId === sessionRef) {
        this.state.workspaces![key] = target.header.cwd || this.getWorkspace(key);
        writeJson(STATE_HARNESS_PATH, this.state);
        await onReply(`你已经在这个历史会话里了。\n当前工作区：${this.state.workspaces![key]}`);
        return;
      }

      await this.disposeAgent(key);
      this.state.sessions[key] = sessionRef;
      this.state.workspaces![key] = target.header.cwd || this.cwd;
      writeJson(STATE_HARNESS_PATH, this.state);
      const titleSnapshot = await this.ctx.sessionQuery.readTitle(target.header.id).catch(() => undefined);
      const summary = await this.loadSessionSummary(target.header.id);
      await onReply([
        `已切换到历史会话：${titleSnapshot?.title?.trim() || summarizeFirstMessage(summary.firstText)}`,
        `工作区：${this.state.workspaces![key]}`,
        "下一条消息会继续接着这个会话往下聊。",
      ].join("\n"));
    }).catch(async (error) => {
      await onReply(`Agent error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectModel(key: string, provider: string, modelId: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const catalog = await this.getModelCatalog();
      const model = catalog.find((item) => item.provider === provider && item.id === modelId);
      if (!model) {
        await onReply(`这个模型当前不可用：${provider}/${modelId}。请发送 /model 重新选择。`);
        return;
      }

      const existing = this.state.models?.[key];
      this.state.models![key] = { provider, id: modelId, thinkingLevel: existing?.thinkingLevel };
      writeJson(STATE_HARNESS_PATH, this.state);

      // 动态生效：已创建的 agent 通过 selectionRef 在 agent/request 瀑布中切换，无需重建
      const ref = this.selectionRefs.get(key);
      if (ref?.current) {
        ref.current = { ...ref.current, provider, model: modelId };
      }
      await onReply(`已切换到 ${provider}/${modelId}。当前飞书会话后续都会使用这个模型。`);
    }).catch(async (error) => {
      await onReply(`Agent error: ${error instanceof Error ? error.message : String(error)}`);
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
      const status = await this.getThinkingStatus(key);
      if (!status.available) {
        await onReply("无法读取当前模型可用的 thinking levels，未做任何修改。请稍后重试。");
        return;
      }
      if (!status.availableLevels.includes(level)) {
        await onReply(`当前模型不支持 thinking level \`${level}\`。请重新发送 /thinking 选择。`);
        return;
      }

      const ref = this.selectionRefs.get(key);
      if (!ref) {
        await onReply("当前会话尚未就绪，无法调整思考强度。请先发送一条消息。");
        return;
      }
      ref.current = { ...ref.current, reasoningEffort: level as ReasoningEffortId };
      const existing = this.state.models?.[key];
      if (existing) {
        this.state.models![key] = { ...existing, thinkingLevel: level };
        writeJson(STATE_HARNESS_PATH, this.state);
      }
      await onReply(`Thinking level set to: ${level}`);
    }).catch(async (error) => {
      await onReply(`Agent error: ${error instanceof Error ? error.message : String(error)}`);
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
      await this.disposeAgent(key);
      delete this.state.sessions[key];
      this.state.workspaces![key] = workspace;
      writeJson(STATE_HARNESS_PATH, this.state);
      await onReply(`已切换到工作区：${workspace}\n下一条消息会在这个目录里创建新的会话。`);
    }).catch(async (error) => {
      await onReply(error instanceof Error ? error.message : `Agent error: ${String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async getAvailableModels(): Promise<RuntimeModel[]> {
    return this.getModelCatalog();
  }

  async getSelectedModel(key: string): Promise<RuntimeModel | undefined> {
    const selected = this.state.models?.[key];
    if (selected) {
      const found = await this.findInCatalog(selected.provider, selected.id);
      if (found) return found;
    }
    const ref = this.selectionRefs.get(key);
    if (ref?.current) {
      const found = await this.findInCatalog(ref.current.provider, ref.current.model);
      if (found) return found;
    }
    const available = await this.getModelCatalog();
    return available[0];
  }

  resetMemory() {
    for (const handle of this.agents.values()) {
      void handle.dispose().catch(() => undefined);
    }
    this.agents.clear();
    this.queues.clear();
    this.selectionRefs.clear();
    this.activeRuns.clear();
    this.state = { sessions: {}, models: {}, workspaces: {} };
  }

  /** 插件卸载时释放全部 agent（dispose 会停止循环并持久化会话，历史保留可 resume）。 */
  async dispose() {
    for (const handle of this.agents.values()) {
      try {
        await handle.dispose();
      } catch {}
    }
    this.agents.clear();
    this.selectionRefs.clear();
    this.activeRuns.clear();
  }

  // ---------- 内部实现 ----------

  private async getAgent(key: string): Promise<AgentHandle> {
    const cached = this.agents.get(key);
    if (cached) return cached;

    const workspaceCwd = this.getWorkspace(key);
    ensureWorkspaceExists(workspaceCwd);

    const selected = this.state.models?.[key];
    const selection: ModelSelection | undefined = selected
      ? {
        provider: selected.provider,
        model: selected.id,
        ...(selected.thinkingLevel ? { reasoningEffort: selected.thinkingLevel as ReasoningEffortId } : {}),
      }
      : undefined;
    const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined };
    const agentOptions = selected ? { provider: selected.provider, model: selected.id } : undefined;

    const existingSessionId = this.state.sessions[key];
    let handle: AgentHandle;
    if (existingSessionId) {
      debugLog("feishu.harness.agent_resume", { key, sessionId: existingSessionId });
      try {
        handle = await this.ctx.agents.resume({
          resumeSessionId: SessionId(existingSessionId),
          agentOptions,
          setup: (agentCtx) => {
            installModelSelection(agentCtx, selectionRef);
          },
        });
      } catch (error) {
        // 该会话可能已被其他入口占用（如在 Harness 网页里打开过，会话在宿主里处于 live），
        // 或持久化记录损坏导致无法恢复：回退为新建会话，保证飞书对话不被卡死。
        debugLog("feishu.harness.agent_resume_failed", {
          key,
          sessionId: existingSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        handle = await this.createAgentHandle(workspaceCwd, agentOptions, selectionRef);
      }
    } else {
      handle = await this.createAgentHandle(workspaceCwd, agentOptions, selectionRef);
    }
    this.state.sessions[key] = String(handle.agent.id);
    writeJson(STATE_HARNESS_PATH, this.state);

    this.selectionRefs.set(key, selectionRef);
    this.agents.set(key, handle);
    this.bridge?.attachSession(key, handle.agent.id);
    await this.attachToWorkspace(String(handle.agent.id), workspaceCwd);
    return handle;
  }

  /**
   * 把会话登记到对应的 Harness 工作区，网页侧栏才会按工作区分组显示
   * （否则一律落在“未分组”：宿主只在首次启动时自动归档历史，
   * 之后创建的会话必须显式 attach）。工作区服务是宿主侧可选能力，
   * 不存在或登记失败只记日志，不影响对话；目录尚未注册时自动注册。
   */
  private async attachToWorkspace(sessionId: string, workspaceCwd: string) {
    const registry = this.getWorkspaceRegistry();
    if (!registry) return;
    try {
      let workspace = await registry.resolveByPath(workspaceCwd);
      if (!workspace) workspace = await registry.create(workspaceCwd);
      await workspace.attachSession(SessionId(sessionId));
      debugLog("feishu.harness.workspace_attached", { sessionId, workspace: workspace.path });
    } catch (error) {
      debugLog("feishu.harness.workspace_attach_failed", {
        sessionId,
        cwd: workspaceCwd,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 可选服务：宿主没装 workspace 能力时返回 undefined。 */
  private getWorkspaceRegistry(): any {
    const ctx = this.ctx as any;
    try {
      return typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : ctx.workspaceRegistry;
    } catch {
      return undefined;
    }
  }

  /** 新建一个飞书会话对应的 agent（随机 sessionId，历史不落旧账）。 */
  private async createAgentHandle(
    workspaceCwd: string,
    agentOptions: { provider: string; model: string } | undefined,
    selectionRef: ModelSelectionRef,
  ): Promise<AgentHandle> {
    debugLog("feishu.harness.agent_create", { cwd: workspaceCwd });
    return this.ctx.agents.create({
      sessionId: SessionId(`feishu-${randomUUID()}`),
      meta: { cwd: workspaceCwd },
      agentOptions,
      setup: (agentCtx) => {
        installModelSelection(agentCtx, selectionRef);
      },
    });
  }

  private async disposeAgent(key: string) {
    const cached = this.agents.get(key);
    if (!cached) return;
    try {
      await cached.dispose();
    } catch {}
    this.agents.delete(key);
    this.selectionRefs.delete(key);
  }

  private handleSessionEvent(session: Session, event: SessionEvent) {
    for (const run of this.activeRuns.values()) {
      if (run.agent.session !== session) continue;
      run.status?.updateFromEvent(event);
      // 稳妥策略：不流式推送模型的中间输出。
      // 模型的 text-delta 里可能混着工具调用指令（DSML 标记）等内部草稿，
      // 直接推给用户会看到"工作草稿"而非回答。
      // 因此只在整轮结束后，从事件日志里提取最终面向用户的回答再发送。
      return;
    }
  }

  private previousTurn(key: string) {
    // 与 Pi 适配器相同：保持每会话串行，避免并发两轮互相覆盖。
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
    key: string,
    agent: Agent,
    run: ActiveRun,
    _firstSeq: number,
    onReply: (text: string) => Promise<void>,
    status?: ReplyCardSink,
  ) {
    const notifyMs = this.notifyMs();
    const hardMs = this.hardTimeoutMs();
    const hardSec = Math.round(hardMs / 1000);
    await waitForPrompt(agent.whenIdle(), {
      notifyMs,
      hardMs,
      hardTimeoutMessage: `模型处理超时（超过 ${hardSec} 秒）仍未完成，已中止处理。可调大 config.json 中的 promptTimeoutSec。`,
      onStillRunning: () => {
        debugLog("feishu.harness.prompt.notify_still_running", { key, elapsedMs: notifyMs });
        // 卡片模式保持"回复中"，不提前关闭
        if (status) return;
        void onReply("⏳ 仍在处理中，没有失败。请耐心等待，也可以点击「停止」中止。")
          .catch(() => undefined);
      },
      onHardTimeout: async () => {
        debugLog("feishu.harness.prompt.hard_timeout", { key, elapsedMs: hardMs });
        try {
          agent.cancel({ kind: "hook", reason: "hard prompt timeout" });
        } catch {}
      },
    });
  }

  private getModelCatalog(): Promise<RuntimeModel[]> {
    this.modelCatalogPromise ||= (async () => {
      const providers = this.ctx.llm.listProviders();
      const result: RuntimeModel[] = [];
      for (const provider of providers) {
        try {
          const models = await this.ctx.llm.listModels(provider.id);
          for (const model of models) {
            result.push(toRuntimeModel(model));
          }
        } catch (error) {
          debugLog("feishu.harness.list_models_error", {
            provider: provider.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result.sort((a, b) => {
        const providerCmp = a.provider.localeCompare(b.provider);
        if (providerCmp !== 0) return providerCmp;
        return a.id.localeCompare(b.id);
      });
    })();
    return this.modelCatalogPromise;
  }

  private async findInCatalog(provider: string, id: string) {
    const catalog = await this.getModelCatalog();
    return catalog.find((model) => model.provider === provider && model.id === id);
  }

  /** 读取一个历史会话的摘要：首条用户消息文本 + 用户消息条数。 */
  private async loadSessionSummary(sessionId: SessionId) {
    try {
      const snapshot = await this.ctx.sessionQuery.readSession(sessionId);
      let firstText = "";
      let userCount = 0;
      for (const event of snapshot.events) {
        if (event.type !== "user/message") continue;
        userCount += 1;
        if (!firstText) firstText = extractContentText((event.data as any).content);
      }
      return { firstText, userCount };
    } catch {
      return { firstText: "", userCount: 0 };
    }
  }
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.type === "text" ? part.text : "")
    .join("")
    .trim();
}

/** 把 Harness 的 LlmModelInfo 转成平台无关的 RuntimeModel（禁止原生对象泄漏到飞书层）。 */
function toRuntimeModel(model: any): RuntimeModel {
  return {
    provider: String(model?.provider ?? ""),
    id: String(model?.id ?? ""),
    name: typeof model?.name === "string" ? model.name : undefined,
    supportsImage: Array.isArray(model?.inputModalities)
      ? (model.inputModalities as string[]).includes("image")
      : false,
  };
}

/** 模型工具调用指令的标记（DSML）：带这种内容的消息是"内部草稿"，不是给用户的回答。 */
const DSML_MARKER = "<｜｜DSML｜｜";

export function isToolCallText(text: string): boolean {
  return text.includes(DSML_MARKER);
}

/**
 * 从事件日志提取本轮最后一条"面向用户"的助手回答：
 * 从后往前找，跳过工具调用指令等中间过程消息。
 */
export function summarizeAssistantText(events: readonly SessionEvent[], firstSeq: number): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.seq < firstSeq) break;
    if (event.type !== "assistant/message") continue;
    const joined = event.data.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (joined !== "" && !isToolCallText(joined)) return joined;
  }
  return "";
}

function summarizeFirstMessage(text: string) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "未命名会话";
  return normalized.length > 36 ? `${normalized.slice(0, 35)}...` : normalized;
}

function formatModifiedLabel(value: number | Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatWorkspaceLabel(cwd: string | undefined) {
  if (!cwd) return "(unknown)";
  const basename = cwd.split("/").pop() || cwd;
  return `${basename} · ${cwd}`;
}
