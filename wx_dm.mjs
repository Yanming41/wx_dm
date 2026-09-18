// wx_dm.mjs
//
// 纯传输层 —— 只负责微信 ClawBot(iLink协议) 的收发，不含任何起草/agent逻辑。
// 不依赖 openclaw 核心包，只打验证过的官方接口 ilinkai.weixin.qq.com。
//
// 对外接口有两套，agent自己选一种或两种都用（设计取舍见 docs/adr/0001-realtime-transport.md）：
//
//   1) 文件接口（一直维护，无论有没有WebSocket客户端连着）：
//      inbox.jsonl   本脚本写，外部agent读 —— 微信收到的每条消息一行JSON
//      outbox.jsonl  外部agent写，本脚本读 —— agent想发出去的回复，一行JSON
//
//   2) WebSocket接口（ws://127.0.0.1:<WS_PORT>，仅本机可连）：
//      本脚本收到微信消息 -> 立刻推送 {"type":"inbox",...} 给所有已连接客户端（同时也写inbox.jsonl）
//      客户端发 {"reply_to":"...","text":"..."} -> 立刻发送回复（同时也补一行到outbox.jsonl存档）
//      客户端发 {"sender":"...","text":"..."} -> 主动推送(不依赖任何一条inbox消息)
//      支持同时连接多个客户端（不限制数量，由部署者自己决定开几个agent）
//      浏览器打开 http://127.0.0.1:<WS_PORT> 可以看到一个只读操控台，显示收发消息
//
// inbox 一行格式：  {"id":"<uuid>","ts":<毫秒时间戳>,"from_user_id":"...","text":"..."}
// outbox 一行格式有两种，agent自己选：
//   回复某条inbox消息： {"reply_to":"<inbox里的id>","text":"..."}
//   主动推送(不回复谁)： {"sender":"<起个名字，比如"小红书爬虫">","text":"..."}
//     主动推送会自动发给"owner_user_id"——也就是第一个给这个bot发过消息的微信账号
//     (本脚本自己从第一条inbox消息里记下来的，不用手动配置)，文本会自动加上
//     【<sender>来消息】的标签，方便主人一眼看出这是哪个程序发的。
//   （agent只需要认识 id 和 text，不用管 to_user_id / context_token 这些微信协议细节，
//    这些由本脚本内部维护的 pending 映射表负责补全。）
//
// 使用：
//   node wx_dm.mjs
//   首次运行会弹出二维码，微信扫码绑定 bot 频道（不是登录你的微信主账号）。
//   之后常驻运行，几个内部循环/服务并行：
//     - 长轮询收微信消息 -> 写 inbox.jsonl + WebSocket推送
//     - fs.watch监听 outbox.jsonl 变化（外加保底轮询）-> 发回微信
//     - 本地HTTP+WebSocket服务，提供操控台页面和实时收发接口

import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync, watch as fsWatch } from "node:fs";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const STATE_FILE = path.join(__dirname, ".wechat_state.json");
const QRCODE_FILE = path.join(__dirname, "qrcode.png");
const INBOX_FILE = path.join(__dirname, "inbox.jsonl");
const OUTBOX_FILE = path.join(__dirname, "outbox.jsonl");

// 保底轮询间隔——fs.watch在正常情况下会立刻触发，这个只是防止极端情况下(比如某些
// 网络盘/容器环境fs.watch不可靠)漏掉变化事件的兜底，不是主要触发路径了。
const OUTBOX_FALLBACK_POLL_MS = 5000;

// 本机操控台+WebSocket端口。注意跟同项目下 chrome_lens_extension 的 lens_extension_bridge.mjs
// (占用17893) 分开，避免冲突。只绑定127.0.0.1，不对外网开放。
const WS_PORT = 17894;

// ---------- iLink 基础工具 ----------

function randomUin() {
  const n = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(n)).toString("base64");
}

