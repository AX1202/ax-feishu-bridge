import type { FeishuCardAction, FeishuConfig, FeishuMessage } from "./types.ts";
import { loadConfig } from "./config.ts";
import { debugLog } from "./debug.ts";
import {
  extractPlainTextForTrigger,
  shouldAcceptGroupMessage,
} from "./group-trigger.ts";
import { buildMarkdownCardParts, buildPostMessages, chooseMessageMode } from "./rich-text.ts";
import { withRetry } from "./retry.ts";
import { extractTextFromMsgType } from "./interactive-card.ts";
import { FeishuCardActionWebhook } from "./card-action-webhook.ts";

const TEXT_CHUNK_MAX_BYTES = 120 * 1024;

export class BotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotUnavailableError";
  }
}

export class FeishuTransport {
  private sdkClient: any;
  private wsClient: any;
  private cardActionWebhook: FeishuCardActionWebhook | undefined;
  private running = false;
  private botOpenId: string | undefined;
  private readonly chatModeCache = new Map<string, "p2p" | "group" | "topic">();
  /** 本 bot 发出的消息 id，用于 alsoOnReply 判定 parent/root */
  private readonly botOutboundMessageIds = new Set<string>();
  private readonly botOutboundMessageOrder: string[] = [];
  private readonly markdownCopySources = new Map<string, string>();
  private readonly markdownCopySourceOrder: string[] = [];
  private markdownCopySeq = 0;
  private readonly config: FeishuConfig;
  private readonly onMessage: (msg: FeishuMessage) => Promise<void>;
  private readonly onCardAction: (action: FeishuCardAction) => Promise<object | undefined | void>;

  private sendRetries() {
    return this.config.sendMaxRetries ?? 2;
  }

