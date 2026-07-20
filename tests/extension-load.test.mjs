import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = join(dirname(codingAgentEntry), "cli.js");
const extensionPath = join(repoRoot, ".pi/extensions/feishu/index.ts");
const settleExtensionPath = join(repoRoot, "tests/fixtures/settle-extension.ts");

function runFeishuCommand(command) {
  const homeDir = mkdtempSync(join(tmpdir(), "pi-feishu-lark-test-"));
  try {
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
      "-p",
      command,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
        PI_OFFLINE: "1",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
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
