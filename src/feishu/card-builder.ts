/** 单卡 UI 纯函数：构建飞书 interactive / CardKit 卡片 JSON（无 IO） */
export type ReplyCardStatus = "running" | "done" | "failed" | "stopped" | "inactive";

export const STOP_ACTION = "pi_feishu_stop_task";
const MAX_NOTE_CHARS = 96;
const WAITING_TEXT = "正在回复…";

/** CardKit JSON 2.0 停止按钮（直接放在 elements 里，不用 1.0 的 action 模块） */
export function buildStopButton(key: string, runId?: string) {
  return {
    tag: "button",
    type: "danger",
    text: { tag: "plain_text", content: "停止" },
    // 兼容旧 value 回调 + JSON 2.0 behaviors.callback
    value: { action: STOP_ACTION, key, runId },
    behaviors: [
      {
        type: "callback",
        value: { action: STOP_ACTION, key, runId },
      },
    ],
  };
}

/**
 * CardKit schema 2.0 卡片（流式/全量更新共用）。
 * running 必须带停止按钮，避免只有 markdown 无法中止。
 */
export function buildCardKitCardJson(input: {
  status: ReplyCardStatus;
  body?: string;
  key?: string;
  runId?: string;
  note?: string;
  streaming?: boolean;
  printFrequencyMs?: number;
  printStep?: number;
}) {
  const running = input.status === "running";
  const body = (input.body || "").trim();
  const note = input.note ? normalizeNote(input.note) : undefined;
  const elements: object[] = [];

  if (running) {
    elements.push({
      tag: "markdown",
      content: body || WAITING_TEXT,
      element_id: "content",
    });
    if (input.key) {
      elements.push(buildStopButton(input.key, input.runId));
    }
  } else if (input.status === "done") {
    elements.push({
      tag: "markdown",
      content: body || " ",
      element_id: "content",
    });
  } else {
    const parts: string[] = [];
    if (note) parts.push(note);
    if (body) parts.push(body);
    elements.push({
      tag: "markdown",
      content: parts.join("\n\n") || " ",
      element_id: "content",
    });
  }

  const config: Record<string, unknown> = {
    wide_screen_mode: true,
    update_multi: true,
    streaming_mode: Boolean(input.streaming && running),
  };
  if (input.streaming && running) {
    config.streaming_config = {
      print_frequency_ms: { default: input.printFrequencyMs ?? 50 },
      print_step: { default: input.printStep ?? 1 },
    };
  }

  return {
    schema: "2.0",
    config,
    header: {
      template: headerTemplate(input.status),
      title: { tag: "plain_text", content: titleForStatus(input.status) },
    },
    body: { elements },
  };
}

/**
 * 普通 interactive 消息卡片（非 CardKit 实体）：
 * - running: 标题「回复中」+ 正文 + [停止]
 * - done: 标题「回复」+ 最终正文
 * - stopped/failed: 标题 + 说明
 */
export function buildReplyCard(input: {
  key: string;
  status: ReplyCardStatus;
  note?: string;
  body?: string;
  runId?: string;
}) {
  const running = input.status === "running";
  const body = (input.body || "").trim();
  const note = input.note ? normalizeNote(input.note) : undefined;
  const elements: object[] = [];

  if (running) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: body || WAITING_TEXT },
    });
    // 1.0 interactive 仍可用 action 模块；同时附带 2.0 button 以兼容
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "停止" },
          type: "danger",
          value: { action: STOP_ACTION, key: input.key, runId: input.runId },
        },
      ],
    });
  } else if (input.status === "done") {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: body || " " },
    });
  } else {
    if (note) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: note },
      });
    }
    if (body) {
      if (elements.length) elements.push({ tag: "hr" });
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: body },
      });
    }
    if (!elements.length) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: " " },
      });
    }
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: headerTemplate(input.status),
      title: { tag: "plain_text", content: titleForStatus(input.status) },
    },
    elements,
  };
}

export function parseStopTaskActionValue(value: unknown): { key: string; runId?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== STOP_ACTION || typeof raw.key !== "string") return undefined;
  return {
    key: raw.key,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
  };
}

function normalizeNote(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_NOTE_CHARS) return compact;
  return `${compact.slice(0, MAX_NOTE_CHARS - 1)}…`;
}

function titleForStatus(status: ReplyCardStatus) {
  if (status === "done") return "回复";
  if (status === "failed") return "出错了";
  if (status === "stopped") return "已停止";
  if (status === "inactive") return "已结束";
  return "回复中";
}

function headerTemplate(status: ReplyCardStatus) {
  if (status === "done") return "green";
  if (status === "failed") return "red";
  if (status === "stopped") return "grey";
  if (status === "inactive") return "grey";
  return "blue";
}

export function defaultFinalNote(status: Exclude<ReplyCardStatus, "running" | "inactive">): string | undefined {
  if (status === "done") return undefined;
  if (status === "failed") return "处理失败";
  return "已停止";
}
