/**
 * Harness 适配器冒烟测试：用 mock 的 Cordis 服务验证核心逻辑
 * （模型目录转换、思考强度映射、模型选择持久化、历史会话列表）。
 * 不连接真实飞书/Harness。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConversationRuntime, isToolCallText, summarizeAssistantText } from "../src/adapters/harness/HarnessConversationRuntime.ts";
import { readJson, STATE_HARNESS_PATH, writeJson } from "../src/feishu/config.ts";

function createMockCtx() {
  const listeners: Array<[string, (...args: any[]) => void]> = [];
  const ctx: any = {
    on: (event: string, cb: (...args: any[]) => void) => {
      listeners.push([event, cb]);
      return () => {
        const idx = listeners.findIndex((item) => item[0] === event && item[1] === cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    llm: {
      listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
      listModels: async (provider: string) => provider === "deepseek"
        ? [
          { provider: "deepseek", id: "deepseek-v4", name: "V4", inputModalities: ["text", "image"] },
          { provider: "deepseek", id: "deepseek-r1", name: "R1" },
        ]
        : [],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: [
            { id: "off", name: "Off" },
            { id: "high", name: "High" },
            { id: "max", name: "Max" },
          ],
          defaultEffort: "high",
        },
      }),
    },
    sessionQuery: {
      listSessions: async () => [
        {
          header: { id: "session-old", cwd: "/tmp/ws", createdAt: 1_700_000_000_000 },
          live: false,
          persisted: true,
        },
      ],
      readTitle: async () => ({ title: "旧会话标题", messageSeqs: [0], source: "fallback", eventSeq: 1, updatedAt: 1 }),
      readSession: async () => ({
        session: { id: "session-old" },
        events: [
          { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "你好" }] } },
          { type: "session/title", seq: 1, time: 2, data: { title: "旧会话标题", messageSeqs: [0], source: { kind: "fallback" } } },
        ],
      }),
    },
    agents: {
      create: async (options: any) => ({
        agent: { id: options.sessionId, session: { seq: 0, events: [] }, options: options.agentOptions ?? {} },
        dispose: async () => undefined,
      }),
      resume: async (options: any) => ({
        agent: { id: options.resumeSessionId, session: { seq: 0, events: [] }, options: options.agentOptions ?? {} },
        dispose: async () => undefined,
      }),
    },
    sessions: {
      flush: async () => undefined,
    },
  };
  return { ctx, listeners };
}

test("harness runtime: getAvailableModels converts native models to RuntimeModel", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "feishu-harness-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const { ctx } = createMockCtx();
    const runtime = new HarnessConversationRuntime(ctx, "/tmp/ws");
    const models = await runtime.getAvailableModels();
    assert.equal(models.length, 2);
    // 按 provider/id 排序：deepseek-r1 在 deepseek-v4 之前
    assert.equal(models[0]!.id, "deepseek-r1");
    assert.equal(models[0]!.supportsImage, false);
    assert.equal(models[1]!.id, "deepseek-v4");
    assert.equal(models[1]!.supportsImage, true);
    await runtime.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("harness runtime: getThinkingStatus maps reasoning metadata", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "feishu-harness-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const { ctx } = createMockCtx();
    const runtime = new HarnessConversationRuntime(ctx, "/tmp/ws");
    const status = await runtime.getThinkingStatus("p2p:user");
    assert.equal(status.available, true);
    assert.deepEqual(status.availableLevels, ["off", "high", "max"]);
    assert.equal(status.currentLevel, "high"); // 未选择时用模型默认档位
    await runtime.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("harness runtime: selectModel persists and drives the selection ref", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "feishu-harness-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const { ctx } = createMockCtx();
    const runtime = new HarnessConversationRuntime(ctx, "/tmp/ws");
    const key = "p2p:user";
    let reply = "";
    await runtime.selectModel(key, "deepseek", "deepseek-r1", async (text) => { reply = text; });
    assert.match(reply, /已切换到 deepseek\/deepseek-r1/);
    const selected = await runtime.getSelectedModel(key);
    assert.equal(selected?.id, "deepseek-r1");
    // 再次选择不存在的模型应拒绝
    await runtime.selectModel(key, "deepseek", "no-such-model", async (text) => { reply = text; });
    assert.match(reply, /这个模型当前不可用/);
    await runtime.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("harness runtime: listResumeSessions reads from sessionQuery", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "feishu-harness-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const { ctx } = createMockCtx();
    const runtime = new HarnessConversationRuntime(ctx, "/tmp/ws");
    const page = await runtime.listResumeSessions("p2p:user", "current", 0);
    assert.equal(page.total, 1);
    assert.equal(page.items[0]!.path, "session-old");
    assert.equal(page.items[0]!.title, "旧会话标题");
    assert.equal(page.items[0]!.subtitle, "你好");
    await runtime.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("harness runtime: listResumeSessions caches persisted session reads", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "feishu-harness-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const { ctx } = createMockCtx();
    let reads = 0;
    const originalReadSession = ctx.sessionQuery.readSession;
    ctx.sessionQuery.readSession = async () => {
      reads += 1;
      return originalReadSession();
    };
    const runtime = new HarnessConversationRuntime(ctx, "/tmp/ws");
    await runtime.listResumeSessions("p2p:user", "current", 0);
    await runtime.listResumeSessions("p2p:user", "current", 0);
    // 非 live 历史会话只完整读取一次，后续 /resume、翻页直接命中缓存
    assert.equal(reads, 1);
    await runtime.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("harness runtime: summarize skips DSML tool-call drafts and returns the final answer", () => {
  const events: any[] = [
    { seq: 0, type: "user/message", data: { content: [{ type: "text", text: "你好" }] } },
    { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"ls\"/></｜｜DSML｜｜tool_calls>" }] } } },
    { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "你好！有什么可以帮你的？" }] } } },
  ];
  assert.equal(summarizeAssistantText(events, 0), "你好！有什么可以帮你的？");

  // 只有工具调用草稿时应返回空（交给上层显示友好提示）
  const onlyToolCall: any[] = [
    { seq: 0, type: "assistant/message", data: { message: { content: [{ type: "text", text: "<｜｜DSML｜｜tool_calls>x" }] } } },
  ];
  assert.equal(summarizeAssistantText(onlyToolCall, 0), "");
  assert.equal(isToolCallText("<｜｜DSML｜｜tool_calls>"), true);
  assert.equal(isToolCallText("普通回答"), false);
});

test("harness runtime: resume failure (session live elsewhere) falls back to a new session", async () => {
  const { ctx } = createMockCtx();
  // 宿主报：旧会话已被其他入口占用（live），无法 resume
  ctx.agents.resume = async () => {
    throw new Error('cannot prepare session "feishu-live-session" while it is live');
  };
  const ws = mkdtempSync(join(tmpdir(), "feishu-harness-ws-"));
  const key = "p2p:test-resume-fallback";
  try {
    const runtime = new HarnessConversationRuntime(ctx, ws);
    // 模拟重启前遗留的会话绑定（状态文件路径在导入时固定为真实 HOME，故直接改内存状态）
    (runtime as any).state.sessions[key] = "feishu-live-session";
    const handle = await (runtime as any).getAgent(key);
    // 回退新建：不是旧 id，且仍是 feishu- 前缀会话
    assert.notEqual(String(handle.agent.id), "feishu-live-session");
    assert.match(String(handle.agent.id), /^feishu-/);
    // 状态已改绑到新会话，下一条消息不会再撞旧会话
    assert.equal((runtime as any).state.sessions[key], String(handle.agent.id));
    await runtime.dispose();
  } finally {
    // 清理：移除测试写入真实状态文件的绑定
    const state = readJson<any>(STATE_HARNESS_PATH, { sessions: {} });
    if (state.sessions?.[key] !== undefined) {
      delete state.sessions[key];
      writeJson(STATE_HARNESS_PATH, state);
    }
    rmSync(ws, { recursive: true, force: true });
  }
});

test("harness runtime: new session is attached to its workspace (auto-creating it)", async () => {
  const { ctx } = createMockCtx();
  const created: string[] = [];
  const attached: string[] = [];
  const registry = {
    resolveByPath: async () => undefined,
    create: async (p: string) => {
      created.push(p);
      return {
        path: p,
        title: "auto",
        attachSession: async (id: string) => { attached.push(String(id)); },
      };
    },
  };
  ctx.get = (name: string) => (name === "workspaceRegistry" ? registry : undefined);
  const ws = mkdtempSync(join(tmpdir(), "feishu-harness-ws-"));
  const key = "p2p:test-workspace-create";
  try {
    const runtime = new HarnessConversationRuntime(ctx, ws);
    const handle = await (runtime as any).getAgent(key);
    // 目录未注册 → 自动创建工作区并把新会话登记进去
    assert.deepEqual(created, [ws]);
    assert.deepEqual(attached, [String(handle.agent.id)]);
    await runtime.dispose();
  } finally {
    const state = readJson<any>(STATE_HARNESS_PATH, { sessions: {} });
    if (state.sessions?.[key] !== undefined) {
      delete state.sessions[key];
      writeJson(STATE_HARNESS_PATH, state);
    }
    rmSync(ws, { recursive: true, force: true });
  }
});

test("harness runtime: session attaches to an existing workspace without creating one", async () => {
  const { ctx } = createMockCtx();
  let createCalled = false;
  const attached: string[] = [];
  const existing = {
    path: "/tmp/ws",
    title: "existing",
    attachSession: async (id: string) => { attached.push(String(id)); },
  };
  const registry = {
    resolveByPath: async () => existing,
    create: async () => { createCalled = true; return existing; },
  };
  ctx.get = (name: string) => (name === "workspaceRegistry" ? registry : undefined);
  const ws = mkdtempSync(join(tmpdir(), "feishu-harness-ws-"));
  const key = "p2p:test-workspace-existing";
  try {
    const runtime = new HarnessConversationRuntime(ctx, ws);
    const handle = await (runtime as any).getAgent(key);
    assert.equal(createCalled, false);
    assert.deepEqual(attached, [String(handle.agent.id)]);
    await runtime.dispose();
  } finally {
    const state = readJson<any>(STATE_HARNESS_PATH, { sessions: {} });
    if (state.sessions?.[key] !== undefined) {
      delete state.sessions[key];
      writeJson(STATE_HARNESS_PATH, state);
    }
    rmSync(ws, { recursive: true, force: true });
  }
});

test("harness runtime: session without a selected model falls back to the host default model", async () => {
  const { ctx } = createMockCtx();
  ctx.get = (name: string) => (name === "agentDefaultModel"
    ? { currentSelection: () => ({ provider: "deepseek", model: "deepseek-v4-flash" }) }
    : undefined);
  const ws = mkdtempSync(join(tmpdir(), "feishu-harness-ws-"));
  const key = "p2p:test-default-model";
  try {
    const runtime = new HarnessConversationRuntime(ctx, ws);
    const handle = await (runtime as any).getAgent(key);
    // 未选模型的会话（如新群聊）也要带上 provider/model，否则提示词 {{model}} 变量无值，第一轮组装失败
    assert.deepEqual(handle.agent.options, { provider: "deepseek", model: "deepseek-v4-flash" });
    await runtime.dispose();
  } finally {
    const state = readJson<any>(STATE_HARNESS_PATH, { sessions: {} });
    if (state.sessions?.[key] !== undefined) {
      delete state.sessions[key];
      writeJson(STATE_HARNESS_PATH, state);
    }
    rmSync(ws, { recursive: true, force: true });
  }
});

test("harness runtime: prompt with images is rejected in phase one", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "feishu-harness-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const { ctx } = createMockCtx();
    const runtime = new HarnessConversationRuntime(ctx, "/tmp/ws");
    let reply = "";
    await runtime.promptWithImages("p2p:user", "看图", [{ type: "image", data: "x", mimeType: "image/png" }], async (text) => { reply = text; });
    assert.match(reply, /暂不支持图片输入/);
    await runtime.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
