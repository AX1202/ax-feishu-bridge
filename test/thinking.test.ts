import test from "node:test";
import assert from "node:assert/strict";
import { buildThinkingCard, parseThinkingActionValue } from "../.pi/extensions/feishu/cards.ts";
import { getCommandList, parseBotCommand } from "../.pi/extensions/feishu/messages.ts";
import { normalizeThinkingLevels } from "../.pi/extensions/feishu/thinking.ts";

test("/thinking is recognized and documented", () => {
  assert.deepEqual(parseBotCommand(" /thinking "), { name: "thinking" });
  assert.match(getCommandList(), /\/thinking — 调整当前会话的思考强度/);
});

test("thinking card displays Pi values exactly, including max", () => {
  const levels = ["off", "low", "high", "max"];
  const card = buildThinkingCard("p2p:user", { provider: "deepseek", id: "deepseek-v4-flash" }, {
    currentLevel: "max",
    availableLevels: levels,
    source: "pi",
  }) as any;

  assert.equal(card.header.title.content, "调整思考强度");
  assert.match(card.elements[0].content, /Current: \*\*max\*\*/);

  const buttons = card.elements
    .filter((element: any) => element.tag === "action")
    .flatMap((element: any) => element.actions);
  assert.deepEqual(buttons.map((button: any) => button.text.content), levels);
  assert.deepEqual(buttons.map((button: any) => button.value.level), levels);
  assert.equal(buttons.find((button: any) => button.value.level === "max").type, "primary");
  assert.equal(buttons.every((button: any) => button.value.action === "pi_feishu_select_thinking"), true);
});

test("unknown future Pi values are preserved instead of filtered", () => {
  const levels = normalizeThinkingLevels(["off", "provider-ultra", "max", "provider-ultra", ""]);
  assert.deepEqual(levels, ["off", "provider-ultra", "max"]);

  const card = buildThinkingCard("p2p:user", { provider: "example", id: "future-model" }, {
    currentLevel: "provider-ultra",
    availableLevels: levels,
    source: "pi",
  }) as any;

  const buttons = card.elements
    .filter((element: any) => element.tag === "action")
    .flatMap((element: any) => element.actions);
  assert.deepEqual(buttons.map((button: any) => button.text.content), levels);
  assert.equal(buttons.find((button: any) => button.value.level === "provider-ultra").type, "primary");
});

test("thinking action payload keeps any non-empty Pi value for server-side revalidation", () => {
  assert.deepEqual(parseThinkingActionValue({
    action: "pi_feishu_select_thinking",
    key: "p2p:user",
    level: "max",
  }), { key: "p2p:user", level: "max" });
  assert.deepEqual(parseThinkingActionValue({
    action: "pi_feishu_select_thinking",
    key: "p2p:user",
    level: "provider-ultra",
  }), { key: "p2p:user", level: "provider-ultra" });
  assert.equal(parseThinkingActionValue({ action: "pi_feishu_select_thinking", key: "p2p:user", level: "" }), undefined);
  assert.equal(parseThinkingActionValue({ action: "pi_feishu_select_model", key: "p2p:user", level: "high" }), undefined);
});

test("unavailable Pi capability does not invent a fallback option", () => {
  const card = buildThinkingCard("p2p:user", { provider: "example", id: "legacy" }, {
    currentLevel: undefined,
    availableLevels: [],
    source: "unavailable",
  }) as any;

  assert.match(card.elements[0].content, /未显示任何猜测的选项/);
  assert.equal(card.elements.some((element: any) => element.tag === "action"), false);
});
