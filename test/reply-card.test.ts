import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCardKitCardJson,
  buildReplyCard,
  buildStopButton,
  parseStopTaskActionValue,
  STOP_ACTION,
} from "../.pi/extensions/feishu/card-builder.ts";

function hasStopControl(card: unknown) {
  const s = JSON.stringify(card);
  return s.includes("停止") && s.includes(STOP_ACTION);
}

function headerTitle(card: any) {
  return card?.header?.title?.content;
}

test("running interactive card always has stop button", () => {
  const card = buildReplyCard({ key: "k1", status: "running", body: "hi", runId: "r1" });
  assert.equal(headerTitle(card), "回复中");
  assert.equal(hasStopControl(card), true);
  assert.equal(JSON.stringify(card).includes("任务"), false);
});

test("done interactive card has no stop button", () => {
  const card = buildReplyCard({ key: "k1", status: "done", body: "最终回复" });
  assert.equal(headerTitle(card), "回复");
  assert.equal(hasStopControl(card), false);
  assert.match(JSON.stringify(card), /最终回复/);
});

test("CardKit running card must include stop button and streaming config", () => {
  const card = buildCardKitCardJson({
    status: "running",
    body: "",
    key: "p2p:user",
    runId: "run-1",
    streaming: true,
    printFrequencyMs: 50,
    printStep: 1,
  }) as any;
  assert.equal(card.schema, "2.0");
  assert.equal(headerTitle(card), "回复中");
  assert.equal(card.config.streaming_mode, true);
  assert.equal(card.config.streaming_config.print_step.default, 1);
  assert.equal(hasStopControl(card), true);
  // content element id for CardKit PUT path
  const md = card.body.elements.find((e: any) => e.tag === "markdown");
  assert.equal(md.element_id, "content");
  assert.equal(md.content, "正在回复…");
  const btn = card.body.elements.find((e: any) => e.tag === "button");
  assert.ok(btn);
  assert.equal(btn.type, "danger");
  assert.equal(btn.behaviors?.[0]?.type, "callback");
  assert.equal(btn.behaviors?.[0]?.value?.action, STOP_ACTION);
  assert.equal(btn.behaviors?.[0]?.value?.key, "p2p:user");
  assert.equal(btn.behaviors?.[0]?.value?.runId, "run-1");
});

test("CardKit done card updates header and removes stop", () => {
  const card = buildCardKitCardJson({
    status: "done",
    body: "完整答案",
    key: "p2p:user",
    runId: "run-1",
    streaming: false,
  }) as any;
  assert.equal(headerTitle(card), "回复");
  assert.equal(card.config.streaming_mode, false);
  assert.equal(hasStopControl(card), false);
  assert.match(JSON.stringify(card), /完整答案/);
});

test("CardKit stopped/failed headers", () => {
  const s = buildCardKitCardJson({ status: "stopped", body: "半段", key: "k" }) as any;
  const f = buildCardKitCardJson({ status: "failed", body: "err", key: "k" }) as any;
  assert.equal(headerTitle(s), "已停止");
  assert.equal(headerTitle(f), "出错了");
  assert.equal(hasStopControl(s), false);
  assert.equal(hasStopControl(f), false);
});

test("buildStopButton payload is parseable by stop handler", () => {
  const btn = buildStopButton("conv-key", "run-xyz") as any;
  const parsed = parseStopTaskActionValue(btn.value);
  assert.deepEqual(parsed, { key: "conv-key", runId: "run-xyz" });
  const parsedBehavior = parseStopTaskActionValue(btn.behaviors[0].value);
  assert.deepEqual(parsedBehavior, { key: "conv-key", runId: "run-xyz" });
});

test("regression: streaming running card without key must not silently drop stop contract when key provided", () => {
  // 无 key 时无法回调停止，但有 key 时绝不能丢按钮（防 CardKit 路径回归）
  const withKey = buildCardKitCardJson({ status: "running", key: "k", runId: "r", streaming: true });
  const withoutKey = buildCardKitCardJson({ status: "running", streaming: true });
  assert.equal(hasStopControl(withKey), true);
  assert.equal(hasStopControl(withoutKey), false);
});
