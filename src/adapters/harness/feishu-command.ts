/**
 * DSH 侧 /feishu 管理命令注册（setup / status / debug / autostart / reset）。
 *
 * 防御式接入：宿主 DSH 未必提供 commands 服务（或未文档化、随版本变动），
 * 缺失时静默跳过注册，不影响桥接本体。
 *
 * 交互形态说明：命令输出为返回给 DSH 的纯文本（web 输入框/CLI 呈现）；
 * setup 的问答与二维码仍在 DSH 进程所在终端进行，命令只是触发器。
 */
import { existsSync, readFileSync } from "node:fs";
import { ensureRoot, getRuntimeSource, loadConfig, mask, removePath, writeJson } from "../../feishu/config.ts";
import { debugLog } from "../../feishu/debug.ts";
import { gatewayLockPath, readGatewayOwner, type GatewayOwner } from "../../feishu/gateway-lock.ts";
import type { FeishuConfig } from "../../feishu/types.ts";

export type FeishuCommandDeps = {
  /** 当前飞书连接状态的可读描述（由插件入口维护） */
  getConnectionStatus: () => string;
  /** 运行终端配置向导；用户放弃时返回 undefined */
  runSetup: () => Promise<FeishuConfig | undefined>;
};

type CommandInvocation = { rawInput?: string };
type CommandResult = { kind: "success"; text: string };
type CommandDescriptor = {
  name: string;
  description: string;
  /** DSH web 输入框仅在声明了 input 时才把 "/feishu xxx" 路由给命令，否则按普通聊天发给模型 */
  input: { hint: string };
  handler: (invocation: CommandInvocation) => Promise<CommandResult> | CommandResult;
};
type CommandsService = { register?: (descriptor: CommandDescriptor) => void };

const USAGE = "用法：/feishu setup | status | debug | autostart | reset confirm";

function formatOwner(owner: GatewayOwner | undefined) {
  if (!owner) return "none";
  return `pid=${owner.pid}, status=${owner.status}, startedAt=${owner.startedAt}, heartbeatAt=${owner.heartbeatAt}, cwd=${owner.cwd}`;
}

/** 注册 /feishu 命令；宿主无 commands 服务时返回 false（不抛错）。 */
export function registerFeishuCommand(ctx: unknown, deps: FeishuCommandDeps): boolean {
  let commands: CommandsService | undefined;
  try {
    // cordis 对未提供的服务属性读取会直接抛错，用 try/catch 兜住
    commands = (ctx as { commands?: CommandsService }).commands;
  } catch {
    commands = undefined;
  }
  if (!commands || typeof commands.register !== "function") {
    debugLog("feishu.harness.commands_service_unavailable");
    return false;
  }
  try {
    commands.register({
      name: "feishu",
      description: "Feishu/Lark bridge — setup | status | debug | autostart | reset",
      input: { hint: "setup | status | debug | autostart | reset confirm" },
      handler: async (invocation) => {
        const parts = (invocation?.rawInput ?? "").trim().split(/\s+/);
        const cmd = (parts[0] ?? "").toLowerCase();
        const args = parts.slice(1);
        try {
          return { kind: "success", text: await runSubcommand(cmd, args, deps) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          debugLog("feishu.harness.command_error", { cmd, error: message });
          return { kind: "success", text: `命令执行失败：${message}` };
        }
      },
    });
    return true;
  } catch (error) {
    debugLog("feishu.harness.command_register_failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function runSubcommand(cmd: string, args: string[], deps: FeishuCommandDeps): Promise<string> {
  const source = getRuntimeSource();

  switch (cmd) {
    case "":
    case "help":
      return USAGE;

    case "status": {
      const cfg = loadConfig();
      const owner = readGatewayOwner(cfg?.appId);
      return [
        `Status: ${deps.getConnectionStatus()}`,
        `Gateway owner: ${formatOwner(owner)}`,
        `Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart !== false}` : "missing"}`,
        `Path: ${source.configPath}`,
        `Gateway lock: ${gatewayLockPath()}`,
        `Debug: ${source.debugLogPath}`,
      ].join("\n");
    }

    case "debug": {
      if (!existsSync(source.debugLogPath)) {
        return "还没有飞书调试日志。请先在飞书里发一条消息给机器人。";
      }
      const lines = readFileSync(source.debugLogPath, "utf8").trim().split("\n").slice(-20);
      return lines.join("\n");
    }

    case "autostart": {
      const cfg = loadConfig();
      if (!cfg) return "缺少配置。请先运行 /feishu setup。 / Missing config. Run /feishu setup first.";
      cfg.autoStart = cfg.autoStart === false;
      writeJson(source.configPath, cfg);
      return (cfg.autoStart ? "飞书自动启动已开启。" : "飞书自动启动已关闭。") + "下次启动 DSH（或重新加载插件）时生效。";
    }

    case "reset": {
      if (args[0]?.toLowerCase() !== "confirm") {
        return [
          "重置会删除飞书配置和会话映射，但保留所有会话历史。",
          "确认请运行：/feishu reset confirm",
        ].join("\n");
      }
      removePath(source.configPath);
      removePath(source.statePath);
      removePath(source.dedupePath);
      removePath(`${source.dedupePath}.lock`);
      removePath(source.bridgePath);
      ensureRoot();
      return [
        "飞书桥接已重置（会话历史已保留）。",
        "若飞书连接还在运行，请在 web UI 里把插件开关关闭再打开（或重启 DSH），下次启动将重新进入配置向导。",
      ].join("\n");
    }

    case "setup": {
      const config = await deps.runSetup();
      if (!config) return "配置未完成，现有配置未改动。";
      return [
        `飞书配置已保存（App ID: ${mask(config.appId)}，domain: ${config.domain}）。`,
        "刚才的问答与二维码在 DSH 进程所在终端进行。",
        "若飞书连接正以旧配置运行，请在 web UI 里把插件开关关闭再打开（或重启 DSH）让新配置生效。",
      ].join("\n");
    }

    default:
      return `未知子命令：${cmd}\n${USAGE}`;
  }
}
