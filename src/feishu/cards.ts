import { type ThinkingStatus } from "./thinking.js";

export function modelLabel(model: any) {
  if (!model) return "未选择";
  return `${model.provider}/${model.id}`;
}

export type ResumeScope = "current" | "all";

export type ResumeSessionItem = {
  path: string;
  title: string;
  subtitle: string;
  modifiedLabel: string;
  workspaceLabel?: string;
  isCurrent: boolean;
};

export type ResumeSessionPage = {
  key: string;
  /** 当前飞书会话绑定的工作区；无论浏览哪个范围都用于说明筛选上下文。 */
  workspacePath: string;
  scope: ResumeScope;
  page: number;
  total: number;
  totalPages: number;
  items: ResumeSessionItem[];
};

export function buildModelCard(key: string, models: any[], currentModel: any) {
  const current = modelLabel(currentModel);
  const elements: any[] = [
    {
      tag: "markdown",
      content: `当前模型：**${current}**\n点击下面的按钮即可切换当前飞书会话使用的模型。`,
    },
  ];

  const rows: any[][] = [];
  for (let i = 0; i < models.length; i += 2) {
    rows.push(models.slice(i, i + 2));
  }

  for (const row of rows) {
    elements.push({
      tag: "action",
      actions: row.map((model) => {
        const isCurrent = currentModel?.provider === model.provider && currentModel?.id === model.id;
        return {
          tag: "button",
          text: {
            tag: "plain_text",
            content: `${isCurrent ? "当前 " : ""}${model.provider}/${model.id}`,
          },
          type: isCurrent ? "primary" : "default",
          value: {
            action: "pi_feishu_select_model",
            key,
            provider: model.provider,
            modelId: model.id,
          },
        };
      }),
    });
  }

  return {
    config: sharedCardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "选择 Pi 模型" },
    },
    elements,
  };
}

export function buildThinkingCard(key: string, currentModel: any, status: ThinkingStatus) {
  const model = modelLabel(currentModel);
  const elements: any[] = [
    {
      tag: "markdown",
      content: status.source === "unavailable"
        ? `当前模型：**${model}**\n无法从 Pi 读取这个模型可用的 thinking levels，因此未显示任何猜测的选项。`
        : status.availableLevels.length === 0
          ? `当前模型：**${model}**\nPi 未返回可用的 thinking levels。`
          : `当前模型：**${model}**\nCurrent: **${escapeMarkdown(status.currentLevel || "(unknown)")}**\n以下选项由 Pi 当前会话直接返回。`,
    },
  ];

  if (status.source === "pi") {
    for (let i = 0; i < status.availableLevels.length; i += 3) {
      const row = status.availableLevels.slice(i, i + 3);
      elements.push({
        tag: "action",
        actions: row.map((level) => {
          const isCurrent = level === status.currentLevel;
          return {
            tag: "button",
            text: {
              tag: "plain_text",
              content: level,
            },
            type: isCurrent ? "primary" : "default",
            value: {
              action: "pi_feishu_select_thinking",
              key,
              level,
            },
          };
        }),
      });
    }
  }

  return {
    config: sharedCardConfig(),
    header: {
      template: "purple",
      title: { tag: "plain_text", content: "调整思考强度" },
    },
    elements,
  };
}

export function buildResumeCard(data: ResumeSessionPage) {
  const elements: any[] = [
    {
      tag: "markdown",
      content: [
        `当前工作区：**${escapeMarkdown(data.workspacePath)}**`,
        data.total
          ? `第 **${data.page + 1} / ${data.totalPages}** 页，共 **${data.total}** 条历史会话。`
          : "还没有可切换的历史会话。",
        "点击某条会话后，当前飞书对话会继续接着这条 Pi 会话往下聊。",
      ].join("\n"),
    },
  ];

  elements.push({
    tag: "action",
    actions: [
      buildResumeScopeButton(data.key, "current", data.scope === "current"),
      buildResumeScopeButton(data.key, "all", data.scope === "all"),
    ],
  });

  for (const item of data.items) {
    const lines = [
      `**${escapeMarkdown(item.title)}**${item.isCurrent ? " `当前使用中`" : ""}`,
      escapeMarkdown(item.subtitle),
      `更新时间：${escapeMarkdown(item.modifiedLabel)}`,
    ];
    if (item.workspaceLabel) lines.push(`工作区：${escapeMarkdown(item.workspaceLabel)}`);
    elements.push({
      tag: "markdown",
      content: lines.join("\n"),
    });
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: {
          tag: "plain_text",
          content: item.isCurrent ? "当前会话" : "切换到这条会话",
        },
        type: item.isCurrent ? "primary" : "default",
        value: {
          action: "pi_feishu_resume_select",
          key: data.key,
          scope: data.scope,
          page: data.page,
          sessionPath: item.path,
        },
      }],
    });
  }

  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "上一页" },
        type: "default",
        disabled: data.page <= 0,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.max(0, data.page - 1),
        },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "下一页" },
        type: "default",
        disabled: data.page >= data.totalPages - 1,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.min(Math.max(0, data.totalPages - 1), data.page + 1),
        },
      },
    ],
  });

  return {
    config: sharedCardConfig(),
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: "切换 Pi 历史会话" },
    },
    elements,
  };
}

export function parseModelActionValue(value: unknown): { key: string; provider: string; modelId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_select_model") return undefined;
  if (typeof raw.key !== "string" || typeof raw.provider !== "string" || typeof raw.modelId !== "string") return undefined;
  return { key: raw.key, provider: raw.provider, modelId: raw.modelId };
}

export function parseThinkingActionValue(value: unknown): { key: string; level: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_select_thinking") return undefined;
  if (typeof raw.key !== "string" || typeof raw.level !== "string" || !raw.level.trim()) return undefined;
  return { key: raw.key, level: raw.level };
}

export function parseResumePageActionValue(value: unknown): { key: string; scope: ResumeScope; page: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_page") return undefined;
  if (typeof raw.key !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return { key: raw.key, scope: raw.scope, page: Math.max(0, Math.floor(raw.page)) };
}

export function parseResumeSelectActionValue(value: unknown): { key: string; scope: ResumeScope; page: number; sessionPath: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_select") return undefined;
  if (typeof raw.key !== "string" || typeof raw.sessionPath !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return {
    key: raw.key,
    scope: raw.scope,
    page: Math.max(0, Math.floor(raw.page)),
    sessionPath: raw.sessionPath,
  };
}

function buildResumeScopeButton(key: string, scope: ResumeScope, active: boolean) {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: scope === "current" ? "当前工作区" : "全部会话",
    },
    type: active ? "primary" : "default",
    value: {
      action: "pi_feishu_resume_page",
      key,
      scope,
      page: 0,
    },
  };
}

function escapeMarkdown(text: string) {
  return text.replace(/[`*_~]/g, "\\$&");
}

function sharedCardConfig() {
  return {
    wide_screen_mode: true,
    update_multi: true,
  };
}