async function ilinkFetch(pathAndQuery, { method = "GET", body, token } = {}) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${ILINK_BASE}${pathAndQuery}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  // 2026-09接口变更：不是所有接口都还带ret字段了(比如getupdates现在成功时干脆不带这个字段)。
  // 只有明确带了ret字段、且不等于0，才真的是报错——没有ret字段不代表出错，之前这里判断过严，
  // 把getupdates正常的"当前没有新消息"响应({"msgs":[],...})也当成报错抛出来了。
  if (json.ret !== undefined && json.ret !== 0) {
    throw new Error(`iLink接口报错 ${pathAndQuery}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ---------- 状态持久化 ----------
// pending: { [inboxMsgId]: { to_user_id, context_token } } —— 用来把 outbox 的 reply_to
//          翻译回微信协议需要的字段，agent 自己不用关心这些。

async function loadState() {
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(await readFile(STATE_FILE, "utf-8"));
    if (!state.owner_user_id) state.owner_user_id = await bootstrapOwnerId();
    return state;
  }
  return {
    bot_token: null,
    get_updates_buf: "",
    pending: {},
    outbox_lines_processed: 0,
    owner_user_id: await bootstrapOwnerId(),
  };
}

// owner_user_id：主动推送(不是回复某条inbox消息)时要发给谁，本脚本自己认不出"谁是主人"，
// 只能从第一条真实收到的消息里"偷师"——这是个人单用户bot(见README已知限制：单进程单
// bot_token，不支持多账号)，谁第一个发消息给这个bot，就默认谁是主人。
// 如果inbox.jsonl还是空的(没人给bot发过消息)，先返回null，等真收到第一条消息时
// inboxLoop会自己补上，不需要用户手动配置任何东西。
async function bootstrapOwnerId() {
  if (!existsSync(INBOX_FILE)) return null;
  const content = await readFile(INBOX_FILE, "utf-8");
  const firstLine = content.split("\n").find(Boolean);
  if (!firstLine) return null;
  try {
    return JSON.parse(firstLine).from_user_id ?? null;
  } catch {
    return null;
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function openFile(filePath) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${filePath}"`
      : process.platform === "darwin"
      ? `open "${filePath}"`
      : `xdg-open "${filePath}"`;
  exec(cmd, (err) => {
    if (err) console.log(`没能自动打开图片，你自己去看一下：${filePath}`);
  });
}

// ---------- 本地HTTP+WebSocket服务：操控台 + 实时收发 ----------
//
// wss.clients 本身就是个Set，装着所有当前连着的客户端，天然支持多个客户端同时连接，
// 不用自己写连接数上限——想开几个agent/操控台，同时连就是了。

let wss = null;

function broadcast(event) {
  if (!wss) return;
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>wx_dm 操控台</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; background: #f6f6f7; }
  h1 { font-size: 18px; }
  #status { font-size: 13px; color: #888; margin-bottom: 12px; }
  #log { display: flex; flex-direction: column; gap: 6px; }
  .row { padding: 8px 10px; border-radius: 6px; font-size: 14px; line-height: 1.4; }
  .in { background: #e8f0fe; }
  .out { background: #e6f4ea; }
  .tag { font-weight: 600; margin-right: 6px; }
  .ts { color: #999; font-size: 12px; margin-left: 8px; }
</style>
</head>
<body>
<h1>wx_dm 操控台(信鸽)</h1>
<div id="status">连接中...</div>
<div id="log"></div>
<script>
  const log = document.getElementById("log");
  const status = document.getElementById("status");
  function addRow(cls, tag, text, ts) {
    const row = document.createElement("div");
    row.className = "row " + cls;
    const time = new Date(ts || Date.now()).toLocaleTimeString();
    row.innerHTML = '<span class="tag">' + tag + '</span>' +
      text.replace(/</g, "&lt;") + '<span class="ts">' + time + '</span>';
    log.prepend(row);
  }
  function connect() {
    const ws = new WebSocket("ws://" + location.host);
    ws.onopen = () => status.textContent = "已连接";
    ws.onclose = () => { status.textContent = "已断开，3秒后重连..."; setTimeout(connect, 3000); };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "inbox") addRow("in", "收到", msg.text, msg.ts);
      else if (msg.type === "outbox") addRow("out", msg.sender ? "推送·" + msg.sender : "回复", msg.text, msg.ts);
    };
  }
  connect();
</script>
</body>
</html>`;

function startControlServer(botToken, state) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    ws.on("message", async (raw) => {
      let entry;
      try {
        entry = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "不是合法的JSON" }));
        return;
      }
      if (typeof entry.text !== "string" || (!entry.reply_to && !entry.sender)) {
        ws.send(JSON.stringify({ type: "error", message: "需要 {reply_to, text} (回复) 或 {sender, text} (主动推送) 字段" }));
        return;
      }

      const result = entry.reply_to
        ? await sendReply(botToken, state, entry.reply_to, entry.text)
        : await sendPush(botToken, state, entry.sender, entry.text);

      if (!result.ok) {
        ws.send(JSON.stringify({ type: "error", message: result.error, reply_to: entry.reply_to }));
        return;
      }
      // 存档进outbox.jsonl，并同步跳过行数，避免文件轮询那边重复处理这一条。
      const archived = entry.reply_to
        ? { reply_to: entry.reply_to, text: entry.text }
        : { sender: entry.sender, text: entry.text };
      await appendFile(OUTBOX_FILE, JSON.stringify(archived) + "\n", "utf-8");
      state.outbox_lines_processed += 1;
      await saveState(state);
    });
  });

  // 只绑定127.0.0.1，跟inbox.jsonl/outbox.jsonl一样，默认信任"只有这台机器能碰"。
  server.listen(WS_PORT, "127.0.0.1", () => {
    console.log(`[控制台] 操控台已启动: http://127.0.0.1:${WS_PORT}`);
  });
}

