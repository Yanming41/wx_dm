# wx_dm(信鸽)

微信 ClawBot(iLink 协议)纯传输层——只负责收发消息，不含任何起草/agent 逻辑。是一个常驻进程，跟外部程序之间靠两个文件通信，外部程序不需要知道任何微信/iLink 协议细节。

> A pure transport layer for the WeChat ClawBot (iLink protocol) — handles sending and receiving only, with no drafting/agent logic of its own. It runs as a persistent process and communicates with an external program through two files; the external program doesn't need to know anything about the WeChat/iLink protocol.

**这个仓库本身不会自动发送任何消息**——发什么内容、什么时候发，完全由外部程序决定，这个脚本只是把"写进 outbox.jsonl 的内容"原样转发出去。

> **This repository never sends anything on its own** — what gets sent, and when, is entirely decided by an external program. This script only forwards whatever is written into `outbox.jsonl`, verbatim.

## 启动

```bash
npm install
node wx_dm.mjs
```

无需额外环境变量。首次运行会弹出/保存二维码图片(`qrcode.png`)，需要用微信扫码绑定一个 bot 频道(**不是**登录你的微信主账号)。绑定后 `bot_token` 会存进 `.wechat_state.json`，之后重启不需要再扫码，除非这个文件被删了或 token 失效。

脚本要**一直挂着跑**才能收发消息，不是跑一次就退出的类型。

启动后会额外起一个本地操控台服务，浏览器打开 `http://127.0.0.1:17894` 能实时看到收发的消息。

> No extra environment variables needed. On first run it pops up / saves a QR code image (`qrcode.png`) — scan it with WeChat to bind a bot channel (this does **not** log into your main WeChat account). Once bound, the `bot_token` is persisted to `.wechat_state.json`, so you won't need to re-scan on restart unless that file is deleted or the token expires.
>
> The script needs to **keep running** to send/receive — it's not a run-once-and-exit tool.
>
> It also starts a local control-panel service — open `http://127.0.0.1:17894` in a browser to watch messages come in and go out in real time.

## 对外接口：两种，任选或都用

设计取舍(为什么两种都留着、怎么避免重复发送)见 [`docs/adr/0001-realtime-transport.md`](docs/adr/0001-realtime-transport.md)。

### 接口一：两个 jsonl 文件

