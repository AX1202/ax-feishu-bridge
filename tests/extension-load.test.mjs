import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = join(dirname(codingAgentEntry), "cli.js");
const extensionPath = join(repoRoot, ".pi/extensions/feishu/index.ts");
const modelRuntimeExtensionPath = join(repoRoot, "tests/fixtures/model-runtime-extension.ts");
const settleExtensionPath = join(repoRoot, "tests/fixtures/settle-extension.ts");

function runFeishuCommand(command, extraExtensions = [], setup) {
  const homeDir = mkdtempSync(join(tmpdir(), "pi-feishu-lark-test-"));
  const agentDir = join(homeDir, ".pi", "agent");
  const isolatedEnv = { ...process.env };
  for (const key of Object.keys(isolatedEnv)) {
    if (key.startsWith("FEISHU_") || key.startsWith("LARK_") || key.startsWith("PI_FEISHU_")) {
      delete isolatedEnv[key];
    }
  }

  try {
    setup?.({ homeDir, agentDir });
    const extraExtensionArgs = extraExtensions.flatMap((path) => ["-e", path]);
    return spawnSync(process.execPath, [
      piCli,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--no-session",
      "-e",
      extensionPath,
      "-e",
      settleExtensionPath,
      ...extraExtensionArgs,
      "-p",
      command,
    ], {
      cwd: repoRoot,
      env: {
        ...isolatedEnv,
        HOME: homeDir,
        USERPROFILE: homeDir,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function configureFixtureModelRuntime({ agentDir }) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      "fixture-provider": {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        apiKey: "fixture-api-key",
        models: [{ id: "fallback-model" }, { id: "target-model" }],
      },
    },
  }, null, 2)}\n`);
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "fixture-provider",
    defaultModel: "target-model",
  }, null, 2)}\n`);
}

function outputOf(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

test("loads with the current Pi SDK", () => {
  const result = runFeishuCommand("/feishu status");
  assert.equal(result.status, 0, outputOf(result) || `Pi exited via ${result.signal || "unknown signal"}`);
});

test("does not start the daemon before Feishu is configured", () => {
  const result = runFeishuCommand("/wait-for-extension-settle");
  const output = outputOf(result);
  assert.equal(result.status, 0, output || `Pi exited via ${result.signal || "unknown signal"}`);
  assert.doesNotMatch(output, /daemon spawn failed|Missing config/);
});

test("initializes the current Pi model runtime", () => {
  const result = runFeishuCommand(
    "/verify-feishu-model-runtime",
    [modelRuntimeExtensionPath],
    configureFixtureModelRuntime,
  );
  assert.equal(result.status, 0, outputOf(result) || `Pi exited via ${result.signal || "unknown signal"}`);
});