// ---------- 绑定（一次性，token会持久化，之后不用重新扫码） ----------

async function login() {
  const { qrcode, qrcode_img_content } = await ilinkFetch(
    "/ilink/bot/get_bot_qrcode?bot_type=3"
  );

  // 接口返回格式2026-09变过：以前qrcode_img_content直接是base64图片数据(data:image/...;base64,xxx)，
  // 现在改成了一个纯URL(https://liteapp.weixin.qq.com/q/...)，得自己把这段文本生成成二维码图案，
  // 不能再直接当base64解码——之前这么干过，解出来的是30字节的随机垃圾数据，图片打不开。
  if (qrcode_img_content.startsWith("data:image")) {
    const base64Data = qrcode_img_content.replace(/^data:image\/\w+;base64,/, "");
    await writeFile(QRCODE_FILE, Buffer.from(base64Data, "base64"));
  } else {
    await QRCode.toFile(QRCODE_FILE, qrcode_img_content, { width: 400 });
  }
  console.log(`二维码已保存到: ${QRCODE_FILE}，正在尝试自动打开...`);
  openFile(QRCODE_FILE);
  console.log("用微信扫码授权（120秒内），扫完在手机上确认一下。");

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await ilinkFetch(
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    );
    if (status.status === "confirmed") {
      console.log("绑定成功！");
      return status.bot_token;
    }
  }
  throw new Error("等待扫码超时，重新运行脚本再试一次。");
}

// ---------- 循环一：收微信消息 -> 写 inbox.jsonl ----------

async function inboxLoop(botToken, state) {
  console.log("[inbox] 开始监听微信消息...");
  while (true) {
    let resp;
    try {
      resp = await ilinkFetch("/ilink/bot/getupdates", {
        method: "POST",
        token: botToken,
        body: {
          get_updates_buf: state.get_updates_buf,
          base_info: { channel_version: "1.0.2" },
        },
      });
    } catch (e) {
      console.error("[inbox] 长轮询出错，5秒后重试:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    state.get_updates_buf = resp.get_updates_buf ?? state.get_updates_buf;

    for (const msg of resp.msgs ?? []) {
      if (msg.message_type !== 1) continue; // 只处理用户发来的消息
      const textItem = msg.item_list?.find((i) => i.type === 1);
      if (!textItem) continue; // 先只处理文本，图片/语音先跳过

      const id = randomUUID();
      state.pending[id] = {
        to_user_id: msg.from_user_id,
        context_token: msg.context_token,
      };

      const record = {
        id,
        ts: Date.now(),
        from_user_id: msg.from_user_id,
        text: textItem.text_item.text,
      };
      await appendFile(INBOX_FILE, JSON.stringify(record) + "\n", "utf-8");
      console.log(`[inbox] 收到消息 -> ${id}: ${record.text}`);
      broadcast({ type: "inbox", ...record });

      if (!state.owner_user_id) {
        state.owner_user_id = msg.from_user_id;
        console.log(`[inbox] 记录主人身份(owner_user_id): ${msg.from_user_id}`);
      }
    }

    await saveState(state);
  }
}

// ---------- 发送逻辑（文件轮询和WebSocket客户端共用这一份） ----------

async function sendReply(botToken, state, replyTo, text) {
  const target = state.pending[replyTo];
  if (!target) {
    const error = `找不到 reply_to=${replyTo} 对应的会话（可能已处理过或id写错了）`;
    console.error(`[outbox] ${error}`);
    return { ok: false, error };
  }

  try {
    await ilinkFetch("/ilink/bot/sendmessage", {
      method: "POST",
      token: botToken,
      body: {
        msg: {
          to_user_id: target.to_user_id,
          message_type: 2,
          message_state: 2,
          context_token: target.context_token,
          item_list: [{ type: 1, text_item: { text } }],
        },
      },
    });
    console.log(`[outbox] 已发送回复 (reply_to=${replyTo})`);
    delete state.pending[replyTo];
    await saveState(state);
    broadcast({ type: "outbox", reply_to: replyTo, text, ts: Date.now() });
    return { ok: true };
  } catch (e) {
    console.error(`[outbox] 发送失败 (reply_to=${replyTo}):`, e.message);
    return { ok: false, error: e.message };
  }
}

// sendPush：主动推送，不依赖任何inbox消息(没有reply_to/context_token)，直接发给
// owner_user_id。文本前面自动加上 【<sender>来消息】 的标签，这样主人在微信里能一眼
// 看出这条消息是哪个程序/agent发的，不用每次都去查是谁在说话。
async function sendPush(botToken, state, sender, text) {
  if (!state.owner_user_id) {
    const error = "还没记录到owner_user_id——得先用微信给这个bot发一条消息，本脚本才知道该把主动推送发给谁";
    console.error(`[push] ${error}`);
    return { ok: false, error };
  }

  const labeled = `【${sender}来消息】\n${text}`;
  try {
    await ilinkFetch("/ilink/bot/sendmessage", {
      method: "POST",
      token: botToken,
      body: {
        msg: {
          to_user_id: state.owner_user_id,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: labeled } }],
        },
      },
    });
    console.log(`[push] 已推送 (sender=${sender}): ${text}`);
    broadcast({ type: "outbox", sender, text, ts: Date.now() });
    return { ok: true };
  } catch (e) {
    console.error(`[push] 推送失败 (sender=${sender}):`, e.message);
    return { ok: false, error: e.message };
  }
}

