import type { FeishuAttachment } from "./types.js";

const INTERACTIVE_CARD_FALLBACK = "[Interactive Card]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readCardTemplateVariables(parsed: Record<string, unknown>): Map<string, string> {
  const variables = new Map<string, string>();
  const candidates = [parsed.variables, parsed.template_variable, parsed.template_variables];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    for (const [key, value] of Object.entries(candidate)) {
      if (typeof value === "string") variables.set(key, value);
      else if (value != null && typeof value !== "object") variables.set(key, String(value));
    }
  }
  return variables;
}

function applyCardTemplateVariables(text: string, variables: Map<string, string>): string {
  if (variables.size === 0) return text;
  return text.replace(/\$\{([A-Za-z0-9_.-]+)\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, a, b) => {
    const variableName = typeof a === "string" ? a : b;
    return variables.get(variableName) ?? match;
  });
}

function pushText(parts: string[], value: unknown, variables: Map<string, string>) {
  if (typeof value !== "string") return;
  const text = applyCardTemplateVariables(value, variables).trim();
  if (text) parts.push(text);
}

function extractFromTextObject(textObj: unknown, variables: Map<string, string>): string | undefined {
  if (!isRecord(textObj)) return undefined;
  if (typeof textObj.content === "string") return applyCardTemplateVariables(textObj.content, variables);
  if (typeof textObj.text === "string") return applyCardTemplateVariables(textObj.text, variables);
  return undefined;
}

/** 递归抽取卡片元素中的可读文本，并收集图片附件 */
export function extractInteractiveElementText(
  element: unknown,
  variables: Map<string, string>,
  attachments: FeishuAttachment[],
  depth = 0,
): string[] {
  if (depth > 12 || !isRecord(element)) return [];
  const parts: string[] = [];
  const tag = typeof element.tag === "string" ? element.tag : "";

  if (tag === "img" || tag === "image") {
    const key = typeof element.img_key === "string" ? element.img_key : typeof element.image_key === "string" ? element.image_key : undefined;
    if (key) attachments.push({ kind: "image", fileKey: key });
  }

  if (tag === "div" || tag === "markdown" || tag === "lark_md" || tag === "plain_text" || tag === "note") {
    const direct = extractFromTextObject(element.text, variables);
    if (direct) parts.push(direct);
    if (typeof element.content === "string") pushText(parts, element.content, variables);
  }

  if (tag === "button") {
    const label = extractFromTextObject(element.text, variables);
    if (label) parts.push(`[按钮] ${label}`);
  }

  if (tag === "column_set" && Array.isArray(element.columns)) {
    for (const column of element.columns) {
      parts.push(...extractInteractiveElementText(column, variables, attachments, depth + 1));
    }
  }

  if (Array.isArray(element.elements)) {
    for (const child of element.elements) {
      parts.push(...extractInteractiveElementText(child, variables, attachments, depth + 1));
    }
  }
  if (Array.isArray(element.fields)) {
    for (const field of element.fields) {
      if (!isRecord(field)) continue;
      const fieldText = extractFromTextObject(field.text, variables);
      if (fieldText) parts.push(fieldText);
    }
  }

  // schema 2.0 / 嵌套容器兜底
  for (const key of ["body", "header", "card"]) {
    if (isRecord(element[key])) {
      parts.push(...extractInteractiveElementText(element[key], variables, attachments, depth + 1));
    }
  }

  return parts;
}

function readHeaderTitle(parsed: Record<string, unknown>, variables: Map<string, string>): string | undefined {
  const header = isRecord(parsed.header) ? parsed.header : undefined;
  if (!header) return undefined;
  const title = extractFromTextObject(header.title, variables);
  const subtitle = extractFromTextObject(header.subtitle, variables);
  return [title, subtitle].filter(Boolean).join(" — ") || undefined;
}

function readElementArrays(parsed: Record<string, unknown>): unknown[][] {
  const arrays: unknown[][] = [];
  const body = isRecord(parsed.body) ? parsed.body : undefined;
  for (const candidate of [parsed.elements, body?.elements]) {
    if (Array.isArray(candidate)) arrays.push(candidate);
  }
  for (const candidate of [parsed.i18n_elements, body?.i18n_elements]) {
    if (!isRecord(candidate)) continue;
    // 优先中文
    for (const locale of ["zh_cn", "en_us", ...Object.keys(candidate)]) {
      const localeElements = candidate[locale];
      if (Array.isArray(localeElements)) arrays.push(localeElements);
    }
  }
  return arrays;
}

