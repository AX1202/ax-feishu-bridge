import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import qrcode from "qrcode-terminal";
import { CONFIG_PATH, DEFAULT_CONFIG, ensureRoot, mask, writeJson } from "./config.js";
import type { Domain, FeishuConfig, GroupPolicy } from "./types.js";

export async function uiSelect<T extends string>(ctx: ExtensionCommandContext, title: string, options: Array<{ value: T; label: string }>, initialValue?: T): Promise<T> {
  const ui: any = ctx.ui;
  if (typeof ui.select !== "function") {
    throw new Error("Current UI does not support select prompts.");
  }
  const labels = options.map((o) => o.label);
  const initialLabel = options.find((o) => o.value === initialValue)?.label;
  const selectedLabel = await ui.select(title, labels, initialLabel ? { initialValue: initialLabel } : undefined);
  const matched = options.find((o) => o.label === selectedLabel);
  if (!matched) {
    throw new Error("Selection cancelled.");
  }
  return matched.value;
}

export async function uiInput(ctx: ExtensionCommandContext, title: string, defaultValue = ""): Promise<string> {
  const ui: any = ctx.ui;
  if (typeof ui.input === "function") return String(await ui.input(title, defaultValue) || "");
  if (typeof ui.prompt === "function") return String(await ui.prompt(title, defaultValue) || "");
  throw new Error("Current UI does not support input prompts.");
}

export async function uiConfirm(ctx: ExtensionCommandContext, title: string, initial = true): Promise<boolean> {
  const ui: any = ctx.ui;
  if (typeof ui.confirm === "function") return Boolean(await ui.confirm(title, "", { initialValue: initial }));
  return initial;
}

export async function runSetup(ctx: ExtensionCommandContext) {
  ensureRoot();
  const mode = await uiSelect(ctx,
    "配置方式 / Setup method",
    [
      { value: "auto", label: "扫码自动创建飞书助手 / Create by QR code" },
      { value: "manual", label: "手动填写已有应用 / Configure existing app" },
    ],
    "auto",
  );

  let appId = "";
  let appSecret = "";
  let domain: Domain = "feishu";

  if (mode === "auto") {
    const created = await registerFeishuApp(ctx);
    appId = created.appId;
    appSecret = created.appSecret;
    domain = created.domain;
  } else {
    domain = await uiSelect(ctx,
      "应用区域 / App region",
      [
        { value: "feishu", label: "Feishu 中国 / Feishu China" },
        { value: "lark", label: "Lark 国际 / Lark Global" },
      ],
      "feishu",
    );
    appId = (await uiInput(ctx, "App ID / 应用 ID")).trim();
    appSecret = (await uiInput(ctx, "App Secret / 应用密钥")).trim();
  }

  const groupPolicy = await uiSelect<GroupPolicy>(ctx,
    "群聊策略 / Group policy",
    [
      { value: "open", label: "open：不需要 @，群/话题消息自动回复 / auto reply without @ in groups/topics" },
      { value: "mention", label: "mention：只有 @ 机器人才回复 / reply only when mentioned" },
    ],
    "open",
  );

  const config: FeishuConfig = {
    appId,
    appSecret,
    domain,
    groupPolicy,
    language: "zh",
    reactEmoji: DEFAULT_CONFIG.reactEmoji,
    autoStart: true,
  };
  writeJson(CONFIG_PATH, config);

  ctx.ui.notify(
    `飞书配置已保存 / Feishu config saved\nPath: ${CONFIG_PATH}\nApp ID: ${mask(appId)}\n群聊策略 / Group policy: ${groupPolicy}`,
    "info",
  );

  if (await uiConfirm(ctx, "现在启动飞书连接？ / Start Feishu now?", true)) {
    return config;
  }
  return undefined;
}

async function registerFeishuApp(ctx: ExtensionCommandContext): Promise<{ appId: string; appSecret: string; domain: Domain }> {
  const lark = await import("@larksuiteoapi/node-sdk");
  ctx.ui.notify("正在准备飞书授权二维码... / Preparing Feishu authorization QR code...", "info");

  const result = await lark.registerApp({
    source: "pi-feishu-extension",
    onQRCodeReady(info: { url: string; expireIn: number }) {
      qrcode.generate(info.url, { small: true }, (qr) => {
        console.log("\n飞书/Lark 授权二维码 / Feishu/Lark authorization QR code");
        console.log(qr);
        console.log(info.url);
        console.log(`二维码 ${info.expireIn} 秒后过期 / QR code expires in ${info.expireIn} seconds.`);
      });
      ctx.ui.notify(
        "请在终端扫描二维码，或打开终端中显示的链接。 / Scan the QR code in terminal, or open the link printed there.",
        "info",
      );
    },
    onStatusChange(info: any) {
      if (info?.status === "domain_switched") {
        ctx.ui.notify("检测到 Lark 租户，正在切换区域。 / Detected Lark tenant; switching domain.", "info");
      }
    },
  });

  const domain: Domain = result?.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    domain,
  };
}