// ---------- 循环二：监听 outbox.jsonl 变化 -> 发回微信 ----------
//
// 主要靠 fs.watch 在文件变化时立刻触发检查（低延迟），外加一个低频兜底轮询防止
// fs.watch 在极少数环境下漏事件。两者最终都调用同一个 checkOutboxFile，
// 靠 outbox_lines_processed 天然去重，不会重复发送。

async function outboxLoop(botToken, state) {
  let checking = false;

  async function checkOutboxFile() {
    if (checking) return; // 避免同一时刻并发跑两次检查
    checking = true;
    try {
      if (!existsSync(OUTBOX_FILE)) return;
      const content = await readFile(OUTBOX_FILE, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length <= state.outbox_lines_processed) return;

      const newLines = lines.slice(state.outbox_lines_processed);
      for (const line of newLines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          console.error("[outbox] 跳过一行无法解析的内容:", line);
          continue;
        }
        if (entry.reply_to) {
          await sendReply(botToken, state, entry.reply_to, entry.text);
        } else if (entry.sender && typeof entry.text === "string") {
          await sendPush(botToken, state, entry.sender, entry.text);
        } else {
          console.error("[outbox] 跳过一行格式不对的内容(缺 reply_to 或 sender+text):", line);
        }
      }

      state.outbox_lines_processed = lines.length;
      await saveState(state);
    } finally {
      checking = false;
    }
  }

  function armWatcher() {
    if (!existsSync(OUTBOX_FILE)) {
      // 文件还没创建（比如agent还没写过第一条回复），先兜底轮询等它出现。
      setTimeout(armWatcher, OUTBOX_FALLBACK_POLL_MS);
      return;
    }
    console.log("[outbox] fs.watch 已挂载在 outbox.jsonl 上，文件一变就会立刻检查");
    const watcher = fsWatch(OUTBOX_FILE, () => checkOutboxFile());
    watcher.on("error", (e) => {
      console.error("[outbox] fs.watch出错，5秒后重挂:", e.message);
      setTimeout(armWatcher, 5000);
    });
  }

  console.log("[outbox] 开始监听 outbox.jsonl ...");
  armWatcher();
  // 兜底轮询：正常情况下 fs.watch 已经足够及时，这里只是双保险。
  while (true) {
    await new Promise((r) => setTimeout(r, OUTBOX_FALLBACK_POLL_MS));
    await checkOutboxFile();
  }
}

// ---------- 入口 ----------

async function main() {
  const state = await loadState();

  let botToken = state.bot_token;
  if (!botToken) {
    botToken = await login();
    state.bot_token = botToken;
    await saveState(state);
  }

  startControlServer(botToken, state);

  // 几个循环并行跑，互不阻塞
  await Promise.all([inboxLoop(botToken, state), outboxLoop(botToken, state)]);
}

main().catch((e) => {
  console.error("脚本异常退出:", e);
  process.exit(1);
});