  private async apiCall<T = any>(label: string, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { maxRetries: this.sendRetries(), label });
  }

  constructor(
    config: FeishuConfig,
    onMessage: (msg: FeishuMessage) => Promise<void>,
    onCardAction: (action: FeishuCardAction) => Promise<object | undefined | void>,
  ) {
    this.config = config;
    this.onMessage = onMessage;
    this.onCardAction = onCardAction;
  }

  /** 热读有效配置（含 runtime-overrides）；失败回退 constructor 快照 */
  private effectiveConfig(): FeishuConfig {
    return loadConfig() || this.config;
  }

  async start() {
    if (this.running) return;
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = this.config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

    this.sdkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });

    await this.probeBotOpenId();

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
      "im.message.receive_v1": async (data: unknown) => this.handleRawMessage(data),
      "im.message.reaction.created_v1": async () => undefined,
      "im.chat.member.bot.added_v1": async () => undefined,
    });

    // Always register the WS card action handler. When the app is connected
    // via WebSocket (which is always the case with WSClient), the Feishu
    // platform delivers card action callbacks through the WS channel.
    // Without this handler the EventDispatcher returns an invalid response
    // to the platform, causing error 200672 on the client.
    dispatcher.register({
      "card.action.trigger": async (data: unknown) => this.handleCardAction(data),
    });

    // Optional webhook server as a backup delivery channel (only used when
    // the developer console is explicitly configured for webhook delivery).
    if (this.cardActionMode() === "webhook") {
      this.cardActionWebhook = new FeishuCardActionWebhook(this.config, async (action) => this.handleCardActionAction(action, "webhook"));
      await this.cardActionWebhook.start();
      debugLog("feishu.card.webhook.endpoint", {
        endpoint: this.cardActionWebhook.getEndpointLabel(),
      });
    }

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });

    this.running = true;
    try {
      this.wsClient.start({ eventDispatcher: dispatcher });
    } catch (error) {
      this.running = false;
      try { await this.cardActionWebhook?.stop(); } catch {}
      this.cardActionWebhook = undefined;
      throw error;
    }
  }

  async stop() {
    this.running = false;
    try { await this.wsClient?.stop?.(); } catch {}
    try { await this.cardActionWebhook?.stop(); } catch {}
    this.cardActionWebhook = undefined;
  }

  isRunning() {
    return this.running;
  }

  getBotOpenId() {
    return this.botOpenId;
  }

  private async probeBotOpenId() {
    try {
      const res = await this.sdkClient.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      });
      this.botOpenId = res?.bot?.open_id || res?.data?.bot?.open_id || res?.data?.open_id;
      if (!this.botOpenId) {
        throw new Error(`bot/v3/info response missing open_id: ${JSON.stringify(res).slice(0, 200)}`);
      }
    } catch (error) {
      throw new BotUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRawMessage(data: any) {
    const event = data?.event || data;
    const message = event?.message;
    const sender = event?.sender;
    if (!message) return;

    const cfg = this.effectiveConfig();
    if (sender?.sender_type === "bot" && cfg.ignoreBotMessages !== false) {
      debugLog("feishu.message.ignored_bot", {
        messageId: message.message_id,
        messageType: message.message_type,
      });
      return;
    }

    debugLog("feishu.message.received", {
      messageId: message.message_id,
      chatType: message.chat_type,
      messageType: message.message_type,
      senderType: sender?.sender_type || "unknown",
      hasRootId: Boolean(message.root_id),
      hasParentId: Boolean(message.parent_id),
      hasThreadId: Boolean(message.thread_id),
      content: message.content || "",
    });

    if (message.chat_type === "group") {
      const text = extractPlainTextForTrigger(message.message_type || "text", message.content || "");
      const mentioned = this.isMentioned(message);
      const replyToBot = this.isReplyToBot(message);
      const decision = shouldAcceptGroupMessage({
        chatType: "group",
        groupPolicy: cfg.groupPolicy,
        mentioned,
        text,
        keywords: cfg.groupKeywords || [],
        alsoOnReply: Boolean(cfg.groupAlsoOnReply),
        replyToBot,
      });
      if (!decision.accept) {
        debugLog(`feishu.message.ignored_${decision.reason}`, {
          messageId: message.message_id,
          reason: decision.reason,
          mentioned,
          replyToBot,
          keywords: cfg.groupKeywords || [],
        });
        return;
      }
      if (decision.reason !== "open") {
        debugLog("feishu.message.trigger", {
          messageId: message.message_id,
          reason: decision.reason,
        });
      }
    }

    const chatMode = await this.getChatMode(message.chat_id, message.chat_type);
    const msg: FeishuMessage = {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      chatMode,
      senderOpenId: sender?.sender_id?.open_id || "unknown",
      msgType: message.message_type,
      content: message.content || "",
      rootId: message.root_id,
      parentId: message.parent_id,
      threadId: message.thread_id,
      mentions: message.mentions,
    };

    if (cfg.reactEmoji) {
      void this.addReaction(msg.messageId, cfg.reactEmoji);
    }
    debugLog("feishu.message.dispatch", { messageId: msg.messageId });
    void this.onMessage(msg).catch((error) => {
      debugLog("feishu.message.dispatch_error", {
        messageId: msg.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleCardAction(data: any) {
    // After EventDispatcher/RequestHandle.parse() the event fields are
    // flattened to the top level. data.event is gone; use data directly.
    const messageId = data?.context?.open_message_id || data?.open_message_id;
    const chatId = data?.context?.open_chat_id || data?.open_chat_id;
    const operatorOpenId = data?.operator?.open_id;
    if (!messageId || !operatorOpenId) return;
    debugLog("feishu.card.action", {
      messageId,
      chatId,
      hasToken: Boolean(data?.token),
      value: data?.action?.value,
    });
    const result = await this.handleCardActionAction({
      messageId,
      chatId,
      operatorOpenId,
      token: typeof data?.token === "string" ? data.token : undefined,
      value: data?.action?.value,
    }, "ws");
    // The WSClient sends the return value back to the Feishu platform as
    // the card callback response. It must use the wrapped format:
    //   { "card": { "type": "raw", "data": { ... card JSON ... } } }
    if (result) {
      return { card: { type: "raw", data: result } };
    }
    return result;
  }

  private async handleCardActionAction(action: FeishuCardAction, mode: "ws" | "webhook") {
    // 仅返回回调响应即可；不要再 im.message.patch 一份 schema 1.0，
    // 否则会把 CardKit schema 2.0 卡改坏（200830 / 前端 200671）。
    return this.onCardAction(action);
  }

  private cardActionMode() {
    return this.config.cardActionMode || "webhook";
  }

  private isMentioned(message: any): boolean {
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (!mentions.length) return false;
    const botOpenId = this.botOpenId;
    if (!botOpenId) return true;
    return mentions.some((m: any) => m?.id?.open_id === botOpenId || m?.id?.union_id === botOpenId);
  }

  /** 是否回复/跟帖到本 bot 发出的消息 */
  private isReplyToBot(message: any): boolean {
    const parentId = typeof message.parent_id === "string" ? message.parent_id : "";
    const rootId = typeof message.root_id === "string" ? message.root_id : "";
    if (parentId && this.botOutboundMessageIds.has(parentId)) return true;
    if (rootId && this.botOutboundMessageIds.has(rootId)) return true;
    return false;
  }

  /** 供 ReplyCard / CardKit 登记出站消息 id */
  rememberOutboundMessageId(messageId: string) {
    this.rememberBotOutboundMessageId(messageId);
  }

  private rememberBotOutboundMessageId(messageId: string | undefined) {
    if (!messageId) return;
    if (this.botOutboundMessageIds.has(messageId)) return;
    this.botOutboundMessageIds.add(messageId);
    this.botOutboundMessageOrder.push(messageId);
    while (this.botOutboundMessageOrder.length > 500) {
      const oldest = this.botOutboundMessageOrder.shift();
      if (oldest) this.botOutboundMessageIds.delete(oldest);
    }
  }

  private async getChatMode(chatId: string, chatType: "p2p" | "group"): Promise<"p2p" | "group" | "topic"> {
    if (chatType === "p2p") return "p2p";
    const cached = this.chatModeCache.get(chatId);
    if (cached) return cached;
    try {
      const res = await this.sdkClient.im.v1.chat.get({ path: { chat_id: chatId } });
      const mode = res?.data?.chat_mode === "topic" ? "topic" : "group";
      this.chatModeCache.set(chatId, mode);
      debugLog("feishu.chat.mode", { chatId, mode });
      return mode;
    } catch (error) {
      debugLog("feishu.chat.mode_error", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "group";
    }
  }

  private async addReaction(messageId: string, emojiType: string) {
    try {
      await this.sdkClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch {}
  }

  async replyText(messageId: string, text: string) {
    const mode = chooseMessageMode(text);
    if (mode === "interactive") {
      await this.replyMarkdownCard(messageId, text);
      return;
    }
    if (mode === "post") {
      await this.replyPost(messageId, text);
      return;
    }
    debugLog("feishu.reply.text", { messageId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    for (const chunk of chunks) {
      const res = await this.apiCall("feishu.reply.text", () => this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
      }));
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async replyPlainText(messageId: string, text: string): Promise<string | undefined> {
    debugLog("feishu.reply.plain_text", { messageId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    let lastId: string | undefined;
    for (const chunk of chunks) {
      const res = await this.apiCall("feishu.reply.plain_text", () => this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
      }));
      lastId = (res as any)?.data?.message_id as string | undefined;
      this.rememberBotOutboundMessageId(lastId);
    }
    return lastId;
  }

  /** 更新已发出的 text 消息正文 */
  async updateText(messageId: string, text: string) {
    debugLog("feishu.update.text", { messageId, length: text.length });
    const chunk = splitText(text || "…", TEXT_CHUNK_MAX_BYTES)[0] || "…";
    await this.apiCall("feishu.update.text", () => this.sdkClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text: chunk }) },
    }));
  }

  async sendText(chatId: string, text: string) {
    const mode = chooseMessageMode(text);
    if (mode === "interactive") {
      await this.sendMarkdownCard(chatId, text);
      return;
    }
    if (mode === "post") {
      await this.sendPost(chatId, text);
      return;
    }
    debugLog("feishu.send.text", { chatId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    for (const chunk of chunks) {
      const res = await this.apiCall("feishu.send.text", () => this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      }));
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async replyMarkdownCard(messageId: string, text: string) {
    debugLog("feishu.reply.markdown_card", { messageId, length: text.length });
    for (const { card } of this.buildMarkdownCardPartsWithCopySources(text)) {
      const res = await this.apiCall("feishu.reply.markdown_card", () => this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "interactive", content: JSON.stringify(card) },
      }));
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async sendMarkdownCard(chatId: string, text: string) {
    debugLog("feishu.send.markdown_card", { chatId, length: text.length });
    for (const { card } of this.buildMarkdownCardPartsWithCopySources(text)) {
      const res = await this.apiCall("feishu.send.markdown_card", () => this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      }));
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  getMarkdownCopySource(copySourceId: string) {
    return this.markdownCopySources.get(copySourceId);
  }

  private buildMarkdownCardPartsWithCopySources(text: string) {
    return buildMarkdownCardParts(text, this.config.language, () => this.createMarkdownCopySourceId())
      .map((part) => {
        const copySourceId = extractCopySourceId(part.card);
        if (copySourceId) this.rememberMarkdownCopySource(copySourceId, part.markdown);
        return part;
      });
  }

  private rememberMarkdownCopySource(copySourceId: string, markdown: string) {
    this.markdownCopySources.set(copySourceId, markdown);
    this.markdownCopySourceOrder.push(copySourceId);
    while (this.markdownCopySourceOrder.length > 200) {
      const oldest = this.markdownCopySourceOrder.shift();
      if (oldest) this.markdownCopySources.delete(oldest);
    }
  }

  private createMarkdownCopySourceId() {
    this.markdownCopySeq += 1;
    return `${Date.now().toString(36)}-${this.markdownCopySeq.toString(36)}`;
  }

  async replyPost(messageId: string, text: string) {
    debugLog("feishu.reply.post", { messageId, length: text.length });
    for (const post of buildPostMessages(text, this.config.language)) {
      const res = await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "post", content: JSON.stringify(post) },
      });
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async sendPost(chatId: string, text: string) {
    debugLog("feishu.send.post", { chatId, length: text.length });
    for (const post of buildPostMessages(text, this.config.language)) {
      const res = await this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: JSON.stringify(post),
        },
      });
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async replyCard(messageId: string, card: object) {
    debugLog("feishu.reply.card", { messageId });
    const res = await this.sdkClient.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify(card) },
    });
    const id = res?.data?.message_id as string | undefined;
    this.rememberBotOutboundMessageId(id);
    return id;
  }

  async updateCard(messageId: string, card: object) {
    debugLog("feishu.update.card", { messageId });
    await this.sdkClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  /** 拉取单条消息（用于展开 parent/root 引用卡片） */
  async getMessage(messageId: string): Promise<{ messageId: string; msgType: string; content: string; chatId?: string } | undefined> {
    if (!messageId) return undefined;
    try {
      const res = await this.apiCall<any>("feishu.get_message", () =>
        this.sdkClient.im.message.get({ path: { message_id: messageId } }),
      );
      const item = res?.data?.items?.[0] || res?.data?.message || res?.data;
      if (!item) return undefined;
      const body = item.body || item;
      const msgType = body.message_type || body.msg_type || item.message_type || item.msg_type || "unknown";
      const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content || {});
      return {
        messageId: body.message_id || item.message_id || messageId,
        msgType,
        content,
        chatId: body.chat_id || item.chat_id,
      };
    } catch (error) {
      debugLog("feishu.get_message.error", {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async getQuotedContext(msg: { parentId?: string; rootId?: string }, botOpenId?: string, maxChars = 8000) {
    const targetId = msg.parentId || msg.rootId;
    if (!targetId) return null;
    const parent = await this.getMessage(targetId);
    if (!parent) return null;
    const extracted = extractTextFromMsgType(parent.msgType, parent.content, botOpenId);
    let text = extracted.text.trim();
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(truncated)`;
    return { msgType: parent.msgType, text, attachments: extracted.attachments };
  }

  async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<{ bytes: Buffer; mimeType?: string }> {
    debugLog("feishu.download.resource.start", { messageId, fileKey, type });
    const result = await this.sdkClient.im.v1.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    });
    const bytes = await streamToBuffer(readableFromDownload(result));
    const rawContentType = result.headers?.["content-type"] || result.headers?.["Content-Type"];
    const mimeType = typeof rawContentType === "string" ? rawContentType.split(";")[0]?.trim() : undefined;
    debugLog("feishu.download.resource.done", { messageId, fileKey, type, bytes: bytes.length, mimeType });
    return { bytes, mimeType: mimeType || undefined };
  }

  async downloadImage(messageId: string, imageKey: string): Promise<{ bytes: Buffer; mimeType?: string }> {
    try {
      return await this.downloadMessageResource(messageId, imageKey, "image");
    } catch (resourceError) {
      debugLog("feishu.download.image.resource_failed", {
        messageId,
        imageKey,
        error: resourceError instanceof Error ? resourceError.message : String(resourceError),
      });
    }

    debugLog("feishu.download.image.fallback_start", { messageId, imageKey });
    const result = await this.sdkClient.im.v1.image.get({
      path: { image_key: imageKey },
    });
    const bytes = await streamToBuffer(readableFromDownload(result));
    debugLog("feishu.download.image.fallback_done", { messageId, imageKey, bytes: bytes.length });
    return { bytes, mimeType: "image/jpeg" };
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

function extractCopySourceId(card: object) {
  const elements = (card as any)?.body?.elements;
  if (!Array.isArray(elements)) return undefined;
  for (const element of elements) {
    const behaviors = element?.behaviors;
    if (!Array.isArray(behaviors)) continue;
    for (const behavior of behaviors) {
      const value = behavior?.value;
      if (value?.action === "pi_feishu_copy_markdown" && typeof value.copySourceId === "string") {
        return value.copySourceId;
      }
    }
  }
  return undefined;
}

async function streamToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function readableFromDownload(result: any): NodeJS.ReadableStream {
  return typeof result?.getReadableStream === "function" ? result.getReadableStream() : result;
}