/**
 * 将飞书 interactive 卡片 JSON 转为 agent 可读纯文本。
 * 失败时返回 fallback，避免静默丢消息。
 */
export function extractTextFromInteractiveCard(
  content: string,
  options?: { maxChars?: number },
): { text: string; attachments: FeishuAttachment[] } {
  const attachments: FeishuAttachment[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content || "{}");
  } catch {
    const fallback = content?.trim() ? content.trim().slice(0, options?.maxChars ?? 8000) : INTERACTIVE_CARD_FALLBACK;
    return { text: fallback, attachments };
  }

  // 部分事件 content 包一层 { type, data: { card } } 或 { card }
  if (isRecord(parsed)) {
    if (parsed.type === "interactive" && isRecord(parsed.card)) parsed = parsed.card;
    else if (isRecord(parsed.card)) parsed = parsed.card;
    else if (isRecord(parsed.data) && isRecord((parsed.data as Record<string, unknown>).card)) {
      parsed = (parsed.data as Record<string, unknown>).card;
    }
  }

  if (!isRecord(parsed)) {
    return { text: INTERACTIVE_CARD_FALLBACK, attachments };
  }

  const variables = readCardTemplateVariables(parsed);
  const parts: string[] = [];
  const header = readHeaderTitle(parsed, variables);
  if (header) parts.push(header);

  for (const elements of readElementArrays(parsed)) {
    for (const element of elements) {
      parts.push(...extractInteractiveElementText(element, variables, attachments));
    }
  }

  // 再扫一遍整棵树，防止 schema 变体漏抽
  if (!parts.length) {
    parts.push(...extractInteractiveElementText(parsed, variables, attachments));
  }

  let text = parts.map((p) => p.trim()).filter(Boolean).join("\n").trim();
  if (!text) {
    // 最后兜底：截断原始 JSON，便于排查
    const raw = JSON.stringify(parsed);
    text = `${INTERACTIVE_CARD_FALLBACK}\n${raw.slice(0, 1500)}`;
  }

  const maxChars = options?.maxChars ?? 12000;
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(truncated)`;
  return { text, attachments };
}

/** 将任意消息类型 content 尽量解析为文本（用于父消息展开） */
export function extractTextFromMsgType(
  msgType: string,
  content: string,
  botOpenId?: string,
): { text: string; attachments: FeishuAttachment[] } {
  const attachments: FeishuAttachment[] = [];
  if (msgType === "interactive") {
    return extractTextFromInteractiveCard(content);
  }
  try {
    const json = JSON.parse(content || "{}");
    if (msgType === "text") {
      let text = String(json.text || "");
      if (botOpenId) text = text.replace(new RegExp(`@?${botOpenId}`, "g"), "");
      return { text: text.trim(), attachments };
    }
    if (msgType === "post") {
      const post = json.post || json;
      const locale = post.zh_cn || post.en_us || Object.values(post).find((v) => isRecord(v) && Array.isArray((v as any).content));
      const parts: string[] = [];
      if (isRecord(locale)) {
        if (typeof locale.title === "string" && locale.title.trim()) parts.push(locale.title.trim());
        for (const para of (locale.content as unknown[]) || []) {
          if (!Array.isArray(para)) continue;
          for (const elem of para) {
            if (!isRecord(elem)) continue;
            if ((elem.tag === "text" || elem.tag === "a") && typeof elem.text === "string") parts.push(elem.text);
            if (elem.tag === "at") parts.push(`@${typeof elem.user_name === "string" ? elem.user_name : "user"}`);
            if ((elem.tag === "img" || elem.tag === "image") && typeof elem.image_key === "string") {
              attachments.push({ kind: "image", fileKey: elem.image_key });
            }
          }
        }
      }
      return { text: parts.join("").trim(), attachments };
    }
    if (msgType === "image" && typeof json.image_key === "string") {
      attachments.push({ kind: "image", fileKey: json.image_key });
      return { text: "", attachments };
    }
    if (msgType === "file" && typeof json.file_key === "string") {
      attachments.push({
        kind: "file",
        fileKey: json.file_key,
        fileName: typeof json.file_name === "string" ? json.file_name : undefined,
      });
      return { text: "", attachments };
    }
  } catch {
    // fallthrough
  }
  return { text: content?.trim() ? content.trim().slice(0, 2000) : `[${msgType}]`, attachments };
}

