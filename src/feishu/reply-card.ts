/**
 * 回复呈现：
 * - 默认 CardKit streaming_mode：客户端逐字打印（print_step=1）
 * - 关闭流式时：先「回复中」卡，结束一次写入全文
 * - 不展示工具/阶段过程
 */
import { randomUUID } from "node:crypto";
import {
  buildReplyCard,
  defaultFinalNote,
  type ReplyCardStatus,
} from "./card-builder.js";
import { CardKitStream } from "./cardkit-stream.js";
import { loadConfig } from "./config.js";
import { debugLog } from "./debug.js";

export type { ReplyCardStatus } from "./card-builder.js";
export {
  buildReplyCard,
  parseStopTaskActionValue,
  STOP_ACTION,
} from "./card-builder.js";

export type ReplyCardSink = {
  readonly runId: string;
  readonly bodyText: string;
  updateFromEvent(event: unknown): void;
  stopImmediately(note?: string): Promise<void>;
  finish(status: Exclude<ReplyCardStatus, "running" | "inactive">, note?: string): Promise<void>;
  append(delta: string): void;
  ensureFinal(text: string): void;
};

export type ReplyCardStreamOptions = {
  enabled?: boolean;
  /** CardKit 客户端打印间隔 ms（默认 50） */
  printFrequencyMs?: number;
  /** CardKit 每次打印字符数（默认 1） */
  printStep?: number;
  /** 服务端推送 fullText 到 CardKit 的间隔 ms（默认 120） */
  pushIntervalMs?: number;
};

type ReplyCardTransport = {
  replyCard(messageId: string, card: object): Promise<string | undefined>;
  updateCard(messageId: string, card: object): Promise<void>;
  replyPlainText?(messageId: string, text: string): Promise<string | undefined>;
  updateText?(messageId: string, text: string): Promise<void>;
  /** 记录本 bot 出站消息，供 groupAlsoOnReply */
  rememberOutboundMessageId?(messageId: string): void;
};

function resolveStreamOptions(override?: ReplyCardStreamOptions) {
  const cfg = loadConfig();
  return {
    enabled: override?.enabled ?? cfg?.streamingReply !== false,
    printFrequencyMs: Math.max(
      20,
      override?.printFrequencyMs
        ?? parseEnvInt("FEISHU_STREAM_PRINT_FREQUENCY_MS")
        ?? cfg?.streamPrintFrequencyMs
        ?? 50,
    ),
    printStep: Math.max(
      1,
      override?.printStep
        ?? parseEnvInt("FEISHU_STREAM_PRINT_STEP")
        ?? cfg?.streamPrintStep
        ?? 1,
    ),
    pushIntervalMs: Math.max(
      50,
      override?.pushIntervalMs
        ?? parseEnvInt("FEISHU_STREAM_PUSH_INTERVAL_MS")
        ?? cfg?.streamPushIntervalMs
        ?? 120,
    ),
  };
}

function parseEnvInt(name: string): number | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export class ReplyCard implements ReplyCardSink {
  readonly runId = randomUUID();
  private status: ReplyCardStatus = "running";
  private body = "";
  private note: string | undefined;
  get bodyText() { return this.body; }
  private cardkit: CardKitStream | undefined;
  private fallbackCardId: string | undefined;
  private readonly streamOpts: ReturnType<typeof resolveStreamOptions>;
  private readonly key: string;
  private readonly replyToMessageId: string;
  private readonly transport: ReplyCardTransport;

  constructor(
    key: string,
    replyToMessageId: string,
    transport: ReplyCardTransport,
    streamOptions?: ReplyCardStreamOptions,
  ) {
    this.key = key;
    this.replyToMessageId = replyToMessageId;
    this.transport = transport;
    this.streamOpts = resolveStreamOptions(streamOptions);
  }

  get messageId() {
    return this.fallbackCardId;
  }

  async start() {
    const cfg = loadConfig();
    if (this.streamOpts.enabled && cfg?.appId && cfg?.appSecret) {
      this.cardkit = new CardKitStream(
        cfg.appId,
        cfg.appSecret,
        cfg.domain === "lark" ? "lark" : "feishu",
        this.replyToMessageId,
        async (text) => {
          // CardKit 失败：回落为普通最终卡片
          const id = await this.transport.replyCard(
            this.replyToMessageId,
            buildReplyCard({
              key: this.key,
              runId: this.runId,
              status: "done",
              body: text,
            }),
          );
          this.fallbackCardId = id;
        },
        {
          printFrequencyMs: this.streamOpts.printFrequencyMs,
          printStep: this.streamOpts.printStep,
          pushIntervalMs: this.streamOpts.pushIntervalMs,
          conversationKey: this.key,
          runId: this.runId,
          onOutboundMessageId: (id) => this.transport.rememberOutboundMessageId?.(id),
        },
      );
      debugLog("feishu.reply_card.cardkit_ready", {
        key: this.key,
        runId: this.runId,
        ...this.streamOpts,
      });
      // 先让飞书看到「回复中」，不等待 Pi 产出第一段正文；失败仍会在结束时回落为普通回复卡。
      void this.cardkit.startImmediately();
      return;
    }

    // 非流式：先出「回复中」占位卡
    this.fallbackCardId = await this.transport.replyCard(
      this.replyToMessageId,
      buildReplyCard({
        key: this.key,
        runId: this.runId,
        status: "running",
        body: "",
      }),
    );
    debugLog("feishu.reply_card.started_static", {
      key: this.key,
      runId: this.runId,
      cardMessageId: this.fallbackCardId,
    });
  }

  updateFromEvent(_event: unknown) {
    // 不展示过程
  }

  append(delta: string) {
    if (this.status !== "running" || !delta) return;
    this.body += delta;
    this.cardkit?.append(delta);
  }

  ensureFinal(text: string) {
    if (!text) return;
    if (!this.body.trim() || text.length >= this.body.length) this.body = text;
    this.cardkit?.ensureFinal(text);
  }

  async stopImmediately(note = "已停止") {
    await this.finishFinal("stopped", note);
  }

  async finish(status: Exclude<ReplyCardStatus, "running" | "inactive">, note?: string) {
    await this.finishFinal(status, note);
  }

  async completeWithAnswer(answer: string) {
    this.ensureFinal(answer || "（无内容）");
    await this.finishFinal("done", undefined);
  }

  private async finishFinal(
    status: Exclude<ReplyCardStatus, "running" | "inactive">,
    note: string | undefined,
  ) {
    if (this.status !== "running") return;
    this.status = status;
    this.note = note ?? defaultFinalNote(status);

    if (this.cardkit) {
      // 同一张 CardKit 卡上关闭流式并更新 header（回复/已停止/出错了）
      await this.cardkit.close(this.body, status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done");
      return;
    }

    // 静态卡路径
    if (this.fallbackCardId) {
      try {
        await this.transport.updateCard(
          this.fallbackCardId,
          buildReplyCard({
            key: this.key,
            runId: this.runId,
            status,
            note: status === "done" ? undefined : this.note,
            body: this.body,
          }),
        );
      } catch (error) {
        debugLog("feishu.reply_card.static_final_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
