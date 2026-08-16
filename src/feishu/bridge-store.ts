import { BRIDGE_PATH, readJson, writeJson } from "./config.js";
import type { FeishuBridgeState, FeishuJobRoute, FeishuMessage, FeishuRoute } from "./types.js";

const DEFAULT_STATE: FeishuBridgeState = { version: 1, routes: {}, jobs: {}, sent: {} };

export class FeishuBridgeStore {
  bindConversation(sessionKey: string, msg: FeishuMessage, sessionId?: string) {
    const state = this.read();
    const previous = state.routes[sessionKey];
    const route: FeishuRoute = {
      sessionKey,
      sessionId: sessionId || previous?.sessionId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadMessageId: routeThreadMessageId(msg, previous),
      lastMessageId: msg.messageId,
      updatedAt: Date.now(),
    };
    state.routes[sessionKey] = route;
    this.write(state);
    return route;
  }

  attachSession(sessionKey: string, sessionId: string) {
    const state = this.read();
    const route = state.routes[sessionKey];
    if (!route || route.sessionId === sessionId) return;
    state.routes[sessionKey] = { ...route, sessionId, updatedAt: Date.now() };
    this.write(state);
  }

  getRoute(sessionKey: string): FeishuRoute | undefined {
    return this.read().routes[sessionKey];
  }

  bindJob(sessionKey: string, jobId: string, jobName?: string, sessionId?: string): FeishuJobRoute | undefined {
    const state = this.read();
    const route = state.routes[sessionKey];
    if (!route) return undefined;
    const jobRoute: FeishuJobRoute = {
      ...route,
      sessionId: sessionId || route.sessionId,
      jobId,
      jobName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.jobs[jobId] = jobRoute;
    this.write(state);
    return jobRoute;
  }

  getJob(jobId: string): FeishuJobRoute | undefined {
    return this.read().jobs[jobId];
  }

  markSent(deliveryKey: string) {
    const state = this.read();
    state.sent[deliveryKey] = Date.now();
    this.write(state);
  }

  hasSent(deliveryKey: string) {
    return Boolean(this.read().sent[deliveryKey]);
  }

  private read(): FeishuBridgeState {
    const raw = readJson<FeishuBridgeState>(BRIDGE_PATH, DEFAULT_STATE);
    return {
      version: 1,
      routes: { ...(raw.routes || {}) },
      jobs: { ...(raw.jobs || {}) },
      sent: { ...(raw.sent || {}) },
    };
  }

  private write(state: FeishuBridgeState) {
    writeJson(BRIDGE_PATH, state);
  }
}

function routeThreadMessageId(msg: FeishuMessage, previous?: FeishuRoute) {
  if (msg.rootId || msg.parentId) return msg.rootId || msg.parentId;
  if (previous?.threadMessageId) return previous.threadMessageId;
  if (msg.threadId || msg.chatMode === "topic") return msg.messageId;
  return undefined;
}
