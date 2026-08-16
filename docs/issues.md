# Issue Tracker

> 记录已发现但尚未完全修复/需要复现的问题。状态：`open` / `investigating` /
> `fixed`。

## ISSUE-001: `<｜DSML｜tool_calls>` 标题乱输出复现

- **状态**：`investigating`
- **现象**：用户反馈 `<｜DSML｜tool_calls>` 标题乱输出又出现。
- **已有防护**：`system-transform.ts` 对标题生成请求放行，不替换 minimal。
- **serve 验证（0.1.3+）**：
  - 会话无自定义 title，发送真实任务后，标题变为 `<tool_calls>`。
  - 日志出现 `system.transform.title-bypass`，说明标题请求的 system **确实被
    放行**（没有被替换成 minimal）。
  - 因此标题乱输出不是“system 被替换”导致，而是**标题模型看到了轮 2 注入的
    完整 system user part**（`[dsv4-anchored:injected]:...`），flash-free 小模型
    据此输出了 `<tool_calls>`。
- **待办**：
  - 确认是否需要保留 AI 自动标题；若不需要，可在 `sendRound2` 前用真实任务
    文本设置一个简单标题，跳过 `ensureTitle`。
  - 若需要保留 AI 标题，需让标题生成上下文排除 synthetic 注入块（opencode
    目前 `ensureTitle` 会包含该 user 消息的全部 parts，插件侧较难干净过滤）。

## ISSUE-002: 轮 2 toast 时机误导 + verified 要等下一次用户消息

- **状态**：`fixed`（0.1.3+）
- **现象**：
  - `round2.sent` toast 在 `session.prompt` **整个 ReAct 跑完后**才触发，
    用户以为“刚发出”，实际轮 2 已结束。
  - 判别 `verify.passed` 要等用户再发一条消息才出现，造成“verified 延迟”。
- **根因**：
  - `src/round2.ts` 在 `await ctx.client.session.prompt(...)` 之后才发 toast。
  - `chat.message` 的 ensure 在轮 2 消息上只做 `unlock` 并 return，没有在
    轮 2 结束后自动扫描判别。
- **修复**：
  - `round2.sent` toast 改为 prompt 发起后立即触发。
  - 轮 2 的 `session.prompt` 完成后，追加 `verifyAfterRound2`：若 `unsealed`
    且历史 assistant 消息命中 `verifyText`，立即追加 `verified` 哨兵并 toast。
  - 新增 TC-2-35 覆盖“轮 2 结束后立即 verified”。
