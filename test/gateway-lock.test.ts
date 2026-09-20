/**
 * 连接锁按机器人凭证（appId）区分的测试：
 * - 不同机器人：各拿各的钥匙，可并行获取
 * - 同一机器人：互斥，后来的拿不到
 * - 释放后同机器人可再次获取
 * - 同进程重入：报 self-held（不是 busy）—— 见下方回归说明
 *
 * 注意：LOCKS_PATH 是模块级常量（import 时即由 homedir() 求值），
 * 因此用例内改 process.env.HOME **不会**改变锁文件位置；这些用例会读写
 * 真实的 ~/.pi/agent/locks.json（与既有用例同一行为，非本 PR 引入）。
 * 各用例一律使用带时间戳的唯一 appId，避免与真实机器人键冲突。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    // 回归锚点：同进程重入必须报 self-held。修复前这里返回 "busy"，
    // 调用方会把"自持"误判为"被其它实例占用"进而 process.exit(0)，杀死 daemon。
    assert.equal(
      second.status,
      "self-held",
      "same bot must not connect twice — this process already holds the lock",
    );
    assert.ok(!("handle" in second), "self-held must not hand out a second handle");
    assert.equal(second.owner.pid, process.pid, "self-held must carry the real owner");

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

test("a lock held by another live pid is still reported as busy", async () => {
  // 反向保护：不得为了修"自持"而把跨进程互斥改坏。
  // 由一个真实子进程通过锁 API 持锁（而非直接改写 locks.json）——
  // 裸写会绕过 withLocksFileLock，与真实 daemon 的心跳读-改-写竞争。
  const appId = `app-foreign-${process.pid}-${Date.now()}`;
  const lockModuleUrl = new URL("../src/feishu/gateway-lock.ts", import.meta.url).href;
  const holder = `
    const { acquireGatewayLock } = await import(${JSON.stringify(lockModuleUrl)});
    const result = await acquireGatewayLock("/tmp/ws", false, ${JSON.stringify(appId)});
    if (result.status !== "acquired") {
      console.log("NOT_HELD:" + result.status);
      process.exit(2);
    }
    console.log("HELD");
    process.on("SIGTERM", async () => { await result.handle.release(); process.exit(0); });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", holder],
    { env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("holder process did not become ready")), 15_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (chunk.includes("HELD") || chunk.includes("NOT_HELD")) {
          clearTimeout(timer);
          resolve(chunk.trim());
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`holder exited early with code ${code}`));
      });
    });
    assert.equal(ready, "HELD", "holder process must actually own the lock");

    const result = await acquireGatewayLock("/tmp/ws", false, appId);
    assert.equal(result.status, "busy", "a live foreign holder must still block");
    assert.equal(result.owner.pid, child.pid);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000);
    });
  }
});
