# ADR 0003: sendmessage必须带client_id/base_info/App头，否则静默不送达

- **状态**：已采纳(Accepted)
- **日期**：2026-09-18

## 背景 / Context

上线主动推送功能后验收时，发现`sendmessage`接口每次调用都返回`200`和一个正常的
`message_id`，看起来完全成功，但消息实际上**根本没有送达**手机端——测试了十几次，
换了全新绑定的bot、带`context_token`不带`context_token`、用没改过的原始代码，
全部都是"接口说成功，手机上什么都没有"。

这个过程中一度怀疑过好几个方向：账号被限流、bot绑定失效、代码有回归——都被一一
排除了(细节见对话记录，用git第一次commit的原始代码重新测试过，同样失败，证明
不是代码改动引入的问题)。最后通过搜索找到腾讯官方iLink协议的第三方文档
([nightsailer/wechat-clawbot](https://github.com/nightsailer/wechat-clawbot/blob/master/docs/ilink-protocol.md))，
才发现问题出在请求本身缺字段。

## 决策 / Decision

`sendmessage`请求实际需要下面这些东西，缺了不会报错，但消息不会真正送达：

**请求体`msg`里要有`client_id`**(调用方自己生成的字符串，比如uuid)：
```json
{
  "msg": {
    "to_user_id": "...",
    "client_id": "<自己生成的uuid>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "...",
    "item_list": [...]
  },
  "base_info": { "channel_version": "2.1.1" }
}
```

**请求体顶层要有`base_info`**——之前只有`getupdates`调用带了`base_info`，
`sendmessage`完全没带，这是最容易漏掉的一处，因为两个接口"看起来"应该是对称的，
容易想当然地以为`sendmessage`不需要这个字段。

**请求头要加两个之前完全没传的头**：
```
iLink-App-Id: bot
iLink-App-ClientVersion: 1
```

修完之后在同一个`bot_token`、同样的账号上重新测试，消息正常送达，证明这就是
唯一的问题所在，跟账号风控/bot绑定状态都无关。

## 一个更重要的副产品发现：这个接口没有"送达确认"

调试过程中逐条对比了"送达成功"和"送达失败"两种情况下微信服务器返回的原始
response——**两者完全一样**，都是`{"message_id": <数字>}`，没有任何字段能
区分"消息真的到手机了"和"消息被服务器悄悄丢了"。也就是说`sendmessage`这个
接口本身只是一个"受理确认"(acknowledgement)，不是"送达确认"(delivery
confirmation)——这两个概念在很多消息类API里是分开的，iLink只暴露了前者。

这意味着wx_dm(以及任何调用这个接口的程序)**没有办法通过接口返回值判断消息
是否真正送达**，`sendReply`/`sendPush`里的`{ok:true}`只代表"腾讯服务器接受了
这个请求"，不代表"用户手机上出现了这条消息"。这是协议本身的限制，不是能在
wx_dm这一层修掉的东西，已经写进README的已知限制里。

## 影响与取舍 / Consequences

- 以后任何新增的"调iLink接口发消息"的代码路径，都要记得带上这四样东西
  (`client_id`、`base_info`、两个`iLink-App-*`头)，不然会复现这个"看起来
  成功实际没送达"的坑。
- 由于没有送达确认，wx_dm没法做"发送失败自动重试"这种逻辑——重试的前提是
  能分辨失败，这一层做不到。如果以后要做可靠投递，得在更上层(比如让agent
  自己在消息里带个能识别的标记，等对方回复确认收到)做，不是wx_dm这层能
  解决的问题。
- 调试这个问题时，短时间内对同一个账号发了大量测试消息(不同格式的探测、
  连续多次重试)，一度怀疑是这个测试模式触发了账号风控——最后证明是缺字段
  的问题，风控不是真正原因，但这提醒了一件事：调试真实第三方接口时应该
  更节制地控制测试频率，先做假设排除(比如先用文档核对请求体，而不是一上来
  就盲测)，再动手调用，避免不必要地对真实账号产生高频流量。
