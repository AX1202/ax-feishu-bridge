import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BRIDGE_PI_PATH, CHILD_SESSION_ENV, CONFIG_PI_PATH, DAEMON_LOG_PATH, DEBUG_PI_LOG_PATH, DEDUPE_PI_PATH, ensureRoot, loadConfig, mask, removePath, PI_SOURCE, setRuntimeSource, STATE_PI_PATH, writeJson } from "../../feishu/config.ts";
import { debugLog } from "../../feishu/debug.ts";
import { FeishuBridgeRuntime } from "../../feishu/bridge-runtime.ts";
import { FeishuBridgeStore } from "../../feishu/bridge-store.ts";
import { FeishuDelivery } from "../../feishu/delivery.ts";
import { acquireGatewayLock, gatewayLockPath, readGatewayOwner, type GatewayLockHandle, type GatewayOwner } from "../../feishu/gateway-lock.ts";
import { FeishuMessageHandler } from "../../feishu/message-handler.ts";
import { runSetup, uiConfirm } from "./setup.ts";
import {
  RUNTIME_CONFIG_KEYS,
  clearRuntimeOverrides,
  formatRuntimeConfig,
  getRuntimeOverrides,
  setRuntimeConfig,
} from "../../feishu/runtime-config.ts";
import { BotUnavailableError, FeishuTransport } from "../../feishu/transport.ts";
import type { FeishuConfig, FeishuStatus } from "../../feishu/types.ts";
import { createCardActionHandler } from "../../feishu/card-actions.ts";
import { PiConversationRuntime, handlePiMessageEnd } from "./PiConversationRuntime.ts";

/**
 * Pi Runtime 适配器的扩展入口（薄 PI bootstrap）：
 * 只保留 Pi 相关的启动/命令/daemon/工具注册逻辑，
 * 其余飞书逻辑全部在 src/feishu 公共层。
 *
 * @param options.extensionPath 当前扩展入口文件路径（daemon 用 -e 重新加载它）。
 */
