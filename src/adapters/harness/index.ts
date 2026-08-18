/**
 * DeepSeek Harness 插件入口（cordis apply）：
 * - 生命周期跟随 Cordis 插件（ctx.effect 启停 Transport），不 spawn 任何子进程
 * - 只通过公开 Service API（ctx.agents / ctx.sessions / ctx.sessionQuery / ctx.llm）工作
 * - /feishu 管理命令（setup/status/debug/autostart/reset）：依赖宿主 commands 服务，
 *   缺失时防御式跳过，不影响桥接本体；配置与 Pi 完全独立，autoStart 控制是否启动
 */
import type { Context } from "@deepseek-ai/cordis";
import LocalAttachmentStore from "@deepseek-ai/dsh-attachment-local";
import { homedir } from "node:os";
import { join } from "node:path";
import { FeishuBridgeRuntime } from "../../feishu/bridge-runtime.ts";
import { FeishuBridgeStore } from "../../feishu/bridge-store.ts";
import { FeishuDelivery } from "../../feishu/delivery.ts";
import { FeishuMessageHandler } from "../../feishu/message-handler.ts";
import { acquireGatewayLock, type GatewayLockHandle } from "../../feishu/gateway-lock.ts";
import { HARNESS_SOURCE, loadConfig, setRuntimeSource } from "../../feishu/config.ts";
import { debugLog } from "../../feishu/debug.ts";
import { BotUnavailableError, FeishuTransport } from "../../feishu/transport.ts";
import { createCardActionHandler } from "../../feishu/card-actions.ts";
import type { FeishuConfig } from "../../feishu/types.ts";
import { HarnessConversationRuntime } from "./HarnessConversationRuntime.ts";
import { registerFeishuCommand } from "./feishu-command.ts";
import { runHarnessSetup } from "./setup.ts";

/** 插件名（cordis.patch.yml 引用）。 */
export const name = "feishu-harness";

/**
 * 需要的公开服务：agent 驱动、会话持久化、历史查询、模型目录、命令注册。
 * commands 由 dsh-base 内置（dsh-commands）；声明 inject 是 cordis 读取服务的前提，
 * 实际注册仍走防御式路径（feishu-command.ts），宿主缺失时不阻断插件。
 */
export const inject = ["agents", "sessions", "sessionQuery", "llm", "commands"];

/** /feishu status 展示的连接状态（由启动流程维护） */
let connectionStatus = "未启动 / not started";

export function apply(ctx: Context) {
  // Harness 使用自己独立的配置/状态/记录文件（config.harness.json 等），与 Pi 互不干扰
  setRuntimeSource(HARNESS_SOURCE);
  ensureAttachmentStore(ctx);
  registerFeishuCommand(ctx, {
    getConnectionStatus: () => connectionStatus,
    // 重新配置场景：已有配置时先在终端确认覆盖
    runSetup: () => runHarnessSetup({ confirmOverwrite: true }),
  });
  void (async () => {
    let cfg = loadConfig();
    if (!cfg) {
      // 第一次使用：没有配置时进入终端向导，配置完成直接继续启动
      console.log("[feishu] 未检测到飞书机器人配置，进入配置向导...");
      cfg = await runHarnessSetup();
      if (!cfg) {
        console.log("[feishu] 配置未完成，Harness 插件不启动。可重新运行本命令再次配置，或在 DSH 里运行 /feishu setup。");
        connectionStatus = "未配置 / not configured";
        return;
      }
    }
    if (cfg.autoStart === false) {
      console.log("[feishu] 飞书自动启动已关闭（config.json 中 autoStart=false），不启动连接。");
      connectionStatus = "未启动（autoStart 已关闭）/ not started (autoStart off)";
      return;
    }
    startFeishu(ctx, cfg);
  })();
}

/**
 * 图片输入依赖宿主 attachments 服务；当前部分 dsh 部署未挂载它，
 * 缺失时由本插件自行挂载官方本地存储实现（存到 ~/.dsh/attachments）。
 * 已挂载时直接复用，不重复注册。
 */
function ensureAttachmentStore(ctx: Context) {
  try {
    if ((ctx as any).get("attachments")) return;
  } catch {
    // 服务未挂载，继续自行注册
  }
  try {
    const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
    ctx.plugin(LocalAttachmentStore, { dshHome });
    console.log("[feishu] 宿主未提供图片附件服务，飞书插件已挂载本地附件存储。");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog("feishu.harness.attachment_store_failed", { error: message });
    console.warn(`[feishu] 图片附件服务挂载失败，图片输入将不可用：${message}`);
  }
}

function startFeishu(ctx: Context, cfg: FeishuConfig) {
  const bridgeStore = new FeishuBridgeStore();
  const delivery = new FeishuDelivery(() => transport);
  const bridge = new FeishuBridgeRuntime(bridgeStore, delivery);
  const conversations = new HarnessConversationRuntime(ctx, process.cwd(), bridge, {
    promptNotifySec: cfg.promptNotifySec,
    promptTimeoutSec: cfg.promptTimeoutSec,
  });
  const messageHandler = new FeishuMessageHandler(conversations, () => transport, bridgeStore);

  let transport: FeishuTransport | undefined;
  let gatewayLock: GatewayLockHandle | undefined;

  ctx.effect(() => {
    void (async () => {
      // 与 Pi daemon 等进程共用 gateway lock（按机器人凭证区分），保证同一机器人只有一个连接
      connectionStatus = "连接中 / connecting";
      const lockResult = await acquireGatewayLock(process.cwd(), false, cfg.appId);
      if (lockResult.status === "busy") {
        console.log(`[feishu] 飞书连接已被其他进程占用（pid=${lockResult.owner.pid}），本插件不启动。`);
        connectionStatus = `被其他进程占用（pid=${lockResult.owner.pid}）/ owned by another process`;
        return;
      }
      gatewayLock = lockResult.handle;
      gatewayLock.setOnLost(async () => {
        await transport?.stop();
        transport = undefined;
        connectionStatus = "已断开（连接锁丢失）/ disconnected (lock lost)";
        console.log("[feishu] 飞书连接锁丢失，已断开连接。");
      });

      transport = new FeishuTransport(
        cfg,
        (msg) => messageHandler.handle(msg),
        createCardActionHandler(conversations, () => transport),
      );
      try {
        await transport.start();
        gatewayLock.startHeartbeat();
        await gatewayLock.update("connected");
        connectionStatus = "已连接 / connected";
        console.log("[feishu] 飞书连接已启动（DeepSeek Harness 插件）。");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLog("feishu.harness.start_failed", { error: message });
        connectionStatus = `启动失败：${message} / start failed`;
        console.error(`[feishu] 飞书连接启动失败：${message}`);
        await gatewayLock.release().catch(() => undefined);
        gatewayLock = undefined;
        if (error instanceof BotUnavailableError) {
          console.error("[feishu] 机器人不可用：请确认飞书应用已发布并启用机器人能力。");
        }
      }
    })();

    // 插件卸载时停止 Transport、释放连接锁、回收全部 agent
    return async () => {
      await transport?.stop();
      transport = undefined;
      await gatewayLock?.release().catch(() => undefined);
      gatewayLock = undefined;
      await conversations.dispose();
      connectionStatus = "已停止（插件卸载）/ stopped (plugin unloaded)";
      console.log("[feishu] 飞书连接已停止（Harness 插件卸载）。");
    };
  });
}
