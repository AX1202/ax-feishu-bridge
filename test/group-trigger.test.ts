import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPlainTextForTrigger,
  parseGroupKeywords,
  shouldAcceptGroupMessage,
  textMatchesKeywords,
} from "../.pi/extensions/feishu/group-trigger.ts";

test("parseGroupKeywords splits comma/semicolon and trims", () => {
  assert.deepEqual(parseGroupKeywords("志胜, zhisheng; ZS"), ["志胜", "zhisheng", "ZS"]);
  assert.deepEqual(parseGroupKeywords(["  a ", "", "b"]), ["a", "b"]);
  assert.deepEqual(parseGroupKeywords(undefined), []);
  assert.deepEqual(parseGroupKeywords(""), []);
});

test("textMatchesKeywords is case-insensitive substring after whitespace normalize", () => {
  assert.equal(textMatchesKeywords("你好 志胜 在吗", ["志胜"]), true);
  assert.equal(textMatchesKeywords("Hey ZHISHENG please", ["zhisheng"]), true);
  assert.equal(textMatchesKeywords("hello world", ["志胜", "zs"]), false);
  assert.equal(textMatchesKeywords("  ", ["志胜"]), false);
  assert.equal(textMatchesKeywords("x", []), false);
});

test("extractPlainTextForTrigger reads text/post content", () => {
  assert.equal(
    extractPlainTextForTrigger("text", JSON.stringify({ text: "叫志胜一下" })),
    "叫志胜一下",
  );
  const post = JSON.stringify({
    zh_cn: {
      title: "标题",
      content: [[{ tag: "text", text: "正文" }]],
    },
  });
  assert.match(extractPlainTextForTrigger("post", post), /正文/);
});

test("extractPlainTextForTrigger reads interactive card text", () => {
  const card = JSON.stringify({
    header: { title: { tag: "plain_text", content: "告警通知" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: "志胜请处理这条告警" } },
    ],
  });
  const text = extractPlainTextForTrigger("interactive", card);
  assert.match(text, /志胜/);
  assert.match(text, /告警/);
});

test("mention policy: accept interactive when keyword in card body", () => {
  const card = JSON.stringify({
    elements: [{ tag: "div", text: { tag: "plain_text", content: "请志胜帮忙看下" } }],
  });
  const text = extractPlainTextForTrigger("interactive", card);
  const r = shouldAcceptGroupMessage({
    chatType: "group",
    groupPolicy: "mention",
    mentioned: false,
    text,
    keywords: ["志胜"],
    alsoOnReply: false,
    replyToBot: false,
  });
  assert.equal(r.accept, true);
  assert.equal(r.reason, "keyword");
});

test("mention policy: reject interactive without keyword/mention/reply", () => {
  const card = JSON.stringify({
    elements: [{ tag: "div", text: { tag: "plain_text", content: "普通卡片内容" } }],
  });
  const text = extractPlainTextForTrigger("interactive", card);
  const r = shouldAcceptGroupMessage({
    chatType: "group",
    groupPolicy: "mention",
    mentioned: false,
    text,
    keywords: ["志胜"],
    alsoOnReply: true,
    replyToBot: false,
  });
  assert.equal(r.accept, false);
  assert.equal(r.reason, "not_mentioned");
});

test("open policy always accepts group messages", () => {
  const r = shouldAcceptGroupMessage({
    chatType: "group",
    groupPolicy: "open",
    mentioned: false,
    text: "闲聊",
    keywords: ["志胜"],
    alsoOnReply: true,
    replyToBot: false,
  });
  assert.equal(r.accept, true);
  assert.equal(r.reason, "open");
});

test("p2p always accepts", () => {
  const r = shouldAcceptGroupMessage({
    chatType: "p2p",
    groupPolicy: "mention",
    mentioned: false,
    text: "hi",
    keywords: [],
    alsoOnReply: false,
    replyToBot: false,
  });
  assert.equal(r.accept, true);
  assert.equal(r.reason, "p2p");
});

test("mention policy: accept when mentioned", () => {
  const r = shouldAcceptGroupMessage({
    chatType: "group",
    groupPolicy: "mention",
    mentioned: true,
    text: "hello",
    keywords: [],
    alsoOnReply: false,
    replyToBot: false,
  });
  assert.equal(r.accept, true);
  assert.equal(r.reason, "mentioned");
});

test("mention policy: accept on keyword without mention", () => {
  const r = shouldAcceptGroupMessage({
    chatType: "group",
    groupPolicy: "mention",
    mentioned: false,
    text: "志胜帮我看下",
    keywords: ["志胜"],
    alsoOnReply: false,
    replyToBot: false,
  });
  assert.equal(r.accept, true);
  assert.equal(r.reason, "keyword");
});

test("mention policy: accept reply-to-bot when alsoOnReply", () => {
  const r = shouldAcceptGroupMessage({
    chatType: "group",
    groupPolicy: "mention",
    mentioned: false,
    text: "继续",
    keywords: [],
    alsoOnReply: true,
    replyToBot: true,
  });
  assert.equal(r.accept, true);
  assert.equal(r.reason, "reply_to_bot");
});

test("mention policy: ignore plain chat without mention/keyword/reply", () => {
  const r = shouldAcceptGroupMessage({
    chatType: "group",
    groupPolicy: "mention",
    mentioned: false,
    text: "大家中午吃啥",
    keywords: ["志胜"],
    alsoOnReply: true,
    replyToBot: false,
  });
  assert.equal(r.accept, false);
  assert.equal(r.reason, "not_mentioned");
});

test("mention policy: alsoOnReply false ignores reply-to-bot", () => {
  const r = shouldAcceptGroupMessage({
    chatType: "group",
    groupPolicy: "mention",
    mentioned: false,
    text: "继续",
    keywords: [],
    alsoOnReply: false,
    replyToBot: true,
  });
  assert.equal(r.accept, false);
  assert.equal(r.reason, "not_mentioned");
});

