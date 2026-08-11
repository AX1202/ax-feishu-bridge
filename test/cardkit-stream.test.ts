import test from "node:test";
import assert from "node:assert/strict";
import { CardKitStream } from "../.pi/extensions/feishu/cardkit-stream.ts";

test("CardKit creates a reply-in-progress card before the first text delta", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }));
    }
    if (url.endsWith("/cardkit/v1/cards")) {
      return new Response(JSON.stringify({ code: 0, data: { card_id: "card-1" } }));
    }
    if (url.endsWith("/messages/incoming-1/reply")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: "outgoing-1" } }));
    }
    if (url.endsWith("/card-1/settings")) {
      return new Response(JSON.stringify({ code: 0 }));
    }
    if (url.endsWith("/cardkit/v1/cards/card-1")) {
      return new Response(JSON.stringify({ code: 0 }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const stream = new CardKitStream(
      "app-id",
      "app-secret",
      "feishu",
      "incoming-1",
      async () => {},
      { conversationKey: "p2p:user", runId: "run-1" },
    );

    await stream.startImmediately();

    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /tenant_access_token\/internal$/);
    assert.match(calls[1].url, /cardkit\/v1\/cards$/);
    assert.match(calls[2].url, /messages\/incoming-1\/reply$/);

    const createPayload = JSON.parse(String(calls[1].init?.body));
    const waitingCard = JSON.parse(createPayload.data);
    assert.equal(waitingCard.header.title.content, "回复中");
    assert.equal(waitingCard.body.elements[0].content, "正在回复…");

    await stream.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
