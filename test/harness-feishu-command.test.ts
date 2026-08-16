/**
 * DSH 侧 /feishu 管理命令测试：
 * 防御式注册（宿主无 commands 服务时静默跳过）、子命令分发、
 * autostart/reset 的文件副作用、setup 的结果呈现。
 * DSH_HOME 指向临时目录，不触碰真实配置。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dshHome = mkdtempSync(join(tmpdir(), "dsh-feishu-cmd-"));
process.env.DSH_HOME = dshHome;

// 必须在导入前设置 DSH_HOME：配置路径在模块加载时基于它计算
const { registerFeishuCommand } = await import("../src/adapters/harness/feishu-command.ts");
const config = await import("../src/feishu/config.ts");
config.setRuntimeSource(config.HARNESS_SOURCE);

function createRecorderCtx() {
  const registered: any[] = [];
  return {
    ctx: { commands: { register: (descriptor: any) => registered.push(descriptor) } },
    registered,
  };
}

const baseDeps = {
  getConnectionStatus: () => "connected (test)",
  runSetup: async () => undefined,
};

function writeTestConfig(overrides: Record<string, unknown> = {}) {
  config.writeJson(config.CONFIG_HARNESS_PATH, {
    appId: "cli_a1b2c3d4e5f6",
    appSecret: "secret-value",
    domain: "feishu",
    groupPolicy: "open",
    language: "zh",
    autoStart: true,
    ...overrides,
  });
}

test("注册：宿主提供 commands 服务时注册成功，且声明 input.hint", () => {
  const { ctx, registered } = createRecorderCtx();
  assert.equal(registerFeishuCommand(ctx, baseDeps), true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.name, "feishu");
  // DSH web 输入框要求声明 input，否则带参数的命令会被当成普通聊天
  assert.ok(registered[0]!.input?.hint);
});

test("注册：宿主无 commands 服务时静默跳过（含读取即抛错的 cordis 场景）", () => {
  assert.equal(registerFeishuCommand({}, baseDeps), false);
  const throwingCtx = new Proxy({}, { get() { throw new Error("cannot get property without inject"); } });
  assert.equal(registerFeishuCommand(throwingCtx, baseDeps), false);
});

test("注册：register 抛错时不影响插件（返回 false）", () => {
  const ctx = { commands: { register: () => { throw new Error("boom"); } } };
  assert.equal(registerFeishuCommand(ctx, baseDeps), false);
});

async function getDescriptor(deps = baseDeps) {
  const { ctx, registered } = createRecorderCtx();
  assert.equal(registerFeishuCommand(ctx, deps), true);
  return registered[0]!;
}

async function runCommand(deps: typeof baseDeps | undefined, rawInput: string) {
  const descriptor = await getDescriptor(deps);
  const result = await descriptor.handler({ rawInput });
  assert.equal(result.kind, "success");
  return result.text as string;
}

test("空输入与未知子命令返回用法提示", async () => {
  assert.match(await runCommand(undefined, ""), /用法/);
  assert.match(await runCommand(undefined, "  "), /用法/);
  assert.match(await runCommand(undefined, "nonsense"), /未知子命令/);
});

test("status：未配置时显示 missing 与连接状态", async () => {
  config.removePath(config.CONFIG_HARNESS_PATH);
  const text = await runCommand(undefined, "status");
  assert.match(text, /connected \(test\)/);
  assert.match(text, /missing/);
  assert.match(text, /Gateway owner:/);
});

test("status：已配置时展示脱敏 appId 与关键配置", async () => {
  writeTestConfig();
  const text = await runCommand(undefined, "status");
  assert.match(text, /appId=cli_\*{4}e5f6/);
  assert.match(text, /groupPolicy=open/);
  assert.match(text, /autoStart=true/);
});

test("debug：无日志时给提示；有日志时返回末尾若干行", async () => {
  const logPath = config.getRuntimeSource().debugLogPath;
  // 前面的注册测试会往调试日志写记录，先清掉再验证"无日志"分支
  config.removePath(logPath);
  assert.match(await runCommand(undefined, "debug"), /还没有飞书调试日志/);
  mkdirSync(config.HARNESS_ROOT, { recursive: true });
  writeFileSync(logPath, "line-1\nline-2\nline-3\n", "utf8");
  const text = await runCommand(undefined, "debug");
  assert.match(text, /line-2/);
  assert.match(text, /line-3/);
});

test("autostart：切换并落盘；无配置时提示先 setup", async () => {
  config.removePath(config.CONFIG_HARNESS_PATH);
  assert.match(await runCommand(undefined, "autostart"), /\/feishu setup/);

  writeTestConfig({ autoStart: true });
  assert.match(await runCommand(undefined, "autostart"), /已关闭/);
  assert.equal(config.loadConfig()?.autoStart, false);
  assert.match(await runCommand(undefined, "autostart"), /已开启/);
  assert.equal(config.loadConfig()?.autoStart, true);
});

test("reset：未带 confirm 时只提示不动文件", async () => {
  writeTestConfig();
  const text = await runCommand(undefined, "reset");
  assert.match(text, /reset confirm/);
  assert.ok(existsSync(config.CONFIG_HARNESS_PATH));
});

test("reset confirm：删除配置/状态/映射文件并保留目录", async () => {
  writeTestConfig();
  config.writeJson(config.STATE_HARNESS_PATH, { sessions: {} });
  config.writeJson(config.BRIDGE_HARNESS_PATH, {});
  config.writeJson(config.DEDUPE_HARNESS_PATH, {});

  const text = await runCommand(undefined, "reset confirm");
  assert.match(text, /已重置/);
  assert.ok(!existsSync(config.CONFIG_HARNESS_PATH));
  assert.ok(!existsSync(config.STATE_HARNESS_PATH));
  assert.ok(!existsSync(config.BRIDGE_HARNESS_PATH));
  assert.ok(!existsSync(config.DEDUPE_HARNESS_PATH));
});

test("setup：向导放弃时提示未改动；完成时提示保存与生效方式", async () => {
  const aborted = await runCommand({ ...baseDeps, runSetup: async () => undefined }, "setup");
  assert.match(aborted, /未完成/);

  const done = await runCommand({
    ...baseDeps,
    runSetup: async () => ({
      appId: "cli_x9y8z7w6v5u4",
      appSecret: "s",
      domain: "feishu",
      groupPolicy: "open",
      language: "zh",
      autoStart: true,
    }) as any,
  }, "setup");
  assert.match(done, /已保存/);
  assert.match(done, /插件开关/);
});

test("子命令处理器抛错时返回可读错误而不是崩溃", async () => {
  const descriptor = await getDescriptor({
    ...baseDeps,
    runSetup: async () => { throw new Error("wizard broken"); },
  });
  const result = await descriptor.handler({ rawInput: "setup" });
  assert.match(result.text, /命令执行失败：wizard broken/);
});

test.after(() => {
  rmSync(dshHome, { recursive: true, force: true });
});
