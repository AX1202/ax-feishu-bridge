/**
 * 飞书交互卡片回调的统一处理（/model、/thinking、/resume、停止按钮、复制按钮）。
 * 只依赖 ConversationRuntime 接口与飞书公共层，各 Runtime 适配器直接复用。
 */
import { buildCardKitCardJson } from "./card-builder.ts";
import {
  buildModelCard,
  buildResumeCard,
  buildThinkingCard,
  parseModelActionValue,
  parseResumePageActionValue,
  parseResumeSelectActionValue,
  parseThinkingActionValue,
} from "./cards.ts";
import { debugLog } from "./debug.ts";
import { parseStopTaskActionValue } from "./reply-card.ts";
import type { ConversationRuntime } from "./runtime.ts";
import type { FeishuTransport } from "./transport.ts";
import type { FeishuCardAction } from "./types.ts";

export function createCardActionHandler(
  conversations: ConversationRuntime,
  getTransport: () => FeishuTransport | undefined,
) {
  return async (action: FeishuCardAction) => {
    const transport = getTransport();
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
      // 停止时由 ReplyCard.stopImmediately 更新同一张卡；回调不再另发文本
      const result = await conversations.stopConversation(stopTask.key, async () => undefined, stopTask.runId);
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
      // CardKit 流式卡是 schema 2.0；回调必须返回 2.0，否则会 200830/200671
      // body 优先用 cardkit.close() 已写入的累计文本，避免覆盖已输出内容
      return buildCardKitCardJson({
        status,
        body: "body" in result ? result.body : result.message || "已停止",
        key: stopTask.key,
        runId: stopTask.runId,
        streaming: false,
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

    const selectedThinking = parseThinkingActionValue(action.value);
    if (selectedThinking) {
      await conversations.selectThinkingLevel(selectedThinking.key, selectedThinking.level, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
      const [currentModel, thinking] = await Promise.all([
        conversations.getSelectedModel(selectedThinking.key),
        conversations.getThinkingStatus(selectedThinking.key),
      ]);
      return buildThinkingCard(selectedThinking.key, currentModel, thinking);
    }

    const selected = parseModelActionValue(action.value);
    if (!selected) return;
    await conversations.selectModel(selected.key, selected.provider, selected.modelId, async (reply) => {
      await transport?.replyText(action.messageId, reply);
    });
    const models = await conversations.getAvailableModels();
    const currentModel = await conversations.getSelectedModel(selected.key);
    return buildModelCard(selected.key, models, currentModel);
  };
}

function parseCopyMarkdownActionValue(value: unknown): { copySourceId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_copy_markdown") return undefined;
  if (typeof raw.copySourceId !== "string" || !raw.copySourceId) return undefined;
  return { copySourceId: raw.copySourceId };
}
