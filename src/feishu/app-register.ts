/**
 * 扫码注册飞书/Lark 机器人应用（平台无关，Pi 与 Harness 共用）。
 * 二维码打印到终端；提示信息通过 onNotify 回调交给调用方（Pi 用 TUI 通知，Harness 用终端输出）。
 */
import qrcode from "qrcode-terminal";
import type { Domain } from "./types.ts";

export type RegisteredFeishuApp = {
  appId: string;
  appSecret: string;
  domain: Domain;
};

export async function registerFeishuApp(options?: { onNotify?: (text: string) => void }): Promise<RegisteredFeishuApp> {
  const lark = await import("@larksuiteoapi/node-sdk");
  const notify = options?.onNotify ?? ((text: string) => console.log(text));
  notify("正在准备飞书授权二维码... / Preparing Feishu authorization QR code...");

  const result = await lark.registerApp({
    source: "pi-feishu-extension",
    onQRCodeReady(info: { url: string; expireIn: number }) {
      qrcode.generate(info.url, { small: true }, (qr) => {
        console.log("\n飞书/Lark 授权二维码 / Feishu/Lark authorization QR code");
        console.log(qr);
        console.log(info.url);
        console.log(`二维码 ${info.expireIn} 秒后过期 / QR code expires in ${info.expireIn} seconds.`);
      });
      notify("请在终端扫描二维码，或打开终端中显示的链接。 / Scan the QR code in terminal, or open the link printed there.");
    },
    onStatusChange(info: any) {
      if (info?.status === "domain_switched") {
        notify("检测到 Lark 租户，正在切换区域。 / Detected Lark tenant; switching domain.");
      }
    },
  });

  const domain: Domain = result?.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    domain,
  };
}
