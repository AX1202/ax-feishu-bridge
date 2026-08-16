import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiConversationRuntime } from "../../src/adapters/pi/PiConversationRuntime.js";

export default async function modelRuntimeExtension(pi: ExtensionAPI) {
  const conversations = new PiConversationRuntime(process.cwd());
  const provider = "fixture-provider";
  const modelId = "target-model";
  const models = await conversations.getAvailableModels();
  if (!models.some((model: any) => model.provider === provider && model.id === modelId)) {
    throw new Error("Fixture model was not available to the Feishu bridge.");
  }

  const defaultModel = await conversations.getSelectedModel("model-runtime-default-probe");
  if (defaultModel?.provider !== provider || defaultModel?.id !== modelId) {
    throw new Error("Feishu bridge rejected the configured default model.");
  }

  let selectionReply = "";
  await conversations.selectModel("model-runtime-selection-probe", provider, modelId, async (reply) => {
    selectionReply = reply;
  });
  if (!selectionReply.includes(`已切换到 ${provider}/${modelId}`)) {
    throw new Error(`Feishu bridge rejected a listed model: ${selectionReply}`);
  }

  const selectedModel = await conversations.getSelectedModel("model-runtime-selection-probe");
  if (selectedModel?.provider !== provider || selectedModel?.id !== modelId) {
    throw new Error("Feishu bridge did not retain the selected model.");
  }
  conversations.resetMemory();

  pi.registerCommand("verify-feishu-model-runtime", {
    handler: async () => undefined,
  });
}
