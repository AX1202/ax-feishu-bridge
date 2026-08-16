/**
 * DeepSeek Harness 插件入口（cordis apply）：
 * - 生命周期跟随 Cordis 插件（ctx.effect 启停 Transport），不 spawn 任何子进程
 * - 只通过公开 Service API（ctx.agents / ctx.sessions / ctx.sessionQuery / ctx.llm）工作
 * - 无管理命令（Harness 无 registerCommand）；配置与 PI 共用 config.json，autoStart 控制是否启动
 */
import type { Context } from "@deepseek-ai/cordis";
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
import { runHarnessSetup } from "./setup.ts";

/** 插件名（cordis.patch.yml 引用）。 */
export const name = "feishu-harness";

/** 需要的公开服务：agent 驱动、会话持久化、历史查询、模型目录。 */
export const inject = ["agents", "sessions", "sessionQuery", "llm"];

export function apply(ctx: Context) {
  // Harness 使用自己独立的配置/状态/记录文件（config.harness.json 等），与 Pi 互不干扰
  setRuntimeSource(HARNESS_SOURCE);
  void (async () => {
    let cfg = loadConfig();
    if (!cfg) {
      // 第一次使用：没有配置时进入终端向导，配置完成直接继续启动
      console.log("[feishu] 未检测到飞书机器人配置，进入配置向导...");
      cfg = await runHarnessSetup();
      if (!cfg) {
        console.log("[feishu] 配置未完成，Harness 插件不启动。可重新运行本命令再次配置。");
        return;
      }
    }
    if (cfg.autoStart === false) {
      console.log("[feishu] 飞书自动启动已关闭（config.json 中 autoStart=false），不启动连接。");
      return;
    }
    startFeishu(ctx, cfg);
  })();
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
      const lockResult = await acquireGatewayLock(process.cwd(), false, cfg.appId);
      if (lockResult.status === "busy") {
        console.log(`[feishu] 飞书连接已被其他进程占用（pid=${lockResult.owner.pid}），本插件不启动。`);
        return;
      }
      gatewayLock = lockResult.handle;
      gatewayLock.setOnLost(async () => {
        await transport?.stop();
        transport = undefined;
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
        console.log("[feishu] 飞书连接已启动（DeepSeek Harness 插件）。");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLog("feishu.harness.start_failed", { error: message });
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
      console.log("[feishu] 飞书连接已停止（Harness 插件卸载）。");
    };
  });
}
