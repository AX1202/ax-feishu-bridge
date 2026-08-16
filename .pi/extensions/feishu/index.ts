/**
 * PI 扩展入口（薄 bootstrap）：
 * 全部业务逻辑位于 src/feishu（公共层）与 src/adapters/pi（Pi 适配器）。
 * 这里只负责把自身入口路径传给适配器，供 daemon 以 -e 重新加载。
 */
import { fileURLToPath } from "node:url";
import createPiFeishuExtension from "../../../src/adapters/pi/index.ts";

export default function feishuExtension(pi: any) {
  return createPiFeishuExtension(pi, { extensionPath: fileURLToPath(import.meta.url) });
}
