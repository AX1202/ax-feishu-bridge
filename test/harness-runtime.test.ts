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
import { HarnessConversationRuntime } from "../src/adapters/harness/HarnessConversationRuntime.ts";

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
        ],
      }),
    },
    agents: {
      create: async (options: any) => ({
        agent: { id: options.sessionId, session: { seq: 0, events: [] }, options: {} },
        dispose: async () => undefined,
      }),
      resume: async (options: any) => ({
        agent: { id: options.resumeSessionId, session: { seq: 0, events: [] }, options: {} },
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
