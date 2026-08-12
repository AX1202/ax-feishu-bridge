# pi-feishu-lark

把 Pi 接入飞书/Lark 的消息桥接扩展：在熟悉的聊天界面里与本机 Pi 持续协作。

<p align="center">
  <a href="#zh">中文</a> · <a href="#en">English</a>
</p>

<a id="zh"></a>

## 中文

Pi Agent飞书交流反馈群：<https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=57dvecbb-95d3-4d01-b689-6ebc3d17c867>

扩展有什么问题可以加群反馈。

## 我的媒体平台 关注我第一时间了解最新AI工具

全平台账号名称：AX阿煊

B站：<https://space.bilibili.com/4489397>


## 主要能力

- 通过扫码快速创建飞书/Lark 机器人，减少手动配置
- 支持私聊、群聊、群话题分别维护独立的 Pi 会话
- 支持群聊策略：
  - `open`：群里和话题里可直接回复，不需要 @，还需手动在飞书开发者后台开启机器人“**获取群组中所有消息”的权限**
  - `mention`：只有 `@` 机器人、命中关键词或回复机器人消息时才会回复（后两项可选开启）
- 支持图片、代码文件和文本文件等附件输入；图片识别取决于当前模型是否支持图片
- 支持解析飞书 interactive 告警卡片；回复一条消息或卡片时，可把原内容一并带给 Pi
- 支持群聊关键词触发、回复机器人消息继续追问
- 支持在飞书内切换当前会话的模型、工作区、历史会话和思考强度
- 收到消息后立即显示“正在回复…”，后续答案在同一张卡片中流式输出；可停止，并会显示完成或失败状态
- 支持渲染显示 Markdown 格式内容
- Pi agent 关闭后，仍有后台常驻服务可以对话，pi agent无需前台运行。

<br />

***



## 快速开始

### 1. 安装

```bash
pi install npm:pi-feishu-lark
```

也可以从 Git 安装：

```bash
pi install git:github.com/AX1202/pi-feishu-lark
```

### 2. 初始化配置

在 Pi 里运行：

```bash
/feishu setup
```

推荐选择“扫码自动创建飞书助手”，按提示扫描终端里的二维码即可。

如果你已经有现成的飞书/Lark 应用，也可以选择手动填写 App ID 和 App Secret。

### 3. 启动桥接

```bash
/feishu start
```

如果开启了自动启动，Pi 会话启动时会自动连上飞书/Lark。

### 4. 开始聊天

在飞书/Lark 里打开机器人，直接发消息即可。

- 私聊：直接发消息
- 群聊：根据群聊策略决定是否需要 `@` 机器人
- 话题：每个话题会独立对应一个 Pi 会话

---

# Windows 上运行 Pi Agent 飞书插件配置方法

## 解决方法

### 1. 先安装 Git for Windows

安装后一般会有这个文件：

```text
C:\Program Files\Git\bin\bash.exe
```

这个就是 Windows 上给 Pi 使用的 Bash 环境。

---

### 2. 配置 Pi 的 settings.json

打开：

```text
C:\Users\你的用户名\.pi\agent\settings.json
```

在大括号里加这一行：

```json
"shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
```

注意：如果你原来文件里还有其他配置，不要删掉，只加这一行即可。

这个配置主要是告诉 **Pi 主程序** 使用哪个 Bash。

---

### 3. 把 Git Bash 加到 Windows PATH

有些插件会直接调用：

```text
bash
```

它不一定读取 Pi 的 `shellPath` 配置，所以还需要把 Git Bash 加到系统 PATH。

