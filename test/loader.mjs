import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 将 .js 说明符映射到同目录 .ts。
 * 不 shortCircuit，交给 --experimental-strip-types 处理，
 * 否则 type-only import / export type 会 SyntaxError。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    const tsPath = join(parentDir, specifier.replace(/\.js$/, ".ts"));
    if (existsSync(tsPath)) {
      return nextResolve(pathToFileURL(tsPath).href, context);
    }
  }
  return nextResolve(specifier, context);
}

