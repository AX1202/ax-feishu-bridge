export type ThinkingStatus = {
  /** Pi 当前会话返回的原始值；不做翻译或归一化。 */
  currentLevel?: string;
  /** Pi 当前模型返回的原始可选值，顺序保持不变。 */
  availableLevels: string[];
  /** Pi 是否提供了可用档位列表。没有就不能安全地猜测或展示。 */
  source: "pi" | "unavailable";
};

/**
 * 只做结构清理：保留 Pi 返回的每个非空字符串，不维护任何固定档位名单。
 * 这样模型或 Pi 新增档位时，飞书无需同步发布也不会漏掉它。
 */
export function normalizeThinkingLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const levels: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || seen.has(item)) continue;
    seen.add(item);
    levels.push(item);
  }
  return levels;
}
