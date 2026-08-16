import { loadConfig } from "./config.js";
import { debugLog } from "./debug.js";
import type { FeishuRoute } from "./types.js";
import type { FeishuTransport } from "./transport.js";
import { buildMarkdownCards, buildPostMessages, chooseMessageMode } from "./rich-text.js";

const TEXT_CHUNK_MAX_BYTES = 120 * 1024;

export class FeishuDelivery {
  private sdkClient: any;

  constructor(private readonly getTransport: () => FeishuTransport | undefined) {}

  async send(route: FeishuRoute, text: string) {
    const transport = this.getTransport();
    if (transport?.isRunning()) {
      if (route.threadMessageId) await transport.replyText(route.threadMessageId, text);
      else await transport.sendText(route.chatId, text);
      return;
    }

    await this.ensureClient();
    if (route.threadMessageId) await this.replyText(route.threadMessageId, text);
    else await this.sendText(route.chatId, text);
  }

  private async ensureClient() {
    if (this.sdkClient) return;
    const cfg = loadConfig();
    if (!cfg) throw new Error("Missing Feishu config");
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = cfg.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.sdkClient = new lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });
  }

  private async replyText(messageId: string, text: string) {
    const mode = chooseMessageMode(text);
    if (mode === "interactive") {
      await this.replyMarkdownCard(messageId, text);
      return;
    }
    if (mode === "post") {
      await this.replyPost(messageId, text);
      return;
    }
    debugLog("feishu.bridge.reply", { messageId, length: text.length });
    for (const chunk of splitText(text, TEXT_CHUNK_MAX_BYTES)) {
      await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
      });
    }
  }

  private async sendText(chatId: string, text: string) {
    const mode = chooseMessageMode(text);
    if (mode === "interactive") {
      await this.sendMarkdownCard(chatId, text);
      return;
    }
    if (mode === "post") {
      await this.sendPost(chatId, text);
      return;
    }
    debugLog("feishu.bridge.send", { chatId, length: text.length });
    for (const chunk of splitText(text, TEXT_CHUNK_MAX_BYTES)) {
      await this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      });
    }
  }

  private async replyMarkdownCard(messageId: string, text: string) {
    const cfg = loadConfig();
    debugLog("feishu.bridge.reply_markdown_card", { messageId, length: text.length });
    for (const card of buildMarkdownCards(text, cfg?.language)) {
      await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "interactive", content: JSON.stringify(card) },
      });
    }
  }

  private async sendMarkdownCard(chatId: string, text: string) {
    const cfg = loadConfig();
    debugLog("feishu.bridge.send_markdown_card", { chatId, length: text.length });
    for (const card of buildMarkdownCards(text, cfg?.language)) {
      await this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
    }
  }

  private async replyPost(messageId: string, text: string) {
    const cfg = loadConfig();
    debugLog("feishu.bridge.reply_post", { messageId, length: text.length });
    for (const post of buildPostMessages(text, cfg?.language)) {
      await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "post", content: JSON.stringify(post) },
      });
    }
  }

  private async sendPost(chatId: string, text: string) {
    const cfg = loadConfig();
    debugLog("feishu.bridge.send_post", { chatId, length: text.length });
    for (const post of buildPostMessages(text, cfg?.language)) {
      await this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: JSON.stringify(post),
        },
      });
    }
  }
}

function splitText(text: string, maxBytes: number) {
  const out: string[] = [];
  let rest = text.trim() || "(empty response)";
  while (textPayloadSize(rest) > maxBytes) {
    const cut = findCutIndexByBytes(rest, maxBytes);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

function findCutIndexByBytes(text: string, maxBytes: number) {
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const safeMid = avoidHalfSurrogate(text, mid);
    if (safeMid > 0 && textPayloadSize(text.slice(0, safeMid)) <= maxBytes) {
      best = safeMid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const newline = text.lastIndexOf("\n", best);
  if (newline > 0 && newline >= Math.floor(best * 0.6)) return newline + 1;
  return Math.max(1, best);
}

function avoidHalfSurrogate(text: string, index: number) {
  if (index <= 0 || index >= text.length) return index;
  const prev = text.charCodeAt(index - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return index - 1;
  return index;
}

function byteSize(text: string) {
  return Buffer.byteLength(text, "utf8");
}

function textPayloadSize(text: string) {
  return byteSize(JSON.stringify({ text }));
}
