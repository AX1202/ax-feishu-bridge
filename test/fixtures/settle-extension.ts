import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function settleExtension(pi: ExtensionAPI) {
  pi.registerCommand("wait-for-extension-settle", {
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  });
}
