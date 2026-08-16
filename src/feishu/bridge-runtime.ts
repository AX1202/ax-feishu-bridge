import { FeishuBridgeStore } from "./bridge-store.ts";
import { FeishuDelivery } from "./delivery.ts";
import { debugLog } from "./debug.ts";

/**
 * 桥接输入事件（平台无关）：
 * 由各 Runtime 适配器把自身会话事件解析成这些标准化事件后调用 handleJobEvent。
 * "job" 指飞书侧记录的一个可回传结果（例如 Pi 内部定时任务），
 * 对应关系由 FeishuBridgeStore 持久化。
 */
export type BridgeJobEvent =
  /** Runtime 会话里创建了一批可回传任务（仅飞书发起的输入会绑定）。 */
  | { kind: "created"; sessionId: string; sessionKey: string | undefined; jobs: Array<{ id: string; name?: string }> }
  /** 一个任务开始执行，等待该会话下一条 assistant 输出作为结果。 */
  | { kind: "marker"; sessionId: string; jobId: string }
  /** 任务直接产出最终结果（如子代理完成）。 */
  | { kind: "done"; sessionId: string; jobId: string; text: string; dedupeKey: string }
  /** 任务执行失败。 */
  | { kind: "error"; sessionId: string; jobId: string; error: string; dedupeKey: string }
  /** 一条 assistant 文本；若该会话有等待中的任务，按顺序匹配队首。 */
  | { kind: "output"; sessionId: string; text: string; messageId?: string; timestamp?: string };

export class FeishuBridgeRuntime {
  private readonly pendingBySession = new Map<string, string[]>();
  private readonly activeFeishuInputs = new Set<string>();
  private readonly store: FeishuBridgeStore;
  private readonly delivery: FeishuDelivery;

  constructor(
    store: FeishuBridgeStore,
    delivery: FeishuDelivery,
  ) {
    this.store = store;
    this.delivery = delivery;
  }

  attachSession(sessionKey: string, sessionId: string) {
    this.store.attachSession(sessionKey, sessionId);
  }

  beginFeishuInput(sessionId: string) {
    this.activeFeishuInputs.add(sessionId);
  }

  endFeishuInput(sessionId: string) {
    this.activeFeishuInputs.delete(sessionId);
  }

  /** Runtime 适配器把自身事件标准化后调用。 */
  handleJobEvent(event: BridgeJobEvent) {
    switch (event.kind) {
      case "created":
        this.captureCreatedJobs(event);
        return;
      case "marker":
        void this.handleScheduledMarker(event);
        return;
      case "done":
        void this.deliverJobResult(event.jobId, event.text, event.dedupeKey);
        return;
      case "error":
        void this.deliverJobResult(event.jobId, `定时任务执行失败：${event.error}`, event.dedupeKey);
        return;
      case "output":
        void this.handleAssistantOutput(event);
        return;
    }
  }

  private captureCreatedJobs(event: Extract<BridgeJobEvent, { kind: "created" }>) {
    const { sessionId, sessionKey, jobs } = event;
    if (!sessionKey || !this.activeFeishuInputs.has(sessionId)) return;
    for (const job of jobs) {
      this.store.bindJob(sessionKey, job.id, job.name, sessionId);
      debugLog("feishu.bridge.job_bound", { sessionKey, sessionId, jobId: job.id, jobName: job.name });
    }
  }

  private async handleScheduledMarker(event: Extract<BridgeJobEvent, { kind: "marker" }>) {
    const { sessionId, jobId } = event;
    const route = this.store.getJob(jobId);
    if (!route) return;
    const pending = this.pendingBySession.get(sessionId) || [];
    pending.push(jobId);
    this.pendingBySession.set(sessionId, pending);
    debugLog("feishu.bridge.scheduled_started", { sessionId, jobId });
  }

  private async handleAssistantOutput(event: Extract<BridgeJobEvent, { kind: "output" }>) {
    const pending = this.pendingBySession.get(event.sessionId);
    const nextJobId = pending?.[0];
    if (!nextJobId) return;

    const route = this.store.getJob(nextJobId);
    if (!route) {
      pending?.shift();
      if (!pending?.length) this.pendingBySession.delete(event.sessionId);
      return;
    }

    const text = event.text;
    if (!text) return;
    const deliveryKey = `assistant:${nextJobId}:${event.messageId || event.timestamp || text}`;
    await this.deliverOnce(deliveryKey, route, text);
    pending?.shift();
    if (!pending?.length) this.pendingBySession.delete(event.sessionId);
  }

  private async deliverJobResult(jobId: string, text: string, dedupeKey: string) {
    const route = this.store.getJob(jobId);
    if (!route) return;
    await this.deliverOnce(dedupeKey, route, text);
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
