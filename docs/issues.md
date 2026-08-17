# Issue Tracker

> 记录已发现但尚未完全修复/需要复现的问题。状态：`open` / `investigating` /
> `fixed`。

## ISSUE-001: `<｜DSML｜tool_calls>` 标题乱输出复现

- **状态**：`fixed`（拆两条 user 消息方案，0.1.4-dev）
- **现象**：用户反馈 `<｜DSML｜tool_calls>` 标题乱输出又出现。
- **已有防护**：`system-transform.ts` 对标题生成请求放行，不替换 minimal。
- **serve 验证（0.1.3+）**：
  - 会话无自定义 title，发送真实任务后，标题变为 `<tool_calls>`。
  - 日志出现 `system.transform.title-bypass`，说明标题请求的 system **确实被
    放行**（没有被替换成 minimal）。
  - 因此标题乱输出不是“system 被替换”导致，而是**标题模型看到了轮 2 注入的
    完整 system user part**（`[dsv4-anchored:injected]:...`），flash-free 小模型
    据此输出了 `<tool_calls>`。
- **修复（拆两条 user 消息）**：
  - 轮 2 先发真实任务（`noReply: true`，只入库不跑），再发 synthetic system
    消息并启动模型。
  - 标题生成只看到第一条真实任务，看不到 synthetic system，因此不再输出
    `<tool_calls>`。
  - 注意：当前 serve 验证标题保持默认（未自动生成），需要进一步确认 AI 标题
    是否要恢复；但至少不再出现 `<tool_calls>`。
- **已确认不可行**：opencode 没有暴露“标题生成请求的 messages” hook——
  title 走 `llm.stream` 直接调用，只触发 `system.transform` / `chat.params` /
  `chat.headers`，没有 `messages.transform` / `chat.message`。因此无法在
  title 请求里注入/删除第二个 part 来屏蔽 synthetic 注入块。

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

## ISSUE-003: 子代理被锚定协议提前结算，主代理可能重入

- **状态**：`open`（暂不修复；当前“重入”风格可接受，用户决定保留）
- **现象**：
  - 主代理通过 Task 工具创建子代理会话（`parentID` 存在）。
  - 插件把子代理当成普通会话处理：首轮真实任务被替换为锚定消息，真实任务进入
    pending，子代理被设为 seeded（0 工具）。
  - 子代理只看到锚定消息，回复 `Understood. Ready when tools are available.`
    ——这条回复作为子代理结果返回给主代理。
  - 随后 `session.idle` 触发 round2，真实任务 + system 注入同一个子代理会话，
    子代理在后台继续执行。
  - 主代理看到占位回复后可能重新进入该子代理并再次下发任务，形成重复/交错执行。
- **根因**：
  - zero-anchor 协议是为**主交互代理**设计的，依赖“首轮占位 → 回复 → round2
    解锁 → 真实任务”的完整会话生命周期。
  - Task 子代理是一次性调用，第一次 assistant 回复就会作为结果返回父代理，
    不会等待插件后续 round2；因此锚定协议破坏了子代理的调用契约。
- **已讨论但未采纳的方案**：
  - 对 `parentID !== undefined` 的子代理会话完全跳过插件处理（不锚定、不注入、
    不替换 system、不触发 round2），让子代理保持原生行为。
  - 用户不同意该方案；当前“主代理重入子代理”的风格可以接受，暂时不修复。
- **后续如需修复**：
  - 可重新评估是否跳过子代理，或为子代理提供独立的非锚定模式；
  - 需要同步更新 TC-2-15（当前为“subagent 独立按同流程处理”）及文档。
