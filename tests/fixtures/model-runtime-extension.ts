import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConversationManager } from "../../.pi/extensions/feishu/conversation-manager.js";

export default async function modelRuntimeExtension(pi: ExtensionAPI) {
  const conversations = new ConversationManager(process.cwd());
  await conversations.getAvailableModels();
  await conversations.getSelectedModel("model-runtime-probe");
  conversations.resetMemory();

  pi.registerCommand("verify-feishu-model-runtime", {
    handler: async () => undefined,
  });
}
