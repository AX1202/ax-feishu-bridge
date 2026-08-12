import test from "node:test";
import assert from "node:assert/strict";
import { buildResumeCard } from "../.pi/extensions/feishu/cards.ts";

function resumeCard(scope: "current" | "all" = "current") {
  return buildResumeCard({
    key: "p2p:user",
    workspacePath: "/Users/ax/Dev/projects/pi-feishu-lark",
    scope,
    page: 0,
    total: 1,
    totalPages: 1,
    items: [{
      path: "/tmp/session.jsonl",
      title: "测试会话",
      subtitle: "第一条消息",
      modifiedLabel: "刚刚",
      isCurrent: true,
    }],
  }) as any;
}

test("resume card identifies the current workspace by its full path", () => {
  const card = resumeCard();
  const intro = card.elements[0].content;

  assert.match(intro, /当前工作区：\*\*\/Users\/ax\/Dev\/projects\/pi-feishu-lark\*\*/);
  assert.doesNotMatch(intro, /当前视图|当前项目/);
});

test("resume scope selector says current workspace instead of current project", () => {
  const card = resumeCard();
  const actions = card.elements.find((element: any) => element.tag === "action").actions;

  assert.deepEqual(actions.map((action: any) => action.text.content), ["当前工作区", "全部会话"]);
  assert.equal(actions[0].type, "primary");
  assert.equal(actions[1].type, "default");
});

test("all-sessions view still makes the current workspace visible", () => {
  const card = resumeCard("all");
  const intro = card.elements[0].content;
  const actions = card.elements.find((element: any) => element.tag === "action").actions;

  assert.match(intro, /当前工作区：\*\*\/Users\/ax\/Dev\/projects\/pi-feishu-lark\*\*/);
  assert.equal(actions[0].type, "default");
  assert.equal(actions[1].type, "primary");
});
