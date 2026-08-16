/**
 * Harness 环境的飞书配置向导（终端一问一答版）。
 * 与 Pi 的 /feishu setup 问同样的问题；写 Harness 自己的 config.harness.json，
 * 与 Pi 的配置完全独立。
 */
import { CONFIG_HARNESS_PATH, DEFAULT_CONFIG, ensureRoot, mask, writeJson } from "../../feishu/config.ts";
import { registerFeishuApp } from "../../feishu/app-register.ts";
import type { Domain, FeishuConfig, GroupPolicy } from "../../feishu/types.ts";

/**
 * 终端问答器：直接监听 stdin 的行输入（不依赖 readline，管道/终端都可靠）。
 * 回车即提交；Ctrl+C 由进程默认 SIGINT 处理直接退出。
 */
function createPrompter() {
  let buffer = "";
  const pendingLines: string[] = [];
  const queue: Array<(line: string) => void> = [];
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      const resolve = queue.shift();
      // 管道输入可能早于提问到达：没有等待者时先缓存，提问时再取
      if (resolve) resolve(line);
      else pendingLines.push(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  return {
    question(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      return new Promise((resolve) => {
        const cached = pendingLines.shift();
        if (cached !== undefined) resolve(cached);
        else queue.push(resolve);
      });
    },
  };
}

type Prompter = ReturnType<typeof createPrompter>;

function select<T extends string>(
  prompter: Prompter,
  title: string,
  options: Array<{ value: T; label: string }>,
  initialValue?: T,
): Promise<T> {
  console.log(`\n${title}`);
  options.forEach((option, index) => {
    console.log(`  ${index + 1}) ${option.label}`);
  });
  const initialIndex = options.findIndex((option) => option.value === initialValue);
  const defaultLabel = initialIndex >= 0 ? String(initialIndex + 1) : "";
  return (async () => {
    for (;;) {
      const answer = (await prompter.question(`请输入序号${defaultLabel ? `（默认 ${defaultLabel}）` : ""}: `)).trim();
      const selectedIndex = answer === "" && defaultLabel
        ? initialIndex
        : Number.parseInt(answer, 10) - 1;
      if (selectedIndex >= 0 && selectedIndex < options.length) {
        return options[selectedIndex]!.value;
      }
      console.log("无效输入，请重新选择。 / Invalid input, please try again.");
    }
  })();
}

/**
 * 运行配置向导。成功返回配置（已落盘 config.json），用户中途退出返回 undefined。
 */
export async function runHarnessSetup(): Promise<FeishuConfig | undefined> {
  ensureRoot();
  const prompter = createPrompter();
  console.log("=== 飞书 / Lark 机器人配置向导 / Setup wizard ===");
  const mode = await select(
    prompter,
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
    console.log();
    const created = await registerFeishuApp();
    appId = created.appId;
    appSecret = created.appSecret;
    domain = created.domain;
  } else {
    domain = await select(
      prompter,
      "应用区域 / App region",
      [
        { value: "feishu", label: "Feishu 中国 / Feishu China" },
        { value: "lark", label: "Lark 国际 / Lark Global" },
      ],
      "feishu",
    );
    appId = (await prompter.question("App ID / 应用 ID: ")).trim();
    appSecret = (await prompter.question("App Secret / 应用密钥: ")).trim();
  }

  if (!appId || !appSecret) {
    console.log("App ID 和 App Secret 不能为空，配置未保存。 / App ID and App Secret are required; config not saved.");
    return undefined;
  }

  const groupPolicy = await select<GroupPolicy>(
    prompter,
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
  writeJson(CONFIG_HARNESS_PATH, config);
  console.log(`\n飞书配置已保存 / Feishu config saved\nPath: ${CONFIG_HARNESS_PATH}\nApp ID: ${mask(appId)}\n群聊策略 / Group policy: ${groupPolicy}`);
  return config;
}