在 PowerShell 里执行：

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\Program Files\Git\bin",
  "User"
)
```

---

### 4. 重启 PowerShell

执行完上面的命令后，要关闭 PowerShell，再重新打开。

然后验证：

```powershell
where.exe bash
```

如果输出：

```text
C:\Program Files\Git\bin\bash.exe
```

说明修复成功。

---

### 5. 再运行 Pi

```powershell
pi
```

---

## 总结

最稳的配置是两个都做：

```text
settings.json 配置 shellPath
+
Windows PATH 加入 C:\Program Files\Git\bin
```

前者给 Pi 主程序用，后者给插件或子进程直接调用 `bash` 用。




***

## 飞书里怎么用

发送给机器人的常用命令：

| 命令       | 作用                   |
| -------- | -------------------- |
| `/new`   | 为当前会话新建一个 Pi 会话      |
| `/resume` | 打开当前工作区的历史会话列表；可在卡片中切到全部会话 |
| `/model` | 打开模型选择卡片，切换当前会话使用的模型 |
| `/thinking` | 打开思考强度选择卡片，切换当前模型实际支持的档位 |
| `/stop`  | 停止当前这条回复的处理          |
| `/workspace` | 查看当前会话绑定的工作区      |
| `/workspace /path/to/project` | 把当前会话切换到指定工作区，下一条消息生效 |
| `/status` | 查看当前会话的工作状态、模型、思考强度和上下文占用 |
| `/commands` | 查看机器人支持的全部命令 |
| `/config` | 查看运行时配置（仅限与机器人的私聊） |
| `/config groupKeywords 关键词1,关键词2` | 设置群聊关键词触发并立即生效 |
| `/config streamingReply false` | 关闭流式展示，改用普通回复卡片 |
| `/config clear groupKeywords` | 清除某项运行时配置覆盖 |

***

## Pi 里怎么管理

| 命令                  | 作用                  |
| ------------------- | ------------------- |
| `/feishu setup`     | 打开初始化配置             |
| `/feishu start`     | 启动飞书桥接              |
| `/feishu stop`      | 停止飞书桥接              |
| `/feishu restart`   | 重启桥接，并重新加载最新代码和配置   |
| `/feishu status`    | 查看连接状态、当前 owner 和配置 |
| `/feishu autostart` | 开关自动启动              |
| `/feishu debug`     | 查看最近 20 条调试日志       |
| `/feishu reset`     | 清除配置和映射，但保留会话历史     |

***

## 配置

配置默认保存在：

```text
~/.pi/agent/feishu/config.json
```

也可以通过环境变量配置：

| 变量                    | 说明                            |
| --------------------- | ----------------------------- |
| `FEISHU_APP_ID`       | 飞书/Lark 应用 ID                 |
| `FEISHU_APP_SECRET`   | 飞书/Lark 应用密钥                  |
| `FEISHU_DOMAIN`       | `feishu` 或 `lark`，默认 `feishu` |
| `FEISHU_GROUP_POLICY` | `open` 或 `mention`，默认 `open`  |
| `FEISHU_GROUP_KEYWORDS` | 群聊关键词，逗号或分号分隔；命中后无需 @ |
| `FEISHU_GROUP_ALSO_ON_REPLY` | `1` 时回复机器人消息可继续追问，无需再次 @ |
| `FEISHU_IGNORE_BOT_MESSAGES` | 是否忽略其他机器人消息，默认 `true` |
| `FEISHU_LANGUAGE`     | `zh` 或 `en`                   |
| `FEISHU_REACT_EMOJI`  | 收到消息时的表情回应，默认 `Get`      |
| `FEISHU_AUTO_START`   | `1` 或 `0`                     |
| `FEISHU_CARD_ACTION_MODE` | `webhook` 或 `ws`，默认 `webhook` |
| `FEISHU_CARD_ACTION_WEBHOOK_HOST` | 卡片回调监听地址，默认 `0.0.0.0` |
| `FEISHU_CARD_ACTION_WEBHOOK_PORT` | 卡片回调端口，默认 `3001` |
| `FEISHU_CARD_ACTION_WEBHOOK_PATH` | 卡片回调路径，默认 `/webhook/card` |
| `FEISHU_PROMPT_NOTIFY_SEC` | 长任务超过多少秒后在飞书发一条“仍在处理中”提示，默认 `180`，`0` 关闭 |
| `FEISHU_PROMPT_TIMEOUT_SEC` | 任务硬超时秒数，超时后中止任务并报失败，默认 `0`（不设硬超时，长期运行也不会被报失败） |
| `FEISHU_PARSE_INTERACTIVE_CARDS` | 是否把 interactive 卡片转为 Pi 可读文字，默认 `true` |
| `FEISHU_INCLUDE_QUOTED_MESSAGE` | 回复/引用消息时是否带入原消息内容，默认 `true` |
| `FEISHU_QUOTED_MESSAGE_MAX_CHARS` | 引用消息最多带入的字符数，默认 `8000` |
| `FEISHU_SEND_MAX_RETRIES` | 飞书接口临时失败时的重试次数，默认 `2` |
| `FEISHU_STREAMING_REPLY` | 是否启用 CardKit 单卡流式回复，默认 `true` |
| `FEISHU_STREAM_PRINT_FREQUENCY_MS` | 流式逐字显示的刷新间隔，默认 `50` |
| `FEISHU_STREAM_PRINT_STEP` | 每次显示的字符数，默认 `1` |
| `FEISHU_STREAM_PUSH_INTERVAL_MS` | 向飞书推送最新正文的间隔，默认 `120` 毫秒 |
| `FEISHU_EXT_DEV`      | `1` 时显示本地开发标识 `DEV`           |

### config.json 字段

除了上面的环境变量，也可以在 `config.json` 里设置（优先级：环境变量 > config.json > 默认值）：

| 字段                   | 说明                            |
| --------------------- | ----------------------------- |
| `promptNotifySec`     | 长任务超过多少秒后在飞书发一条“仍在处理中”提示，默认 `180`，`0` 关闭 |
| `promptTimeoutSec`    | 任务硬超时秒数，超时后中止任务并报失败，默认 `0`（不设硬超时，长期运行也不会被报失败） |

> 注意：长时间任务（例如跑测试、构建、批量处理）默认**不会**再被报为“任务失败”——到达 `promptNotifySec` 后只会在飞书里提示“任务仍在处理中”，回复卡片保持“回复中”，完成后正常送达结果。只有显式设置 `promptTimeoutSec` 后才会硬超时。修改后请执行 `/feishu restart` 生效。

### 运行时配置

以下桥接设置可以在**与机器人的私聊**里用 `/config` 立即修改，无需重启，并保存到 `~/.pi/agent/feishu/runtime-overrides.json`：

```text
/config
/config groupKeywords 报警,告警
/config groupAlsoOnReply true
/config streamingReply false
/config clear groupKeywords
/config clear all
```

可热更新的范围仅包括 `groupPolicy`、`groupKeywords`、`groupAlsoOnReply`、`ignoreBotMessages`、`reactEmoji`、`language` 以及流式展示参数；应用凭证、引用消息展开和连接方式不能通过聊天修改。

***

## 会保存哪些文件

| 路径                               | 内容                |
| -------------------------------- | ----------------- |
| `~/.pi/agent/feishu/config.json` | 机器人凭证和基础配置        |
| `~/.pi/agent/feishu/runtime-overrides.json` | 通过私聊 `/config` 保存的运行时配置覆盖 |
| `~/.pi/agent/feishu/state.json`  | 飞书会话和 Pi 会话的映射    |
| `~/.pi/agent/feishu/bridge.json` | 从飞书发起的 Pi 任务路由信息  |
| `~/.pi/agent/feishu/debug.log`   | 调试日志              |
| `~/.pi/agent/locks.json`         | 当前飞书连接的 owner 锁   |
| `~/.pi/agent/sessions/`          | 每个飞书会话对应的 Pi 会话文件 |

***

## 常见说明

- 图片能不能被识别，取决于当前选中的模型是否支持图片输入。
- 图片、文本/代码文件输入是已有能力；interactive 卡片解析和回复消息上下文展开是新版补充的能力。
- 对一条消息或卡片点“回复”后，Pi 会看到原消息内容和你的新问题；这不是把原消息再次发送到群里。
- `/feishu reset` 只会清掉配置和映射，不会删除会话历史。
- 从 TUI、CLI 或其他渠道创建的任务，不会主动发到飞书。
- `/workspace` 当前只支持绝对路径，或 `~/` 开头的路径。
- `/resume` 默认先显示当前项目的最近历史会话，也可以在卡片里切到“全部会话”并翻页浏览。
- 卡片按钮现在优先走 webhook 回包模式；如果你还想临时沿用旧的 WS 更新方式，可以把 `FEISHU_CARD_ACTION_MODE` 设成 `ws`。
- 卡片回调默认监听 `0.0.0.0:3001/webhook/card`，需要在飞书开发者后台把交互卡片回调地址指到一个外部可访问的 URL。

***

## 常见问题

### 为什么机器人没回复？

先看三件事：

- 飞书机器人是否已经创建并配置好
- `/feishu start` 是否已经运行
- 群聊策略是否要求 `@` 机器人

### 为什么我在群里发了消息，机器人没有理我？

如果你把群聊策略设成了 `mention`，就需要 `@` 机器人后它才会回复。\
`open`模式下：群里和话题里可直接回复，不需要 @，但还需手动在飞书开发者后台开启机器人“获取群组中所有消息”权限才能生效。

### 还没有实现后台服务开机自启动功能，目前需要电脑开机后手动启动一次 Pi agent 才能正常工作。启动后，Pi agent 无需前台运行，关闭后，仍可以在飞书/Lark 里对话。

<a id="en"></a>

## English

Pi-feishu-lark is a bridge between Pi and Feishu/Lark for chat-based workflows.

### Highlights

- Create a Feishu/Lark bot quickly with QR-code setup
- Keep separate Pi sessions for DMs, group chats, and group topics
- Support images and text/code file inputs; image understanding depends on the selected model
- Parse interactive cards and expand the message you reply to as Pi context
- Switch models and available thinking levels inside Feishu/Lark
- Show an immediate “Replying…” card, then stream the answer on that same card
- Render Markdown replies
- Keep Pi running in the background after the agent UI is closed

### What's New

- A reply card appears as soon as the bot receives your message, so a slow answer is visibly in progress.
- `/thinking` opens a picker containing only the thinking levels reported by the current Pi session.
- Reply to a message or an alert card and Pi receives both the original content and your follow-up.
- Configure group triggers and streaming behavior in a private chat with `/config`.

### Quick Start

1. Install:

```bash
pi install npm:pi-feishu-lark
```

1. Set up:

```bash
/feishu setup
```

1. Start the bridge:

```bash
/feishu start
```

1. Chat in Feishu/Lark.

### Common Commands

| Command  | Meaning                                     |
| -------- | ------------------------------------------- |
| `/new`   | Start a new Pi session for the current chat |
| `/resume` | Open past sessions and switch back to one |
| `/model` | Open the model picker                       |
| `/thinking` | Open the thinking-level picker for the current session |
| `/workspace [path]` | View or switch the current workspace |
| `/status` | View reply status, model, thinking level, and context usage |
| `/config` | View or update allowed runtime settings in a direct message |
| `/stop`  | Stop the current reply generation           |

### Config

| Variable              | Meaning                |
| --------------------- | ---------------------- |
| `FEISHU_APP_ID`       | Feishu/Lark app ID     |
| `FEISHU_APP_SECRET`   | Feishu/Lark app secret |
| `FEISHU_DOMAIN`       | `feishu` or `lark`     |
| `FEISHU_GROUP_POLICY` | `open` or `mention`    |
| `FEISHU_LANGUAGE`     | `zh` or `en`           |
| `FEISHU_REACT_EMOJI`  | Reaction emoji         |
| `FEISHU_AUTO_START`   | `1` or `0`             |
| `FEISHU_CARD_ACTION_MODE` | `webhook` or `ws`, default `webhook` |
| `FEISHU_CARD_ACTION_WEBHOOK_HOST` | Card callback listen host, default `0.0.0.0` |
| `FEISHU_CARD_ACTION_WEBHOOK_PORT` | Card callback port, default `3001` |
| `FEISHU_CARD_ACTION_WEBHOOK_PATH` | Card callback path, default `/webhook/card` |

### Notes

- Image understanding depends on the selected model.
- `/feishu reset` clears config and mappings, but keeps session history.
- Tasks created from TUI, CLI, or other channels will not be pushed to Feishu automatically.
- Card buttons now prefer webhook responses. If you want to keep the older WS patch flow temporarily, set `FEISHU_CARD_ACTION_MODE=ws`.
- The card callback listens on `0.0.0.0:3001/webhook/card` by default, so Feishu must be pointed at a publicly reachable URL for interactive card buttons.
