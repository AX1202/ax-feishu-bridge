import { extractTextFromInteractiveCard } from "./interactive-card.js";

export type GroupTriggerDecision = {
  accept: boolean;
  reason:
    | "p2p"
    | "open"
    | "mentioned"
    | "keyword"
    | "reply_to_bot"
    | "not_mentioned"
    | "no_keyword";
};

export type GroupTriggerInput = {
  chatType: "p2p" | "group" | string;
  groupPolicy: "open" | "mention";
  mentioned: boolean;
  text: string;
  keywords: string[];
  alsoOnReply: boolean;
  replyToBot: boolean;
};

/** 解析关键词：逗号/分号分隔字符串，或字符串数组 */
export function parseGroupKeywords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 大小写不敏感子串匹配；先把空白压成单空格 */
export function textMatchesKeywords(text: string, keywords: string[]): boolean {
  if (!keywords.length) return false;
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  return keywords.some((k) => {
    const key = k.replace(/\s+/g, " ").trim().toLowerCase();
    return key.length > 0 && normalized.includes(key);
  });
}

/** 从飞书原始 content JSON 抽触发用纯文本（轻量，不依赖完整 parseMessageInput） */
export function extractPlainTextForTrigger(msgType: string, content: string): string {
  // interactive 卡片：复用完整抽取，供 groupKeywords 子串匹配
  if (msgType === "interactive") {
    try {
      return extractTextFromInteractiveCard(content, { maxChars: 4000 }).text.trim();
    } catch {
      return "";
    }
  }
  try {
    const json = JSON.parse(content || "{}");
    if (msgType === "text") {
      return String(json.text || "").trim();
    }
    if (msgType === "post") {
      const parts: string[] = [];
      for (const locale of Object.values(json) as Array<{ title?: string; content?: unknown[] }>) {
        if (!locale || typeof locale !== "object") continue;
        if (typeof locale.title === "string" && locale.title.trim()) parts.push(locale.title.trim());
        for (const para of locale.content || []) {
          if (!Array.isArray(para)) continue;
          const line = para
            .map((el: any) => {
              if (el?.tag === "text" && typeof el.text === "string") return el.text;
              if (el?.tag === "a" && typeof el.text === "string") return el.text;
              return "";
            })
            .join("");
          if (line.trim()) parts.push(line.trim());
        }
      }
      return parts.join("\n").trim();
    }
  } catch {
    // fall through
  }
  if (msgType === "text") return content || "";
  return "";
}

/**
 * 群聊触发决策（私聊始终 accept）。
 * mention 基线 + 可选 keyword / alsoOnReply 叠加。
 */
export function shouldAcceptGroupMessage(input: GroupTriggerInput): GroupTriggerDecision {
  if (input.chatType === "p2p") {
    return { accept: true, reason: "p2p" };
  }

  if (input.groupPolicy === "open") {
    return { accept: true, reason: "open" };
  }

  // mention 基线（及未来 keyword-only 仍走叠加语义）
  if (input.mentioned) {
    return { accept: true, reason: "mentioned" };
  }
  if (textMatchesKeywords(input.text, input.keywords)) {
    return { accept: true, reason: "keyword" };
  }
  if (input.alsoOnReply && input.replyToBot) {
    return { accept: true, reason: "reply_to_bot" };
  }

  // 有关键词配置但未命中时，日志可区分；最终统一为 not_mentioned 语义也可
  if (input.keywords.length > 0 && !input.mentioned) {
    return { accept: false, reason: "not_mentioned" };
  }
  return { accept: false, reason: "not_mentioned" };
}

