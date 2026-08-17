import test from "node:test";
import assert from "node:assert/strict";
import {
  HARNESS_SOURCE,
  PI_SOURCE,
  defaultCardActionWebhookPort,
  setRuntimeSource,
} from "../src/feishu/config.ts";

test("默认卡片回调端口按 runtime 区分：Pi 3001 / DSH 3002", () => {
  setRuntimeSource(PI_SOURCE);
  assert.equal(defaultCardActionWebhookPort(), 3001);
  setRuntimeSource(HARNESS_SOURCE);
  assert.equal(defaultCardActionWebhookPort(), 3002);
  // 恢复默认，避免影响其他用例
  setRuntimeSource(PI_SOURCE);
});
