import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_CONFIG_KEYS,
  applyRuntimeOverrides,
  clearRuntimeOverrides,
  formatRuntimeConfig,
  getRuntimeOverrides,
  isRuntimeConfigKey,
  parseRuntimeConfigValue,
  setRuntimeConfig,
} from "../.pi/extensions/feishu/runtime-config.ts";
function baseCfg(partial: Record<string, unknown> = {}) {
  return {
    appId: "cli_test",
    appSecret: "secret",
    domain: "feishu",
    groupPolicy: "mention" as const,
    groupKeywords: [] as string[],
    groupAlsoOnReply: false,
    language: "zh" as const,
    reactEmoji: "Get",
    streamingReply: true,
    streamPrintFrequencyMs: 50,
    streamPrintStep: 1,
    streamPushIntervalMs: 120,
    ...partial,
  };
}

test("isRuntimeConfigKey only allows whitelist", () => {
  assert.equal(isRuntimeConfigKey("groupKeywords"), true);
  assert.equal(isRuntimeConfigKey("groupPolicy"), true);
  assert.equal(isRuntimeConfigKey("streamingReply"), true);
  assert.equal(isRuntimeConfigKey("ignoreBotMessages"), true);
  assert.equal(isRuntimeConfigKey("appId"), false);
  assert.equal(isRuntimeConfigKey("appSecret"), false);
  assert.equal(isRuntimeConfigKey("cardActionMode"), false);
  assert.ok(RUNTIME_CONFIG_KEYS.includes("reactEmoji"));
});

test("parseRuntimeConfigValue for keywords / bool / enum / number", () => {
  assert.deepEqual(parseRuntimeConfigValue("groupKeywords", "志胜, zs"), {
    ok: true,
    value: ["志胜", "zs"],
  });
  assert.deepEqual(parseRuntimeConfigValue("groupAlsoOnReply", "true"), { ok: true, value: true });
  assert.deepEqual(parseRuntimeConfigValue("groupAlsoOnReply", "0"), { ok: true, value: false });
  assert.deepEqual(parseRuntimeConfigValue("ignoreBotMessages", "false"), { ok: true, value: false });
  assert.deepEqual(parseRuntimeConfigValue("ignoreBotMessages", "1"), { ok: true, value: true });
  assert.deepEqual(parseRuntimeConfigValue("groupPolicy", "open"), { ok: true, value: "open" });
  assert.equal(parseRuntimeConfigValue("groupPolicy", "admin").ok, false);
  assert.deepEqual(parseRuntimeConfigValue("language", "en"), { ok: true, value: "en" });
  assert.deepEqual(parseRuntimeConfigValue("streamPrintStep", "3"), { ok: true, value: 3 });
  assert.equal(parseRuntimeConfigValue("streamPrintStep", "0").ok, false);
  assert.equal(parseRuntimeConfigValue("appId", "x").ok, false);
});

test("applyRuntimeOverrides merges whitelist only", () => {
  const base = baseCfg({ groupKeywords: ["a"], reactEmoji: "Get" });
  const merged = applyRuntimeOverrides(base, {
    groupKeywords: ["志胜"],
    reactEmoji: "OK",
    appSecret: "hacked",
  } as any);
  assert.deepEqual(merged.groupKeywords, ["志胜"]);
  assert.equal(merged.reactEmoji, "OK");
  assert.equal(merged.appSecret, "secret");
});

test("set/get/clear runtime overrides persist on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-rt-"));
  const path = join(dir, "runtime-overrides.json");
  try {
    const r1 = setRuntimeConfig("groupKeywords", "志胜,zhisheng", { path });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    assert.deepEqual(r1.overrides.groupKeywords, ["志胜", "zhisheng"]);

    const loaded = getRuntimeOverrides(path);
    assert.deepEqual(loaded.groupKeywords, ["志胜", "zhisheng"]);

    const r2 = setRuntimeConfig("groupAlsoOnReply", "1", { path });
    assert.equal(r2.ok, true);
    const loaded2 = getRuntimeOverrides(path);
    assert.equal(loaded2.groupAlsoOnReply, true);
    assert.deepEqual(loaded2.groupKeywords, ["志胜", "zhisheng"]);

    clearRuntimeOverrides("groupKeywords", path);
    assert.equal(getRuntimeOverrides(path).groupKeywords, undefined);
    assert.equal(getRuntimeOverrides(path).groupAlsoOnReply, true);

    clearRuntimeOverrides("all", path);
    assert.deepEqual(getRuntimeOverrides(path), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatRuntimeConfig shows effective values", () => {
  const text = formatRuntimeConfig(
    baseCfg({
      groupKeywords: ["志胜"],
      groupAlsoOnReply: true,
      ignoreBotMessages: false,
      streamingReply: false,
    }),
  );
  assert.match(text, /groupPolicy:\s*mention/);
  assert.match(text, /groupKeywords:\s*志胜/);
  assert.match(text, /groupAlsoOnReply:\s*true/);
  assert.match(text, /ignoreBotMessages:\s*false/);
  assert.match(text, /streamingReply:\s*false/);
  assert.doesNotMatch(text, /appSecret/);
});

