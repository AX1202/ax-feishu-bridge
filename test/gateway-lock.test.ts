/**
 * 连接锁按机器人凭证（appId）区分的测试：
 * - 不同机器人：各拿各的钥匙，可并行获取
 * - 同一机器人：互斥，后来的拿不到
 * - 释放后同机器人可再次获取
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGatewayLock } from "../src/feishu/gateway-lock.ts";

test("gateway lock is per-appId: different bots can hold locks in parallel", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "feishu-lock-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const botA = await acquireGatewayLock("/tmp/ws", false, "app-bot-a");
    assert.equal(botA.status, "acquired");
    const botB = await acquireGatewayLock("/tmp/ws", false, "app-bot-b");
    assert.equal(botB.status, "acquired", "different bot should get its own lock");

    await botA.handle.release();
    await botB.handle.release();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("gateway lock is per-appId: same bot stays exclusive", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "feishu-lock-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const first = await acquireGatewayLock("/tmp/ws", false, "app-bot-a");
    assert.equal(first.status, "acquired");
    const second = await acquireGatewayLock("/tmp/ws", false, "app-bot-a");
    assert.equal(second.status, "busy", "same bot must not connect twice");

    await first.handle.release();
    const third = await acquireGatewayLock("/tmp/ws", false, "app-bot-a");
    assert.equal(third.status, "acquired", "after release the same bot can connect again");
    await third.handle.release();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