都在脚本所在目录下，每行一个 JSON 对象([JSON Lines](https://jsonlines.org/) 格式)。

### `inbox.jsonl` —— 本脚本写，外部程序读

微信收到新消息时，本脚本会追加一行到这个文件末尾：

```json
{"id": "550e8400-...", "ts": 1755230000000, "from_user_id": "o9cq800kum_xxx@im.wechat", "text": "你好"}
```

| 字段 | 说明 |
|---|---|
| `id` | 这条消息的唯一 ID(uuid)，**回复时要用这个**，不是 `from_user_id` |
| `ts` | 收到时间，毫秒时间戳 |
| `from_user_id` | 微信那边的用户标识，外部程序不需要用到，纯记录 |
| `text` | 消息文本内容 |

外部程序消费方式：追加读取新行(比如记录自己上次读到第几行，或者用 `tail -f` 式监听)，**每条只处理一次**，本脚本不会做去重，重复处理是外部程序自己要注意的。

> 目前只处理文本消息。图片/语音/文件类型的消息会被静默跳过，不会出现在 inbox.jsonl 里。

### `outbox.jsonl` —— 外部程序写，本脚本读

外部程序想回复时，追加一行到这个文件：

```json
{"reply_to": "550e8400-...", "text": "这是要发出去的回复内容"}
```

| 字段 | 说明 |
|---|---|
| `reply_to` | 对应 `inbox.jsonl` 里那条消息的 `id`，本脚本靠这个查回该发给谁 |
| `text` | 要发送的文本内容 |

本脚本用 `fs.watch` 监听这个文件，一有变化就立刻检查新行并尝试发送(外加一个5秒兜底轮询，防止极少数环境下 `fs.watch` 漏事件)。发送成功后会在自己内部状态里清掉对应的 pending 记录；如果 `reply_to` 对应不上(比如 id 写错、或者对应的消息已经被回复过一次)，会在控制台打印错误并跳过这一行，**不会重试，也不会报错给外部程序**——外部程序自己要检查发送有没有成功(简单办法：看脚本的 stdout 日志，或者在 `text` 里带一个自己能识别的标记做核对)。

### 接口二：本地 WebSocket(`ws://127.0.0.1:17894`)

只绑定 `127.0.0.1`，跟文件接口一样默认信任"只有这台机器能访问"，不对外网开放。

- **收到微信消息时**：除了写 `inbox.jsonl`，同时会把同样的内容广播给所有已连接的 WebSocket 客户端：
  ```json
  {"type": "inbox", "id": "550e8400-...", "ts": 1755230000000, "from_user_id": "...", "text": "你好"}
  ```
- **想发送回复时**：直接给这个 WebSocket 连接发：
  ```json
  {"reply_to": "550e8400-...", "text": "这是要发出去的回复内容"}
  ```
  本脚本会立刻发送(不用等文件轮询)，同时也会把这条补写进 `outbox.jsonl` 存档，避免文件那边重复处理。发送结果会通过同一条连接返回：
  ```json
  {"type": "outbox", "reply_to": "550e8400-...", "text": "...", "ts": 1755230001000}
  ```
  或者失败时：
  ```json
  {"type": "error", "message": "找不到 reply_to=... 对应的会话", "reply_to": "550e8400-..."}
  ```
- **支持同时连接多个客户端**，数量不限——想开几个 agent/操控台同时连都可以，本脚本保证多个客户端能同时正常收广播、同时发送不冲突。文件接口和 WebSocket 接口共用同一套发送逻辑和去重(`pending` 映射表)，哪边先发成功，另一边就会因为对应记录已经被清掉而自动跳过，不会重复发送。
- **本地操控台**：浏览器直接打开 `http://127.0.0.1:17894`(同一个端口的 HTTP 服务)就能看到一个只读页面，实时显示收到/发出的消息，方便肉眼确认脚本在正常工作，不需要专门写一个 WebSocket 客户端去调试。

## 状态文件(外部程序不需要碰，了解即可)

`.wechat_state.json`：

```json
{
  "bot_token": "...",
  "get_updates_buf": "...",
  "pending": { "<inbox消息id>": { "to_user_id": "...", "context_token": "..." } },
  "outbox_lines_processed": 12
}
```

这个文件是脚本自己的内部记账，删掉会导致重新扫码登录(`bot_token` 丢失)以及 `outbox.jsonl` 从头重新处理一遍(`outbox_lines_processed` 归零，可能导致重复发送已经发过的内容)——**正常情况不要手动改动这个文件**。

## 已知限制

- 只支持文本消息收发，图片/语音/文件类型的消息会被静默跳过。
- 单进程单 bot_token，不支持多账号。
- 没有做 `outbox.jsonl` / `inbox.jsonl` 的自动清理/轮转，长期跑文件会一直增长，需要的话自己定期归档。
- 网络错误会自动重试(长轮询报错等 5 秒重试)，但不保证消息不丢——这是个人项目量级的实现，没做消息可靠性保证。
- 微信 iLink 接口的响应格式偶尔会变(遇到过两次：二维码字段格式变化、长轮询成功响应不带 `ret` 字段)，如果脚本突然报错，先怀疑接口格式变了，抓一下原始响应看看。

## 免责声明 / Disclaimer

本项目仅供个人学习与自用，用于收发微信 ClawBot 频道的消息。使用者应遵守微信平台的用户协议与相关法律法规，自行承担使用本项目的一切后果。本项目本身不含任何自动生成/自动决策发送内容的逻辑——发送什么、何时发送完全由使用者自己接入的外部程序决定；本项目不提供任何形式的自动化群发、批量骚扰或商业化滥用功能，作者不对第三方使用本代码所产生的任何后果负责。

This project is provided for personal, educational, and self-use purposes only, for sending and receiving messages through a WeChat ClawBot channel. Users are responsible for complying with WeChat's terms of service and all applicable laws and regulations, and bear full responsibility for any consequences arising from their use of this project. This project itself contains no logic for automatically generating or deciding what to send — what gets sent, and when, is entirely determined by whatever external program the user connects to it. This project does not provide any form of mass messaging, bulk harassment, or commercial-abuse functionality, and the author is not responsible for any consequences resulting from third-party use of this code.
