import http from "node:http";
import { debugLog } from "./debug.js";
import type { FeishuCardAction, FeishuConfig } from "./types.js";

export class FeishuCardActionWebhook {
  private server: http.Server | undefined;
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;

  constructor(
    private readonly config: FeishuConfig,
    private readonly onCardAction: (action: FeishuCardAction) => Promise<object | undefined | void>,
  ) {
    this.host = config.cardActionWebhookHost || "0.0.0.0";
    this.port = config.cardActionWebhookPort || 3001;
    this.path = config.cardActionWebhookPath || "/webhook/card";
  }

  isRunning() {
    return Boolean(this.server);
  }

  getEndpointLabel() {
    return `${this.host}:${this.port}${this.path}`;
  }

  async start() {
    if (this.server) return;
    const lark = await import("@larksuiteoapi/node-sdk");
    const dispatcher = new lark.CardActionHandler({}, async (data: any) => {
      let action;
      try {
        action = normalizeCardAction(data);
      } catch (normalizeError) {
        debugLog("feishu.card.webhook.normalize_failed", {
          error: normalizeError instanceof Error ? normalizeError.message : String(normalizeError),
          keys: Object.keys(data || {}),
        });
        return undefined;
      }
      debugLog("feishu.card.webhook.action", {
        messageId: action.messageId,
        hasValue: Boolean(action.value),
        value: action.value,
      });
      try {
        const result = await this.onCardAction(action);
        // Feishu/Lark requires the webhook response body to use the wrapped format:
        //   { "card": { "type": "raw", "data": { ... card JSON ... } } }
        // The Lark SDK's adaptDefault sends the return value as-is, so we wrap here.
        if (result) {
          return { card: { type: "raw", data: result } };
        }
        return result;
      } catch (handlerError) {
        debugLog("feishu.card.webhook.handler_failed", {
          messageId: action.messageId,
          error: handlerError instanceof Error ? handlerError.message : String(handlerError),
        });
        return undefined;
      }
    });

    this.server = http.createServer();
    const rawHandler = lark.adaptDefault(this.path, dispatcher);
    this.server.on("request", (req, res) => {
      res.setHeader("Content-Type", "application/json");
      rawHandler(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    });

    debugLog("feishu.card.webhook.started", {
      host: this.host,
      port: this.port,
      path: this.path,
    });
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

function normalizeCardAction(data: any): FeishuCardAction {
  // After Lark SDK's RequestHandle.parse() for v2 schema events,
  // the data is flattened and open_message_id lives under data.context.
  // Check both nested and flat locations to stay compatible with both
  // raw webhook payloads and SDK-parsed structures.
  const messageId = data?.context?.open_message_id || data?.open_message_id;
  const operatorOpenId = data?.operator?.open_id || data?.open_id;
  if (typeof messageId !== "string" || !messageId || typeof operatorOpenId !== "string" || !operatorOpenId) {
    throw new Error("invalid card action payload");
  }
  const chatId =
    typeof data?.context?.open_chat_id === "string"
      ? data.context.open_chat_id
      : typeof data?.open_chat_id === "string"
        ? data.open_chat_id
        : undefined;
  return {
    messageId,
    chatId,
    operatorOpenId,
    token: typeof data?.token === "string" ? data.token : undefined,
    value: data?.action?.value,
  };
}
