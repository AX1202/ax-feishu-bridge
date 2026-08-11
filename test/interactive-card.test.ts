import test from "node:test";
import assert from "node:assert/strict";
import { extractTextFromInteractiveCard, extractTextFromMsgType } from "../.pi/extensions/feishu/interactive-card.ts";
import { parseMessageInput, buildPromptWithQuote } from "../.pi/extensions/feishu/messages.ts";

test("extracts header and div/markdown from schema 1.0 card", () => {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "P1 Alert" },
      subtitle: { tag: "plain_text", content: "prod" },
    },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: "rule: high_cpu" } },
      { tag: "markdown", content: "**traceId**: abc-123" },
      { tag: "note", elements: [{ tag: "plain_text", content: "region=cn-hangzhou" }] },
    ],
  };
  const { text } = extractTextFromInteractiveCard(JSON.stringify(card));
  assert.match(text, /P1 Alert/);
  assert.match(text, /high_cpu/);
  assert.match(text, /abc-123/);
  assert.match(text, /cn-hangzhou/);
});

test("extracts schema 2.0 body.elements", () => {
  const card = {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "Deploy failed" } },
    body: {
      elements: [{ tag: "markdown", content: "service: payments\nerror: timeout" }],
    },
  };
  const { text } = extractTextFromInteractiveCard(JSON.stringify(card));
  assert.match(text, /Deploy failed/);
  assert.match(text, /payments/);
});

test("parseMessageInput handles interactive", () => {
  const content = JSON.stringify({
    header: { title: { tag: "plain_text", content: "Card Title" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: "body line" } }],
  });
  const parsed = parseMessageInput(
    {
      messageId: "m1",
      chatId: "c1",
      chatType: "group",
      senderOpenId: "u1",
      msgType: "interactive",
      content,
    },
    undefined,
    { parseInteractiveCards: true },
  );
  assert.match(parsed.text, /Card Title/);
  assert.match(parsed.text, /body line/);
  assert.equal(parsed.source, "interactive");
});

test("buildPromptWithQuote merges parent card", () => {
  const prompt = buildPromptWithQuote("help investigate", {
    msgType: "interactive",
    text: "P1 Alert\ntraceId: x",
  });
  assert.match(prompt, /Quoted message/);
  assert.match(prompt, /traceId: x/);
  assert.match(prompt, /help investigate/);
});

test("extractTextFromMsgType text strips bot mention", () => {
  const r = extractTextFromMsgType("text", JSON.stringify({ text: "@ou_bot please check" }), "ou_bot");
  assert.equal(r.text, "please check");
});

