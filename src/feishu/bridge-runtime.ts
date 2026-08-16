import { FeishuBridgeStore } from "./bridge-store.js";
import { FeishuDelivery } from "./delivery.js";
import { debugLog } from "./debug.js";

type PendingScheduledResult = {
  jobId: string;
  markerId?: string;
};

export class FeishuBridgeRuntime {
  private readonly pendingBySession = new Map<string, PendingScheduledResult[]>();
  private readonly activeFeishuInputs = new Set<string>();

  constructor(
    private readonly store: FeishuBridgeStore,
    private readonly delivery: FeishuDelivery,
  ) {}

  attachSession(sessionKey: string, sessionId: string) {
    this.store.attachSession(sessionKey, sessionId);
  }

  beginFeishuInput(sessionId: string) {
    this.activeFeishuInputs.add(sessionId);
  }

  endFeishuInput(sessionId: string) {
    this.activeFeishuInputs.delete(sessionId);
  }

  handleMessageEnd(sessionId: string | undefined, sessionKey: string | undefined, message: any) {
    if (!sessionId || !message) return;

    if (message.role === "toolResult" && message.toolName === "schedule_prompt") {
      this.captureCreatedJobs(sessionId, sessionKey, message);
      return;
    }

    if (message.role === "custom" && message.customType === "scheduled_prompt") {
      void this.handleScheduledMarker(sessionId, message);
      return;
    }

    if (message.role === "assistant") {
      void this.handleAssistantResult(sessionId, message);
    }
  }

  private captureCreatedJobs(sessionId: string, sessionKey: string | undefined, message: any) {
    if (!sessionKey || !this.activeFeishuInputs.has(sessionId)) return;
    const details = message.details || {};
    if (details.action !== "add") return;

    const jobs = Array.isArray(details.jobs) ? details.jobs : [];
    for (const job of jobs) {
      if (!job?.id) continue;
      this.store.bindJob(sessionKey, String(job.id), typeof job.name === "string" ? job.name : undefined, sessionId);
      debugLog("feishu.bridge.job_bound", { sessionKey, sessionId, jobId: job.id, jobName: job.name });
    }
  }

  private async handleScheduledMarker(sessionId: string, message: any) {
    const details = message.details || {};
    const jobId = typeof details.jobId === "string" ? details.jobId : "";
    if (!jobId) return;
    const route = this.store.getJob(jobId);
    if (!route) return;

    if (details.mode === "subagent_done" && typeof details.output === "string") {
      await this.deliverOnce(`subagent_done:${jobId}:${message.id || details.output}`, route, details.output);
      return;
    }

    if (details.mode === "subagent_error" && typeof details.error === "string") {
      await this.deliverOnce(`subagent_error:${jobId}:${message.id || details.error}`, route, `定时任务执行失败：${details.error}`);
      return;
    }

    const pending = this.pendingBySession.get(sessionId) || [];
    pending.push({ jobId, markerId: message.id });
    this.pendingBySession.set(sessionId, pending);
    debugLog("feishu.bridge.scheduled_started", { sessionId, jobId, jobName: details.jobName });
  }

  private async handleAssistantResult(sessionId: string, message: any) {
    const pending = this.pendingBySession.get(sessionId);
    const next = pending?.[0];
    if (!next) return;

    const route = this.store.getJob(next.jobId);
    if (!route) {
      pending?.shift();
      if (!pending?.length) this.pendingBySession.delete(sessionId);
      return;
    }

    const text = extractText(message);
    if (!text) return;
    const deliveryKey = `assistant:${next.jobId}:${message.id || message.timestamp || text}`;
    await this.deliverOnce(deliveryKey, route, text);
    pending?.shift();
    if (!pending?.length) this.pendingBySession.delete(sessionId);
  }

  private async deliverOnce(deliveryKey: string, route: any, text: string) {
    if (this.store.hasSent(deliveryKey)) return;
    try {
      await this.delivery.send(route, text);
      this.store.markSent(deliveryKey);
      debugLog("feishu.bridge.delivered", { deliveryKey, jobId: route.jobId, sessionKey: route.sessionKey });
    } catch (error) {
      debugLog("feishu.bridge.deliver_failed", {
        deliveryKey,
        jobId: route.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function extractText(message: any) {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.type === "text" ? part.text : "")
    .join("")
    .trim();
}
