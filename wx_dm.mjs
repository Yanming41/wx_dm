// wechat_bridge.mjs
//
// 纯传输层 —— 只负责微信 ClawBot(iLink协议) 的收发，不含任何起草/agent逻辑。
// 不依赖 openclaw 核心包，只打验证过的官方接口 ilinkai.weixin.qq.com。
//
// 对外接口是两个文件（本目录下）：
//   inbox.jsonl   本脚本写，外部agent读 —— 微信收到的每条消息一行JSON
//   outbox.jsonl  外部agent写，本脚本读 —— agent想发出去的回复，一行JSON
//
// inbox 一行格式：  {"id":"<uuid>","ts":<毫秒时间戳>,"from_user_id":"...","text":"..."}
// outbox 一行格式： {"reply_to":"<inbox里的id>","text":"..."}
//   （agent只需要认识 id 和 text，不用管 to_user_id / context_token 这些微信协议细节，
//    这些由本脚本内部维护的 pending 映射表负责补全。）
//
// 使用：
//   node wechat_bridge.mjs
//   首次运行会弹出二维码，微信扫码绑定 bot 频道（不是登录你的微信主账号）。
//   之后常驻运行，两个内部循环并行：
//     - 长轮询收微信消息 -> 写 inbox.jsonl
//     - 轮询 outbox.jsonl 新增行 -> 发回微信

import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const STATE_FILE = path.join(__dirname, ".wechat_state.json");
const QRCODE_FILE = path.join(__dirname, "qrcode.png");
const INBOX_FILE = path.join(__dirname, "inbox.jsonl");
const OUTBOX_FILE = path.join(__dirname, "outbox.jsonl");

const OUTBOX_POLL_MS = 1000;

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
    return JSON.parse(await readFile(STATE_FILE, "utf-8"));
  }
  return { bot_token: null, get_updates_buf: "", pending: {}, outbox_lines_processed: 0 };
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
    }

    await saveState(state);
  }
}

// ---------- 循环二：轮询 outbox.jsonl -> 发回微信 ----------

async function outboxLoop(botToken, state) {
  console.log("[outbox] 开始监听 outbox.jsonl ...");
  while (true) {
    await new Promise((r) => setTimeout(r, OUTBOX_POLL_MS));

    if (!existsSync(OUTBOX_FILE)) continue;
    const content = await readFile(OUTBOX_FILE, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    if (lines.length <= state.outbox_lines_processed) continue;

    const newLines = lines.slice(state.outbox_lines_processed);
    for (const line of newLines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        console.error("[outbox] 跳过一行无法解析的内容:", line);
        continue;
      }

      const target = state.pending[entry.reply_to];
      if (!target) {
        console.error(
          `[outbox] 找不到 reply_to=${entry.reply_to} 对应的会话，跳过（可能已处理过或id写错了）`
        );
        continue;
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
              item_list: [{ type: 1, text_item: { text: entry.text } }],
            },
          },
        });
        console.log(`[outbox] 已发送回复 (reply_to=${entry.reply_to})`);
        delete state.pending[entry.reply_to];
      } catch (e) {
        console.error(`[outbox] 发送失败 (reply_to=${entry.reply_to}):`, e.message);
      }
    }

    state.outbox_lines_processed = lines.length;
    await saveState(state);
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

  // 两个循环并行跑，互不阻塞
  await Promise.all([inboxLoop(botToken, state), outboxLoop(botToken, state)]);
}

main().catch((e) => {
  console.error("脚本异常退出:", e);
  process.exit(1);
});
