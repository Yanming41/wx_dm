# ADR 0005: 图片发送协议深挖记录(上传能走通，下载重建卡住，到此为止)

- **状态**：已采纳(Accepted)——记录存档，不再继续投入时间深挖这条路径。
- **日期**：2026-09-19 ~ 2026-09-20

## 背景 / Context

[[0004-wechat-clawbot-limitations-verdict]] 记录了"图片发不出去"这个初步结论。后续
找到了腾讯官方仓库[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)
的`docs/protocol.md`，比第三方文档详细得多，照着它把整套"申请上传地址→加密→上传→
引用发送"的流程重新实现了一遍，记录一下具体做到哪一步、哪一步验证通过、哪一步卡住了。

## 已经验证能走通的部分

**1. 申请上传地址** —— `POST /ilink/bot/getuploadurl`，请求体：
```json
{
  "filekey": "<uuid>",
  "media_type": 1,
  "to_user_id": "...",
  "rawsize": <明文字节数>,
  "rawfilemd5": "<明文md5>",
  "filesize": <密文字节数>,
  "no_need_thumb": true,
  "aeskey": "<16字节AES key的hex编码>",
  "base_info": { "channel_version": "2.4.8", "bot_agent": "OpenClaw" }
}
```
返回`upload_full_url`，形如
`https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=...&filekey=...&taskid=...`。
**这一步实测200，返回正常。**

**2. 加密**：AES-128-ECB + PKCS#7 padding(Node `createCipheriv("aes-128-ecb", key, null)`
默认行为就是PKCS7，不用额外处理)，明文MD5用加密前的原始文件算。**加密逻辑本身没有报错**，
密文长度符合预期(明文187112字节，密文187120字节，多出的8字节是PKCS7 padding，合理)。

**3. 上传密文** —— `POST <upload_full_url>`，body是加密后的字节，
`Content-Type: application/octet-stream`。**实测200，响应头带`x-encrypted-param`**
(一段约500字符的字符串)。

**4. 引用发送** —— `sendmessage`的`item_list`里放：
```json
{
  "type": 2,
  "image_item": {
    "aeskey": "<16字节key的hex>",
    "mid_size": <密文字节数>,
    "media": {
      "encrypt_query_param": "<上传响应的x-encrypted-param>",
      "aes_key": "<16字节key的base64>",
      "encrypt_type": 1
    }
  }
}
```
**实测200，返回`message_id`，而且这次真的在微信客户端里出现了一个图片消息气泡**
(比最早"什么都没有"进了一步)——但气泡里的图片**一直显示加载失败/空白，没能真正渲染出来**。

## 卡住的部分：自己下载解密都失败

为了排除"是不是sendmessage那步的JSON格式还差点什么"，直接绕开微信客户端，自己模拟
"下载再解密"这一步，来验证"上传的密文到底能不能正确拿回来"：

- protocol.md提到下载地址大致形如
  `<cdn_base_url>/download?encrypted_query_param=<encrypt_query_param>`，
  `cdn_base_url`默认是`https://novac2c.cdn.weixin.qq.com/c2c`。
- 实测这个下载地址**直接返回 HTTP 400**，错误信息：
  ```
  x-error-code: -5102008
  x-error-message: invalid encrypted_param: data too short or base64 decode failed
  ```
- 试过：重复/不重复URL编码、带上`filekey`+`taskid`作为额外query参数、去掉`/c2c`前缀、
  带上iLink认证头——**全部同样的报错**。

这说明"encrypted_query_param"这个值在下载时该怎么拼(是不是要跟别的信息组合、是不是
需要额外签名、是不是这个字段压根不能直接复用上传响应的`x-encrypted-param`)，
protocol.md里能查到的信息不够——这已经超出任何公开文档能查证的范围了。

## 决策 / Decision

到此为止，不再继续投入时间猜测这个下载重建的细节。已经确认的进展(申请上传、加密、
上传、构造image_item让WeChat认出消息类型)记录在案，供以后如果有人想接着深挖时参考，
但不再是这个项目当前要解决的问题——[[0004-wechat-clawbot-limitations-verdict]]里
已经决定了"主动推送+带图"这类场景改用Discord bot，Discord原生支持发图片，没有这些
未公开的加密/CDN细节要猜。

## 影响与取舍 / Consequences

- 如果以后确实需要在wx_dm里补上图片发送能力，这份记录能省掉重新做一遍"申请上传→
  加密→上传"这几步验证的时间——这几步已经确认没问题，卡点明确在下载重建这一步。
- 这次深挖也是一次关于"投入产出比"的提醒：协议逆向工程在缺乏官方SDK源码的情况下，
  即使找到了官方文档，也可能在细节层面(比如一个参数具体怎么拼)缺失到没法靠猜完成——
  该找到明确停止点就停，不要无限期地在没有更多信息增量的猜测上消耗时间。
