# Issue Tracker

> 记录已发现但尚未完全修复/需要复现的问题。状态：`open` / `investigating` /
> `fixed`。

## ISSUE-001: `<｜DSML｜tool_calls>` 标题乱输出复现

- **状态**：`open`
- **现象**：用户反馈 `<｜DSML｜tool_calls>` 标题乱输出又出现。
- **已有防护**：`system-transform.ts:51` 对 `output.system[0]` 含
  `You are a title generator` 的标题生成请求放行，不替换 minimal。
- **待办**：
  - 复现并抓 `serve.log` 中对应的 `system.transform` 与 `plugin.loaded`
    版本日志，确认全局插件版本是否为 0.1.3。
  - 确认标题请求的 `output.system[0]` 实际内容；若首行变化，需放宽/换更稳定
    的识别条件（如包含 `title generator` / `thread title`）。
  - 修复后补充回归用例。

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
