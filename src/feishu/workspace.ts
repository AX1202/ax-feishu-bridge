/**
 * 工作区路径解析与校验（平台无关，各 Runtime 适配器共用）。
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function resolveWorkspacePath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("请在 /workspace 后面带上目录路径，例如：/workspace /Users/ax/project");
  }

  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? join(homedir(), trimmed.slice(2))
    : trimmed;

  if (!isAbsolute(expanded)) {
    throw new Error("当前只支持绝对路径或 ~/ 开头的路径。");
  }

  const resolved = resolve(expanded);
  ensureWorkspaceExists(resolved);
  return realpathSync(resolved);
}

export function ensureWorkspaceExists(path: string) {
  if (!existsSync(path)) {
    throw new Error(`工作区不存在：${path}`);
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`无法访问工作区：${path}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`工作区不是目录：${path}`);
  }
}
