import { extractTextFromInteractiveCard } from "./interactive-card.js";
import type { FeishuAttachment, FeishuMessage, ParsedMessageInput } from "./types.js";

export type BotCommand =
  | { name: "new" }
  | { name: "resume" }
  | { name: "model" }
  | { name: "thinking" }
  | { name: "stop" }
  | { name: "workspace"; path?: string }
  | { name: "status" }
  | { name: "commands" }
  | { name: "config"; key?: string; value?: string; clearTarget?: string };

type PostBody = {
  title?: string;
  content?: unknown[];
};

export function normalizeForDedupe(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function pruneRecentMap(map: Map<string, number>, now: number, ttlMs: number) {
  for (const [key, timestamp] of map) {
    if (now - timestamp > ttlMs) map.delete(key);
  }
}

export function conversationKey(msg: FeishuMessage) {
  if (msg.chatType === "p2p") return `p2p:${msg.senderOpenId}`;
  const threadId = msg.threadId || msg.rootId || msg.parentId;
  if (threadId) return `group:${msg.chatId}:thread:${threadId}`;
  if (msg.chatMode === "topic") return `group:${msg.chatId}:thread:${msg.messageId}`;
  return `group:${msg.chatId}`;
}

export function conversationLabel(msg: FeishuMessage) {
  if (msg.chatType === "p2p") return "[飞书私聊]";
  if (msg.rootId || msg.parentId || msg.threadId || msg.chatMode === "topic") return "[飞书话题]";
  return "[飞书群聊]";
}

export function parseMessageInput(
  msg: FeishuMessage,
  botOpenId?: string,
  options?: { parseInteractiveCards?: boolean },
): ParsedMessageInput {
  const attachments: FeishuAttachment[] = [];
  const parseInteractive = options?.parseInteractiveCards !== false;
  try {
    const json = JSON.parse(msg.content || "{}");
    if (msg.msgType === "text") {
      let text = String(json.text || "");
      if (botOpenId) text = text.replace(new RegExp(`@?${botOpenId}`, "g"), "");
      return { text: text.trim(), attachments, source: "text" };
    }
    if (msg.msgType === "post") {
      const post = json.post || json;
      const locale = resolvePostBody(post);
      const parts: string[] = [];
      if (typeof locale?.title === "string" && locale.title.trim()) {
        parts.push(locale.title.trim());
      }
      for (const para of locale?.content || []) {
        const paragraphText = extractPostText(para, attachments).trim();
        if (paragraphText) parts.push(paragraphText);
      }
      collectAttachments(json, attachments);
      return { text: parts.join("\n").trim(), attachments, source: "post" };
    }
    if (msg.msgType === "interactive" && parseInteractive) {
      const extracted = extractTextFromInteractiveCard(msg.content || "{}");
      return { text: extracted.text, attachments: extracted.attachments, source: "interactive" };
    }
    if (msg.msgType === "image" && typeof json.image_key === "string" && json.image_key) {
      attachments.push({ kind: "image", fileKey: json.image_key });
      collectAttachments(json, attachments);
      return { text: "", attachments, source: "image" };
    }
    if (msg.msgType === "file" && typeof json.file_key === "string" && json.file_key) {
      attachments.push({
        kind: "file",
        fileKey: json.file_key,
        fileName: typeof json.file_name === "string" ? json.file_name : undefined,
      });
      collectAttachments(json, attachments);
      return { text: "", attachments, source: "file" };
    }
    collectAttachments(json, attachments);
    if (attachments.length) return { text: "", attachments, source: msg.msgType };
  } catch {}
  // 未知类型：不要静默丢弃，至少给 agent 一个占位
  if (msg.msgType === "text") return { text: msg.content, attachments, source: "text-raw" };
  if (msg.msgType === "interactive") {
    return {
      text: `[interactive]\n${(msg.content || "").slice(0, 1500)}`,
      attachments,
      source: "interactive-fallback",
    };
  }
  return { text: `[${msg.msgType}]`, attachments, source: "unknown" };
}

export function parseBotCommand(text: string): BotCommand | undefined {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/\s+/g, " ");
  if (normalized === "/new") return { name: "new" };
  if (normalized === "/resume") return { name: "resume" };
  if (normalized === "/model") return { name: "model" };
  if (normalized === "/thinking") return { name: "thinking" };
  if (normalized === "/stop") return { name: "stop" };
  if (normalized === "/status") return { name: "status" };
  if (normalized === "/commands") return { name: "commands" };
  const workspaceMatch = trimmed.match(/^\/workspace(?:\s+(.+))?$/s);
  if (workspaceMatch) {
    return { name: "workspace", path: workspaceMatch[1]?.trim() };
  }
  const configMatch = trimmed.match(/^\/config(?:\s+(.+))?$/s);
  if (configMatch) {
    const rest = (configMatch[1] || "").trim();
    if (!rest) return { name: "config" };
    const parts = rest.split(/\s+/);
    if (parts[0] === "clear") {
      return { name: "config", clearTarget: parts[1] || "all" };
    }
    const key = parts[0];
    const value = rest.slice(key.length).trim();
    return { name: "config", key, value: value || undefined };
  }
  return undefined;
}

