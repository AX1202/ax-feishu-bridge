import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildModelCard, buildResumeCard, parseModelActionValue, parseResumePageActionValue, parseResumeSelectActionValue } from "./cards.js";
import { BRIDGE_PATH, CHILD_SESSION_ENV, CONFIG_PATH, DAEMON_LOG_PATH, DEBUG_LOG_PATH, DEDUPE_PATH, ensureRoot, loadConfig, mask, removePath, STATE_PATH, writeJson } from "./config.js";
import { debugLog } from "./debug.js";
import { FeishuBridgeRuntime } from "./bridge-runtime.js";
import { FeishuBridgeStore } from "./bridge-store.js";
import { ConversationManager } from "./conversation-manager.js";
import { FeishuDelivery } from "./delivery.js";
import { acquireGatewayLock, gatewayLockPath, readGatewayOwner, type GatewayLockHandle, type GatewayOwner } from "./gateway-lock.js";
import { FeishuMessageHandler } from "./message-handler.js";
import { runSetup, uiConfirm } from "./setup.js";
import { buildTaskStatusCard, parseStopTaskActionValue } from "./task-status-card.js";
import { BotUnavailableError, FeishuTransport } from "./transport.js";
import type { FeishuConfig, FeishuStatus } from "./types.js";

export default function feishuExtension(pi: ExtensionAPI) {
  if (process.env[CHILD_SESSION_ENV] === "1") {
    return;
  }

  let transport: FeishuTransport | undefined;
  let gatewayLock: GatewayLockHandle | undefined;
  const bridgeStore = new FeishuBridgeStore();
  const delivery = new FeishuDelivery(() => transport);
  const bridge = new FeishuBridgeRuntime(bridgeStore, delivery);
  const conversations = new ConversationManager(process.cwd(), bridge);
  const messageHandler = new FeishuMessageHandler(conversations, () => transport, bridgeStore);

  const STATUS_KEY = "feishu-connection";
  const STATUS_REFRESH_MS = 2_000;
  let uiRef: { setStatus?: (key: string, text: string | undefined) => void } | undefined;
  let lastStatusText: string | undefined;
  let statusRefreshTimer: NodeJS.Timeout | undefined;
  const buildTag = process.env.FEISHU_EXT_DEV === "1" ? " [DEV]" : "";

  function setStatusText(text: string | undefined) {
    if (lastStatusText === text) return;
    lastStatusText = text;
    uiRef?.setStatus?.(STATUS_KEY, text);
  }

  function updateStatus(status: FeishuStatus) {
    const cfg = loadConfig();
    const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
    setStatusText(statusText(brand, status));
  }

  function withBuildTag(text: string) {
    return `${text}${buildTag}`;
  }

  function statusText(brand: "Feishu" | "Lark", status: FeishuStatus) {
    const labels: Record<FeishuStatus, string> = {
      "not configured": "未配置 / Not configured",
      connecting: "连接中 / Connecting",
      connected: "已连接 / Connected",
      disconnected: "已断开 / Disconnected",
      owned: "连接被占用 / In use by another process",
      "bot unavailable": "机器人不可用 / Bot unavailable",
    };
    return withBuildTag(`${brand}: ${labels[status]}`);
  }

  function refreshStatusFromState() {
    const cfg = loadConfig();
    const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
    if (!cfg) {
      setStatusText(statusText(brand, "not configured"));
      return;
    }
    if (transport?.isRunning()) {
      setStatusText(statusText(brand, "connected"));
      return;
    }
    const owner = readGatewayOwner();
    if (owner?.status === "connected") {
      setStatusText(statusText(brand, "connected"));
    } else if (owner?.status === "starting") {
      setStatusText(statusText(brand, "connecting"));
    } else if (owner) {
      setStatusText(statusText(brand, "disconnected"));
    } else {
      setStatusText(statusText(brand, "disconnected"));
    }
  }

  function startStatusRefresh() {
    if (statusRefreshTimer) return;
    refreshStatusFromState();
    statusRefreshTimer = setInterval(refreshStatusFromState, STATUS_REFRESH_MS);
    statusRefreshTimer.unref?.();
  }

  function stopStatusRefresh() {
    if (!statusRefreshTimer) return;
    clearInterval(statusRefreshTimer);
    statusRefreshTimer = undefined;
  }

  function clearStatus() {
    stopStatusRefresh();
    lastStatusText = undefined;
    uiRef?.setStatus?.(STATUS_KEY, undefined);
  }

  pi.on("message_end", async (event, ctx) => {
    bridge.handleMessageEnd(ctx.sessionManager.getSessionId(), undefined, event.message);
  });

  async function start(config?: FeishuConfig, options: { takeover?: boolean } = {}) {
    if (transport?.isRunning()) {
      updateStatus("connected");
      return "already";
    }
    const cfg = config || loadConfig();
    if (!cfg) {
      updateStatus("not configured");
      throw new Error(`Missing config. Run /feishu setup first. 配置不存在，请先运行 /feishu setup。`);
    }
    updateStatus("connecting");
    const lockResult = await acquireGatewayLock(process.cwd(), Boolean(options.takeover));
    if (lockResult.status === "busy") {
      updateStatus("owned");
      return { status: "owned" as const, owner: lockResult.owner };
    }
    gatewayLock = lockResult.handle;
    gatewayLock.setOnLost(async () => {
      await transport?.stop();
      transport = undefined;
      gatewayLock = undefined;
      updateStatus(loadConfig() ? "owned" : "not configured");
      if (process.env.PI_FEISHU_DAEMON === "1") {
        terminateLauncherParent();
        process.exit(0);
      }
    });
    transport = new FeishuTransport(cfg, (msg) => messageHandler.handle(msg), async (action) => {
      const copy = parseCopyMarkdownActionValue(action.value);
      if (copy) {
        const source = transport?.getMarkdownCopySource(copy.copySourceId);
        await transport?.replyPlainText(action.messageId, source || "MD 原文已过期，请重新生成卡片。");
        return;
      }
      const stopTask = parseStopTaskActionValue(action.value);
      if (stopTask) {
        debugLog("feishu.card.stop_requested", {
          key: stopTask.key,
          runId: stopTask.runId,
          cardMessageId: action.messageId,
          chatId: action.chatId,
        });
        const result = await conversations.stopConversation(stopTask.key, async (reply) => {
          await transport?.replyText(action.messageId, reply);
        }, stopTask.runId);
        const status = result.status === "stopped"
          ? "stopped"
          : result.status === "failed"
            ? "failed"
            : "inactive";
        debugLog("feishu.card.stop_final_update_done", {
          key: stopTask.key,
          runId: stopTask.runId,
          cardMessageId: action.messageId,
          result: result.status,
        });
        return buildTaskStatusCard({
          key: stopTask.key,
          runId: stopTask.runId,
          status,
          phase: result.message,
        });
      }
      const resumePage = parseResumePageActionValue(action.value);
      if (resumePage) {
        const page = await conversations.listResumeSessions(resumePage.key, resumePage.scope, resumePage.page);
        return buildResumeCard(page);
      }
      const resumeSelect = parseResumeSelectActionValue(action.value);
      if (resumeSelect) {
        await conversations.resumeConversation(resumeSelect.key, resumeSelect.sessionPath, async (reply) => {
          await transport?.replyText(action.messageId, reply);
        });
        const page = await conversations.listResumeSessions(resumeSelect.key, resumeSelect.scope, resumeSelect.page);
        return buildResumeCard(page);
      }
      const selected = parseModelActionValue(action.value);
      if (!selected) return;
      await conversations.selectModel(selected.key, selected.provider, selected.modelId, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
      const models = await conversations.getAvailableModels();
      const currentModel = await conversations.getSelectedModel(selected.key);
      return buildModelCard(selected.key, models, currentModel);
    });
    try {
      await transport.start();
      gatewayLock.startHeartbeat();
      await gatewayLock.update("connected");
      updateStatus("connected");
      return "started";
    } catch (error) {
      updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
      await gatewayLock.release();
      gatewayLock = undefined;
      transport = undefined;
      throw error;
    }
  }

  async function stop() {
    await transport?.stop();
    transport = undefined;
    await gatewayLock?.release();
    gatewayLock = undefined;
    updateStatus(loadConfig() ? "disconnected" : "not configured");
  }

  function formatOwner(owner: GatewayOwner | undefined) {
    if (!owner) return "none";
    return `pid=${owner.pid}, status=${owner.status}, startedAt=${owner.startedAt}, heartbeatAt=${owner.heartbeatAt}, cwd=${owner.cwd}`;
  }

  function notifyDaemonStartResult(ctx: any, result: Awaited<ReturnType<typeof startDaemon>>) {
    if (result.status === "busy") {
      ctx.ui.notify(withBuildTag(`飞书连接已在后台运行。\n${formatOwner(result.owner)}`), "info");
      return;
    }
    ctx.ui.notify(withBuildTag(`飞书连接已启动。\nGateway pid=${result.pid}\nLog: ${DAEMON_LOG_PATH}`), "info");
  }

  function quoteShell(value: string) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  function daemonSpec() {
    const extensionPath = fileURLToPath(import.meta.url);
    const piBin = process.env.PI_BIN || "pi";
    const args = [
      "--mode", "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-builtin-tools",
      "-e", extensionPath,
    ];
    return { extensionPath, piBin, args };
  }

  function daemonCommand() {
    const { piBin, args } = daemonSpec();
    return `tail -f /dev/null | exec ${quoteShell(piBin)} ${args.map(quoteShell).join(" ")}`;
  }

  async function startDaemon(takeover = false) {
    return withDaemonSpawnLock(async () => {
      const cfg = loadConfig();
      if (!cfg) throw new Error(`Missing config. Run /feishu setup first. 配置不存在，请先运行 /feishu setup。`);
      let owner = readGatewayOwner();
      if (owner && owner.pid !== process.pid && !takeover) {
        return { status: "busy" as const, owner };
      }

      if (owner?.pid === process.pid || transport?.isRunning()) {
        await stop();
      } else if (owner && takeover) {
        try { process.kill(owner.pid, "SIGTERM"); } catch {}
        await sleep(800);
      }

      // Re-check while holding the spawn lock. Another TUI may have started it
      // while this process was waiting for the lock.
      owner = readGatewayOwner();
      if (owner && owner.pid !== process.pid && !takeover) {
        return { status: "busy" as const, owner };
      }

      reapDetachedDaemonProcesses({ keepPids: [process.pid] });
      ensureRoot();
      const logFd = openSync(DAEMON_LOG_PATH, "a");
      const child = spawn("bash", ["-lc", daemonCommand()], {
        detached: true,
        cwd: process.cwd(),
        env: { ...process.env, PI_FEISHU_DAEMON: "1" },
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();

      await sleep(1500);
      return { status: "started" as const, pid: child.pid, owner: readGatewayOwner() };
    });
  }

  async function stopDaemon() {
    const owner = readGatewayOwner();
    if (!owner) {
      reapDetachedDaemonProcesses();
      return { status: "none" as const };
    }
    if (owner.pid === process.pid) {
      await stop();
      reapDetachedDaemonProcesses({ keepPids: [process.pid] });
      return { status: "stopped-current" as const };
    }
    try {
      process.kill(owner.pid, "SIGTERM");
      await sleep(800);
      reapDetachedDaemonProcesses();
      return { status: "stopped" as const, owner };
    } catch (error) {
      return { status: "error" as const, owner, error };
    }
  }

  async function restartDaemon() {
    const stopped = await stopDaemon();
    if (stopped.status === "error") return { status: "error" as const, stopped };
    const started = await startDaemon(true);
    return { status: "restarted" as const, stopped, started };
  }

  pi.registerCommand("feishu", {
    description: "Feishu/Lark: setup, start, stop, restart, status, debug, autostart, reset",
    handler: async (args, ctx) => {
      uiRef = ctx.ui as any;
      const [cmdRaw] = args.trim().toLowerCase().split(/\s+/, 1);
      const cmd = cmdRaw || "status";
      try {
        if (cmd === "setup") {
          const configToStart = await runSetup(ctx);
          if (configToStart) {
            writeJson(CONFIG_PATH, configToStart);
            notifyDaemonStartResult(ctx, await startDaemon(false));
          }
          refreshStatusFromState();
          return;
        }
        if (cmd === "start") {
          notifyDaemonStartResult(ctx, await startDaemon(false));
          refreshStatusFromState();
          return;
        }
        if (cmd === "stop") {
          const result = await stopDaemon();
          if (result.status === "error") {
            ctx.ui.notify(`停止飞书连接失败：${result.error instanceof Error ? result.error.message : String(result.error)}\nOwner: ${formatOwner(result.owner)}`, "error");
            refreshStatusFromState();
            return;
          }
          ctx.ui.notify(result.status === "none" ? "飞书连接未在运行。" : "飞书连接已停止。", "info");
          refreshStatusFromState();
          return;
        }
        if (cmd === "restart") {
          const result = await restartDaemon();
          if (result.status === "error") {
            const stopped = result.stopped;
            ctx.ui.notify(`飞书连接重启失败：${stopped.error instanceof Error ? stopped.error.message : String(stopped.error)}\nOwner: ${formatOwner(stopped.owner)}`, "error");
            refreshStatusFromState();
            return;
          }
          ctx.ui.notify(`飞书连接已重启，最新代码和配置已生效。\nOwner: ${formatOwner(result.started.owner)}\nLog: ${DAEMON_LOG_PATH}`, "info");
          refreshStatusFromState();
          return;
        }
        if (cmd === "reset") {
          const ok = await uiConfirm(
            ctx,
            "确认重置飞书扩展？会删除配置和会话映射，但保留所有会话历史。 / Reset Feishu extension? This deletes config and conversation mappings, but keeps all session history.",
            false,
          );
          if (!ok) {
            ctx.ui.notify("Reset cancelled / 已取消重置", "info");
            return;
          }
          await stopDaemon();
          removePath(CONFIG_PATH);
          removePath(STATE_PATH);
          removePath(DEDUPE_PATH);
          removePath(`${DEDUPE_PATH}.lock`);
          removePath(BRIDGE_PATH);
          conversations.resetMemory();
          messageHandler.reset();
          ensureRoot();
          updateStatus("not configured");
          ctx.ui.notify(
            "Feishu extension reset. Session history was kept. Run /feishu setup. / 飞书扩展已重置，会话历史已保留，请运行 /feishu setup。",
            "info",
          );
          refreshStatusFromState();
          return;
        }
        if (cmd === "status") {
          refreshStatusFromState();
          const cfg = loadConfig();
          const owner = gatewayLock?.owner || readGatewayOwner();
          ctx.ui.notify(
            [
              `Status: ${lastStatusText || (loadConfig() ? "Feishu: disconnected" : "Feishu: not configured")}`,
              `Gateway owner: ${formatOwner(owner)}`,
              `Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart !== false}` : "missing"}`,
              `Path: ${CONFIG_PATH}`,
              `Gateway lock: ${gatewayLockPath()}`,
              `Debug: ${DEBUG_LOG_PATH}`,
              `Gateway log: ${DAEMON_LOG_PATH}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (cmd === "debug") {
          if (!existsSync(DEBUG_LOG_PATH)) {
            ctx.ui.notify("还没有飞书调试日志。请先在飞书里发一条消息给机器人。", "info");
            return;
          }
          const lines = readFileSync(DEBUG_LOG_PATH, "utf8").trim().split("\n").slice(-20);
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (cmd === "autostart") {
          const cfg = loadConfig();
          if (!cfg) {
            ctx.ui.notify("Missing config. Run /feishu setup first.", "warning");
            return;
          }
          cfg.autoStart = cfg.autoStart === false;
          writeJson(CONFIG_PATH, cfg);
          ctx.ui.notify(cfg.autoStart ? "飞书自动启动已开启。" : "飞书自动启动已关闭。", "info");
          refreshStatusFromState();
          return;
        }
        ctx.ui.notify("可用命令：/feishu setup | start | stop | restart | status | debug | autostart | reset", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  const bootConfig = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    uiRef = ctx.ui as any;
    startStatusRefresh();
  });

  if (bootConfig && bootConfig.autoStart !== false) {
    if (process.env.PI_FEISHU_DAEMON === "1") {
      start().then((result) => {
        if (typeof result === "object" && result.status === "owned") {
          console.error("[feishu] daemon found existing owner, exiting:", formatOwner(result.owner));
          process.exit(0);
        }
      }).catch((error) => {
        updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
        console.error("[feishu] daemon autoStart failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      });
    } else {
      startDaemon(false).catch((error) => {
        updateStatus("disconnected");
        console.error("[feishu] daemon spawn failed:", error instanceof Error ? error.message : error);
      });
    }
  }

  pi.on("session_shutdown", async () => {
    await stop();
    clearStatus();
  });
}

function parseCopyMarkdownActionValue(value: unknown): { copySourceId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_copy_markdown") return undefined;
  if (typeof raw.copySourceId !== "string" || !raw.copySourceId) return undefined;
  return { copySourceId: raw.copySourceId };
}

type DaemonProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
};

function reapDetachedDaemonProcesses(options: { keepPids?: number[]; extensionPath?: string } = {}) {
  if (process.platform === "win32") return;

  const keep = new Set(options.keepPids || []);
  const allProcesses = listProcesses();
  const roots = allProcesses.filter((proc) => looksLikeFeishuDaemon(proc.command, options.extensionPath));
  if (!roots.length) return;

  const byParent = new Map<number, DaemonProcessInfo[]>();
  for (const proc of allProcesses) {
    const children = byParent.get(proc.ppid) || [];
    children.push(proc);
    byParent.set(proc.ppid, children);
  }

  const toKill = new Set<number>();
  for (const proc of roots) {
    if (keep.has(proc.pid)) continue;
    toKill.add(proc.pid);
    collectDescendantPids(proc.pid, byParent, toKill, keep);
  }

  for (const pid of [...toKill].sort((a, b) => b - a)) {
    if (keep.has(pid) || pid === process.pid) continue;
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

function collectDescendantPids(pid: number, byParent: Map<number, DaemonProcessInfo[]>, toKill: Set<number>, keep: Set<number>) {
  for (const child of byParent.get(pid) || []) {
    if (keep.has(child.pid)) continue;
    toKill.add(child.pid);
    collectDescendantPids(child.pid, byParent, toKill, keep);
  }
}

function listProcesses() {
  const result = spawnSync("ps", ["-wwaxo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [] as DaemonProcessInfo[];

  const processes: DaemonProcessInfo[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3] || "";
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    processes.push({ pid, ppid, command });
  }
  return processes;
}

function looksLikeFeishuDaemon(command: string, extensionPath?: string) {
  const hasDaemonFlags = command.includes("--mode rpc")
    && command.includes("--no-extensions")
    && command.includes("--no-builtin-tools");
  if (!hasDaemonFlags) return false;
  if (extensionPath) return command.includes(extensionPath);
  return command.includes("feishu/index.ts");
}

function terminateLauncherParent() {
  if (process.platform === "win32") return;
  const parentPid = process.ppid;
  if (!parentPid || parentPid <= 1) return;

  const result = spawnSync("ps", ["-wwaxo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return;

  const line = result.stdout.split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${parentPid} `));
  if (!line) return;
  if (!line.includes("tail -f /dev/null") || !line.includes("feishu/index.ts")) return;
  try { process.kill(parentPid, "SIGTERM"); } catch {}
}

async function withDaemonSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${gatewayLockPath()}.spawn.lock`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tryAcquireSpawnLock(lockPath)) {
      try {
        return await fn();
      } finally {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
      }
    }
    await sleep(25);
  }
  // Last resort: run without the spawn lock. The daemon-side gateway lock still
  // prevents duplicate live Feishu connections.
  return fn();
}

function tryAcquireSpawnLock(lockPath: string) {
  try {
    mkdirSync(lockPath, { recursive: false });
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > 30_000) rmSync(lockPath, { recursive: true, force: true });
    } catch {}
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
