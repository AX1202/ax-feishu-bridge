/**
 * 飞书 CardKit 真正的流式卡片：
 * streaming_mode + print_frequency_ms/print_step 由客户端逐字打印。
 * 我们侧只需定期 PUT 完整 markdown 内容。
 * running 卡必须带「停止」按钮（与 card-builder 契约一致）。
 */
import { buildCardKitCardJson } from "./card-builder.js";
import { debugLog } from "./debug.js";
import { withRetry } from "./retry.js";

type CardKitResponse = { code: number; msg: string; data?: any };

export type CardKitStreamOptions = {
  /** 客户端打印频率 ms（默认 50，越小越跟手） */
  printFrequencyMs?: number;
  /** 客户端每次打印字符数（默认 1 = 逐字） */
  printStep?: number;
  /** 服务端把 fullText 推到 CardKit 的间隔 ms（默认 120） */
  pushIntervalMs?: number;
  /** 会话 key，用于停止按钮回调 */
  conversationKey?: string;
  /** 本轮 runId，用于停止按钮回调 */
  runId?: string;
  /** 记录本 bot 发出的消息 id（供 groupAlsoOnReply） */
  onOutboundMessageId?: (messageId: string) => void;
};

export class CardKitStream {
  private cardId: string | null = null;
  private fullText = "";
  private lastSent = "";
  private token: string | null = null;
  private tokenExpiry = 0;
  private sequence = 1;
  private interval: ReturnType<typeof setInterval> | null = null;
  private startPromise: Promise<void> | null = null;
  private closed = false;
  private failed = false;
  private readonly printFrequencyMs: number;
  private readonly printStep: number;
  private readonly pushIntervalMs: number;
  private readonly conversationKey?: string;
  private readonly runId?: string;
  private readonly onOutboundMessageId?: (messageId: string) => void;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly domain: "feishu" | "lark",
    private readonly replyToMessageId: string,
    private readonly fallbackReply: (text: string) => Promise<void>,
    options?: CardKitStreamOptions,
  ) {
    this.printFrequencyMs = Math.max(20, options?.printFrequencyMs ?? 50);
    this.printStep = Math.max(1, options?.printStep ?? 1);
    this.pushIntervalMs = Math.max(50, options?.pushIntervalMs ?? 120);
    this.conversationKey = options?.conversationKey;
    this.runId = options?.runId;
    this.onOutboundMessageId = options?.onOutboundMessageId;
  }

  private baseUrl() {
    return this.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  }

  private async getToken(): Promise<string> {
    if (this.token && this.tokenExpiry > Date.now() + 60_000) return this.token!;
    const res = await fetch(`${this.baseUrl()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const j = (await res.json()) as CardKitResponse & { tenant_access_token?: string; expire?: number };
    if (j.code !== 0 || !j.tenant_access_token) throw new Error(`token: ${j.msg || res.status}`);
    this.token = j.tenant_access_token;
    this.tokenExpiry = Date.now() + (j.expire ?? 7200) * 1000;
    return this.token!;
  }

  private async start(): Promise<void> {
    if (this.closed || this.cardId || this.failed) return;
    await withRetry(async () => {
      const t = await this.getToken();
      // 必须带停止按钮；禁止只建 markdown 导致无法中止
      const card = buildCardKitCardJson({
        status: "running",
        body: "",
        key: this.conversationKey,
        runId: this.runId,
        streaming: true,
        printFrequencyMs: this.printFrequencyMs,
        printStep: this.printStep,
      });

      const cr = await fetch(`${this.baseUrl()}/open-apis/cardkit/v1/cards`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "card_json", data: JSON.stringify(card) }),
      });
      const c = (await cr.json()) as CardKitResponse;
      if (c.code !== 0 || !c.data?.card_id) {
        throw Object.assign(new Error(`create_card: ${c.msg || c.code}`), { code: c.code });
      }
      this.cardId = c.data.card_id as string;

      const sr = await fetch(`${this.baseUrl()}/open-apis/im/v1/messages/${this.replyToMessageId}/reply`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: this.cardId } }),
        }),
      });
      const s = (await sr.json()) as CardKitResponse & { data?: { message_id?: string } };
      if (s.code !== 0) {
        throw Object.assign(new Error(`reply_card: ${s.msg || s.code}`), { code: s.code });
      }
      const outboundId = s.data?.message_id;
      if (outboundId) this.onOutboundMessageId?.(outboundId);
      debugLog("feishu.cardkit.started", {
        cardId: this.cardId,
        messageId: outboundId,
        printFrequencyMs: this.printFrequencyMs,
        printStep: this.printStep,
      });
    }, { maxRetries: 2, label: "feishu.cardkit.start" });

    // 如果在建卡期间本轮回复已结束，close() 会负责把卡收尾；这里无需再留下定时推送。
    if (!this.closed && !this.interval) {
      this.interval = setInterval(() => {
        void this.tick();
      }, this.pushIntervalMs);
    }
  }

  /**
   * 收到用户消息后立刻创建唯一的一张「回复中」卡。
   * 不等待首段正文，避免用户把较慢的 Pi 回复误认为卡住了。
   */
  startImmediately(): Promise<void> {
    if (this.closed || this.failed || this.cardId) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start()
      .catch((e) => {
        this.failed = true;
        debugLog("feishu.cardkit.start_error", {
          error: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  /** 同步攒字；建卡已在收到消息时提前触发，这里只保证未漏启动。 */
  append(delta: string): void {
    if (this.closed || this.failed || !delta) return;
    this.fullText += delta;
    void this.startImmediately();
  }

  ensureFinal(text: string): void {
    if (!text) return;
    if (!this.fullText.trim() || text.length >= this.fullText.length) {
      this.fullText = text;
    }
  }

  private async tick() {
    if (!this.cardId || this.closed || this.fullText === this.lastSent) return;
    await this.putContent(this.fullText);
  }

  private async putContent(text: string) {
    if (!this.cardId || text === this.lastSent) return;
    try {
      const t = await this.getToken();
      const seq = ++this.sequence;
      const res = await fetch(
        `${this.baseUrl()}/open-apis/cardkit/v1/cards/${this.cardId}/elements/content/content`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            content: text,
            sequence: seq,
            uuid: `${this.cardId}_${seq}`,
          }),
        },
      );
      if (!res.ok) {
        debugLog("feishu.cardkit.update_error", {
          seq,
          status: res.status,
          body: (await res.text()).slice(0, 200),
        });
      } else {
        this.lastSent = text;
      }
    } catch (e) {
      debugLog("feishu.cardkit.update_throw", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 结束流式：
   * 1) 推送最终正文
   * 2) 关闭 streaming_mode
   * 3) 全量更新卡片（header 改为「回复」/绿，避免一直停在「回复中」）
   */
  async close(finalText?: string, finalStatus: "done" | "stopped" | "failed" = "done"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (finalText) this.ensureFinal(finalText);
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.startPromise) await this.startPromise.catch(() => {});

    if (this.failed || !this.cardId) {
      if (this.fullText.trim()) {
        debugLog("feishu.cardkit.fallback_text", { length: this.fullText.length });
        await this.fallbackReply(this.fullText);
      }
      return;
    }

    try {
      if (this.fullText !== this.lastSent) await this.putContent(this.fullText);
      // 给客户端一点时间把剩余字符打完
      await sleep(Math.max(200, this.printFrequencyMs * 4));
      const t = await this.getToken();

      // 先关 streaming_mode
      const settingsRes = await fetch(`${this.baseUrl()}/open-apis/cardkit/v1/cards/${this.cardId}/settings`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: { content: (this.fullText.slice(0, 50) || "Pi").replace(/\s+/g, " ") },
            },
          }),
          sequence: ++this.sequence,
          uuid: `c_${this.cardId}_${this.sequence}`,
        }),
      });
      if (!settingsRes.ok) {
        debugLog("feishu.cardkit.settings_error", {
          status: settingsRes.status,
          body: (await settingsRes.text()).slice(0, 300),
        });
      }

      // 再全量更新卡片：header 改为最终状态，并去掉停止按钮
      const finalCard = buildCardKitCardJson({
        status: finalStatus,
        body: this.fullText,
        key: this.conversationKey,
        runId: this.runId,
        streaming: false,
      });
      const updateRes = await fetch(`${this.baseUrl()}/open-apis/cardkit/v1/cards/${this.cardId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          card: {
            type: "card_json",
            data: JSON.stringify(finalCard),
          },
          sequence: ++this.sequence,
          uuid: `u_${this.cardId}_${this.sequence}`,
        }),
      });
      const updateJson = (await updateRes.json().catch(() => ({}))) as CardKitResponse;
      if (!updateRes.ok || (updateJson.code != null && updateJson.code !== 0)) {
        debugLog("feishu.cardkit.full_update_error", {
          status: updateRes.status,
          code: updateJson.code,
          msg: updateJson.msg,
        });
      }

      debugLog("feishu.cardkit.closed", {
        cardId: this.cardId,
        length: this.fullText.length,
        finalStatus,
        headerTitle: (finalCard as any).header?.title?.content,
        hasStopButton: JSON.stringify(finalCard).includes("停止"),
      });
    } catch (e) {
      debugLog("feishu.cardkit.close_error", {
        error: e instanceof Error ? e.message : String(e),
      });
      if (this.fullText.trim()) await this.fallbackReply(this.fullText);
    }
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