export function getCommandList(): string {
  return [
    "/new — 新建会话",
    "/resume — 恢复历史会话（卡片选择）",
    "/model — 切换模型",
    "/thinking — 调整当前会话的思考强度",
    "/workspace [path] — 切换工作区",
    "/status — 查看当前模型、思考强度、目录和状态",
    "/stop — 停止当前生成",
    "/config — 查看/修改运行时配置（群触发、流式等）",
    "/config <key> <value> — 设置白名单配置并立即生效",
    "/config clear [key|all] — 清除 runtime overrides",
    "/commands — 显示命令列表",
  ].join("\n");
}

/** 合并用户文本与引用父消息，供 agent 调查告警卡片等场景 */
export function buildPromptWithQuote(userText: string, quoted?: { msgType: string; text: string } | null): string {
  if (!quoted?.text?.trim()) return userText;
  const blocks = [
    "[Quoted message]",
    `type: ${quoted.msgType}`,
    "---",
    quoted.text.trim(),
    "---",
    "[User]",
    userText || "(no text)",
  ];
  return blocks.join("\n");
}

function resolvePostBody(post: unknown): PostBody | undefined {
  if (isPostBody(post)) return post;
  if (!post || typeof post !== "object" || Array.isArray(post)) return undefined;

  const record = post as Record<string, unknown>;
  const candidates = [record.zh_cn, record.en_us, ...Object.values(record)];
  return candidates.find(isPostBody);
}

function isPostBody(value: unknown): value is PostBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content);
}

function extractPostText(node: unknown, attachments: FeishuAttachment[]): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map((item) => extractPostText(item, attachments)).join("");

  const obj = node as Record<string, unknown>;
  const tag = typeof obj.tag === "string" ? obj.tag : undefined;

  if ((tag === "img" || tag === "image") && typeof obj.image_key === "string" && obj.image_key) {
    attachments.push({ kind: "image", fileKey: obj.image_key });
    return "";
  }

  if (tag === "at") {
    return `@${typeof obj.user_name === "string" && obj.user_name ? obj.user_name : "user"}`;
  }

  // 有序列表 / 无序列表：飞书 post 常见 tag，避免 #4 空解析
  if (tag === "ol" || tag === "ul" || tag === "li") {
    return Object.values(obj)
      .map((item) => extractPostText(item, attachments))
      .join(tag === "li" ? "\n" : "");
  }

  if ((tag === "text" || tag === "a") && typeof obj.text === "string") {
    return obj.text;
  }

  if (typeof obj.text === "string") return obj.text;

  return Object.values(obj)
    .map((item) => extractPostText(item, attachments))
    .join("");
}

function collectAttachments(value: unknown, attachments: FeishuAttachment[]) {
  const seen = new Set(attachments.map((item) => `${item.kind}:${item.fileKey}`));
  walk(value);

  function add(attachment: FeishuAttachment) {
    const key = `${attachment.kind}:${attachment.fileKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push(attachment);
  }

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.image_key === "string" && obj.image_key) {
      add({ kind: "image", fileKey: obj.image_key });
    }
    if (typeof obj.file_key === "string" && obj.file_key) {
      add({
        kind: "file",
        fileKey: obj.file_key,
        fileName: typeof obj.file_name === "string" ? obj.file_name : undefined,
      });
    }

    for (const item of Object.values(obj)) walk(item);
  }
}