export default function createPiFeishuExtension(pi: ExtensionAPI, options?: { extensionPath?: string }) {
  const extensionEntry = options?.extensionPath || fileURLToPath(import.meta.url);
  // Pi 进程使用 Pi 自己的配置/状态/记录文件（默认即 Pi，显式声明便于维护）
  setRuntimeSource(PI_SOURCE);
  if (process.env[CHILD_SESSION_ENV] === "1") {
    return;
  }

  // 模型可读写白名单配置（热更新 + 落盘）
  registerFeishuConfigTools(pi);

  // 注意：不要在这里调用 hideFeishuConfigTools(pi)。getActiveTools()/setActiveTools()
  // 是会话级 API，在扩展加载期（session_start 之前）调用会抛错，导致后续
  // /feishu 命令注册等逻辑全部不执行。隐藏逻辑统一放在 session_start 里。

  let transport: FeishuTransport | undefined;
  let gatewayLock: GatewayLockHandle | undefined;
  const bridgeStore = new FeishuBridgeStore();
  const delivery = new FeishuDelivery(() => transport);
  const bridge = new FeishuBridgeRuntime(bridgeStore, delivery);
  const initialConfig = loadConfig();
  const conversations = new PiConversationRuntime(process.cwd(), bridge, {
    promptNotifySec: initialConfig?.promptNotifySec,
    promptTimeoutSec: initialConfig?.promptTimeoutSec,
  });
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

  function currentGatewayOwner() {
    return readGatewayOwner(loadConfig()?.appId);
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
    const owner = currentGatewayOwner();
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
    handlePiMessageEnd(bridge, ctx.sessionManager.getSessionId(), undefined, event.message);
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
    const lockResult = await acquireGatewayLock(process.cwd(), Boolean(options.takeover), cfg.appId);
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
    transport = new FeishuTransport(cfg, (msg) => messageHandler.handle(msg), createCardActionHandler(conversations, () => transport));
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
    const piBin = process.env.PI_BIN || "pi";
    const args = [
      "--mode", "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-builtin-tools",
      "-e", extensionEntry,
    ];
    return { extensionPath: extensionEntry, piBin, args };
  }

  function daemonCommand() {
    const { piBin, args } = daemonSpec();
    return `tail -f /dev/null | exec ${quoteShell(piBin)} ${args.map(quoteShell).join(" ")}`;
  }

  async function startDaemon(takeover = false) {
    return withDaemonSpawnLock(async () => {
      const cfg = loadConfig();
      if (!cfg) throw new Error(`Missing config. Run /feishu setup first. 配置不存在，请先运行 /feishu setup。`);
      let owner = currentGatewayOwner();
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
      owner = currentGatewayOwner();
      if (owner && owner.pid !== process.pid && !takeover) {
        return { status: "busy" as const, owner };
      }

      reapDetachedDaemonProcesses({ keepPids: [process.pid] });
      ensureRoot();
      const logFd = openSync(DAEMON_LOG_PATH, "a");
      let child: ChildProcess;
      if (process.platform === "win32") {
        // Windows 上 spawn("bash", ...) 可能解析到 WSL 的 bash.exe（而非 Git Bash），
        // 导致 daemon 在 WSL 环境里启动、路径和凭据全部错乱后立即退出。
        // 因此 Windows 直接用 node 拉起 Pi CLI 入口，绕开 bash 管道。
        const npmPrefix = process.env.APPDATA
          ? `${process.env.APPDATA}\\npm`
          : `${process.env.USERPROFILE}\\AppData\\Roaming\\npm`;
        const piCliEntry = process.env.PI_CLI_ENTRY
          || `${npmPrefix}\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js`;
        const { args } = daemonSpec();
        child = spawn("node", [piCliEntry, ...args], {
          detached: true,
          cwd: process.cwd(),
          env: { ...process.env, PI_FEISHU_DAEMON: "1" },
          stdio: ["pipe", logFd, logFd],
        });
        // 保持 stdin 打开，等价于 Linux 侧 `tail -f /dev/null |` 的作用，
        // 否则 pi --mode rpc 会在 stdin EOF 后退出。
        if (child.stdin) (child.stdin as unknown as Readable).resume();
      } else {
        child = spawn("bash", ["-lc", daemonCommand()], {
          detached: true,
          cwd: process.cwd(),
          env: { ...process.env, PI_FEISHU_DAEMON: "1" },
          stdio: ["ignore", logFd, logFd],
        });
      }
      child.unref();

      await sleep(1500);
      return { status: "started" as const, pid: child.pid, owner: currentGatewayOwner() };
    });
  }

  async function stopDaemon() {
    const owner = currentGatewayOwner();
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
    description: "Feishu/Lark: setup, start, stop, restart, status, debug, autostart, reset, tools on|off",
    handler: async (args, ctx) => {
      uiRef = ctx.ui as any;
      const tokens = args.trim().toLowerCase().split(/\s+/, 2);
      const cmd = tokens[0] || "status";
      const cmdArg = tokens[1] || "";
      try {
        if (cmd === "setup") {
          const configToStart = await runSetup(ctx);
          if (configToStart) {
            writeJson(CONFIG_PI_PATH, configToStart);
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
          removePath(CONFIG_PI_PATH);
          removePath(STATE_PI_PATH);
          removePath(DEDUPE_PI_PATH);
          removePath(`${DEDUPE_PI_PATH}.lock`);
          removePath(BRIDGE_PI_PATH);
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
          const owner = gatewayLock?.owner || currentGatewayOwner();
          ctx.ui.notify(
            [
              `Status: ${lastStatusText || (loadConfig() ? "Feishu: disconnected" : "Feishu: not configured")}`,
              `Gateway owner: ${formatOwner(owner)}`,
              `Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart !== false}` : "missing"}`,
              `Path: ${CONFIG_PI_PATH}`,
              `Gateway lock: ${gatewayLockPath()}`,
              `Debug: ${DEBUG_PI_LOG_PATH}`,
              `Gateway log: ${DAEMON_LOG_PATH}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (cmd === "debug") {
          if (!existsSync(DEBUG_PI_LOG_PATH)) {
            ctx.ui.notify("还没有飞书调试日志。请先在飞书里发一条消息给机器人。", "info");
            return;
          }
          const lines = readFileSync(DEBUG_PI_LOG_PATH, "utf8").trim().split("\n").slice(-20);
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
          writeJson(CONFIG_PI_PATH, cfg);
          ctx.ui.notify(cfg.autoStart ? "飞书自动启动已开启。" : "飞书自动启动已关闭。", "info");
          refreshStatusFromState();
          return;
        }
        if (cmd === "tools") {
          const active = pi.getActiveTools();
          const enabled = FEISHU_CONFIG_TOOLS.every((t) => active.includes(t));
          if (cmdArg === "on") {
            if (enabled) {
              ctx.ui.notify("飞书配置工具已启用。", "info");
              return;
            }
            pi.setActiveTools([...active, ...FEISHU_CONFIG_TOOLS]);
            ctx.ui.notify("飞书配置工具已启用（仅当前会话生效）。", "info");
            return;
          }
          if (cmdArg === "off") {
            if (!enabled) {
              ctx.ui.notify("飞书配置工具已隐藏。", "info");
              return;
            }
            hideFeishuConfigTools(pi);
            ctx.ui.notify("飞书配置工具已隐藏。", "info");
            return;
          }
          ctx.ui.notify(
            `飞书配置工具当前：${enabled ? "已启用" : "已隐藏"}。用 /feishu tools on|off 切换。`,
            "info",
          );
          return;
        }
        ctx.ui.notify("可用命令：/feishu setup | start | stop | restart | status | debug | autostart | reset | tools on|off", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  const bootConfig = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    uiRef = ctx.ui as any;
    startStatusRefresh();
    // 每个新会话默认隐藏配置工具，保持提示词干净；用户可用 /feishu tools on 打开。
    hideFeishuConfigTools(pi);
  });

  if (bootConfig?.autoStart) {
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

function textToolResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

// feishu_config_* 工具名单：默认从提示词隐藏，可用 /feishu tools on|off 切换。
const FEISHU_CONFIG_TOOLS = [
  "feishu_config_get",
  "feishu_config_set",
  "feishu_config_clear",
];

function hideFeishuConfigTools(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const filtered = active.filter((t) => !FEISHU_CONFIG_TOOLS.includes(t));
  if (filtered.length !== active.length) {
    pi.setActiveTools(filtered);
  }
}

function registerFeishuConfigTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "feishu_config_get",
    label: "Feishu Config Get",
    description:
      "Read Feishu runtime config whitelist (groupPolicy, groupKeywords, streaming, etc). Secrets are never returned.",
    promptSnippet: "Read Feishu bot runtime settings (keywords, mention policy, streaming).",
    parameters: Type.Object({}),
    async execute() {
      const cfg = loadConfig();
      if (!cfg) {
        return textToolResult("Feishu config unavailable (missing FEISHU_APP_ID/SECRET).");
      }
      return textToolResult(formatRuntimeConfig(cfg, getRuntimeOverrides()));
    },
  });

  pi.registerTool({
    name: "feishu_config_set",
    label: "Feishu Config Set",
    description:
      `Set a Feishu runtime config key. HOT-RELOADS immediately and persists to runtime-overrides.json — NEVER tell the user to restart the container or edit docker-compose.yml. Allowed keys: ${RUNTIME_CONFIG_KEYS.join(", ")}. Do not set appId/appSecret.`,
    promptSnippet: "Update Feishu group trigger keywords / streaming / emoji at runtime (no restart).",
    promptGuidelines: [
      "Only use whitelisted keys; never attempt to set app credentials.",
      "After set, subsequent group messages use the new settings immediately — no docker restart.",
      "Never edit docker-compose.yml or env files for these settings; use this tool only.",
    ],
    parameters: Type.Object({
      key: Type.String({ description: `One of: ${RUNTIME_CONFIG_KEYS.join(", ")}` }),
      value: Type.String({ description: "New value (keywords comma-separated; bool true/false; numbers as digits)" }),
    }),
    async execute(_id, params) {
      const key = String((params as any)?.key || "").trim();
      const value = String((params as any)?.value ?? "");
      if (!key) return textToolResult("key is required");
      const result = setRuntimeConfig(key, value);
      if (result.ok === false) return textToolResult(`Error: ${result.error}`);
      const cfg = loadConfig();
      return textToolResult(
        [
          `Updated ${result.key} = ${Array.isArray(result.value) ? result.value.join(", ") : String(result.value)}`,
          "Hot-reloaded and persisted (runtime-overrides.json).",
          "",
          cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "feishu_config_clear",
    label: "Feishu Config Clear",
    description: "Clear one runtime override key or all overrides (reverts to env/base config).",
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: "Whitelist key, or omit/all for all overrides" })),
    }),
    async execute(_id, params) {
      const target = String((params as any)?.key || "all").trim() || "all";
      const result = clearRuntimeOverrides(target);
      if (result.ok === false) return textToolResult(`Error: ${result.error}`);
      const cfg = loadConfig();
      return textToolResult(
        [
          target === "all" ? "Cleared all runtime overrides." : `Cleared override: ${target}`,
          "",
          cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });
}
