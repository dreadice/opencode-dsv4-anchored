# 真机测试手册（opencode serve + HTTP API）

> 用真实 opencode 服务器 + 真实模型验证插件行为。**会花钱**（deepseek 官方
> v4-pro 计费；flash-free 免费——round-10 起实测 flash-free 锚定轮同样出 we
> 风格，**调试统一用它**）。
> 术语见 design.md（zero-anchored / seeded / unsealed / verified / giveup）。

## 0. 为什么用 serve 而不是 `opencode run`

`opencode run` 单次模式在 runLoop 完成后立即 dispose 实例（cancel runner）→
D13 轮 2（插件在 `session.idle` 后自动 prompt）没有机会执行。**serve 模式
服务器持续运行，全链路（锚定轮 → 轮 2 → 解锁 → 工具 → 判别）可完整验证**，
且可用 HTTP API 精确控制（创建会话、发消息、查消息、查 permission）。

## 1. 构建与部署

```bash
cd /home/liubohan/opencode/dsv4-adapter
npm run build                 # esbuild bundle → dist/index.js（prebuild 自动 prettier）
cp dist/index.js /tmp/opencode/smoke/.opencode/plugins/dsv4-anchored.js
```

- 测试目录：`/tmp/opencode/smoke`（已建，含 README.md、opencode.json、
  `.opencode/plugins/`）
- **不要同时存在全局 `~/.config/opencode/plugins/`、项目
  `.opencode/plugins/*.js` 和 `plugin` 配置**（双加载会导致 chat.message 触发
  两次、双探针、重复 toast；插件内有单例兜底，但测试时应三选一）
- 安装方式（opencode 官方仅两种，均实测）：`.opencode/plugins/*.{ts,js}`
  自动发现；或 `"plugin": [["@dreadice/opencode-dsv4-anchored", {}]]`
  （npm 包，已发布 0.1.0）

## 2. 配置（opencode.json）

```json
{
  "plugin": [["/home/liubohan/opencode/dsv4-adapter", {"options": "在此"}]]
}
```

选项（Dsv4Options，round-10 起默认 zero 形态）：

| 选项              | 默认                                  | 说明                                                             |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `models`          | `["deepseek*v4*"]`                    | 门控通配符                                                       |
| `whitelist`       | `[]`                                  | seeded 白名单；**0 工具**（实证唯一出 we 的形态，round-10 默认） |
| `anchorText`      | dsh 原文（"This round is a test..."） | zero 锚定消息；设 `""` 关闭锚定轮                                |
| `injectSystem`    | 开启（轮 2 注入 user system）         | `false` 关闭注入                                                 |
| `firstTurnFilter` | `{stripPersona: true}`                | 注入前去 opencode 身份句                                         |

## 3. 命令模板

### 3.1 serve + HTTP API（推荐，全链路可验证）

```bash
cd /tmp/opencode/smoke
opencode serve --port 43210 --print-logs > serve.log 2>&1 &   # 插件从 .opencode/plugins/*.js 加载
SID=$(curl -s -X POST "http://127.0.0.1:43210/session?directory=/tmp/opencode/smoke" \
  -H "content-type: application/json" -d '{"title":"t"}' | jq -r .id)

# 发消息（带 model 触发插件；不带 model 也能工作——插件用 output.message.model 兜底）
curl -s -X POST "http://127.0.0.1:43210/session/$SID/message" -H "content-type: application/json" \
  -d '{"model":{"providerID":"opencode","modelID":"deepseek-v4-flash-free"},"parts":[{"type":"text","text":"任务"}]}'
#    ↑ 返回锚定回复；轮 2 在后台自动执行（session.idle → sendRound2）

# 核对
grep dsv4-anchored serve.log                       # 事件链
curl -s "http://127.0.0.1:43210/session/$SID/message" | jq   # 消息/工具调用
curl -s "http://127.0.0.1:43210/session/$SID" | jq .permission # 哨兵/规则
curl -s --max-time 5 http://127.0.0.1:43210/global/health      # 健康检查
```

- 模型：`deepseek/deepseek-v4-pro`（官方，出 we 风格但计费）或
  `opencode/deepseek-v4-flash-free`（免费，round-10 实测锚定轮同样 we——调试用它）
- `--variant max` 只对 CLI/TUI 有意义（HTTP API 不传 reasoning effort 参数）；
  HTTP 用默认即可，或经模型配置调
- 测试后清理：`DELETE /session/:id`

### 3.2 `opencode run`（单次/继续，参考）

```bash
cd /tmp/opencode/smoke && OPENCODE_LOG_LEVEL=DEBUG opencode run \
  --model deepseek/deepseek-v4-pro --variant max --thinking --auto \
  --print-logs "任务 prompt"

opencode run -c --model deepseek/deepseek-v4-pro --variant max --thinking \
  --auto --print-logs "Continue"

# 门控对照（非 v4 模型 → 插件零处理）
opencode run --model opencode/hy3-free "hi" --print-logs
```

- **限制**：单次 run 只验证到锚定轮 + 轮 2 发出（round2.sent）；轮 2 的执行
  需要持续服务器（TUI/serve）——run 命令在 runLoop 完成后 dispose 实例

## 4. 日志核对（grep dsv4-anchored）

```bash
# 完整事件链
opencode run ... 2>&1 | grep "dsv4-anchored"
```

| 事件                                                        | 含义                                      |
| ----------------------------------------------------------- | ----------------------------------------- |
| `plugin.loaded version=...`                                 | 插件加载成功（含版本，便于排查旧版）      |
| `probe.success key=... sysLen=...`                          | 探针捕获 system（10025B 级）              |
| `chat.message stage=... gating=hit injectSource=...`        | 阶段/注入来源（probe/none/resync/anchor） |
| `system.transform action=replace beforeLen=... afterLen=46` | system 替换 minimal（46 = persona 长度）  |
| `unlock agent=build`                                        | 晋升信号 → 全量工具                       |
| `resync agent=... model=... stage=...`                      | 切换 agent/model 后权限重同步             |
| `native.restore agent=... model=...`                        | 非门控模型恢复原生权限                    |
| `verify.passed checked=N`                                   | 判别达成（we 先于 let）→ verified         |
| `verify.giveup checked=N`                                   | N 条未达成（warn 一次，不锁死）           |
| `compaction.rollback`                                       | 压缩回退                                  |

状态文件：`cat ~/.local/share/opencode/dsv4-anchored/probe-cache.json`
（按天清理，含捕获的完整 system）。

## 5. 实测结论（2026-08-16，deepseek 官方 v4-pro + variant max）

| 首轮形态                                       | thinking                                    | 判别                      |
| ---------------------------------------------- | ------------------------------------------- | ------------------------- |
| minimal + **0 工具**                           | **we 风格**（"We need answer..."）✅        | verified                  |
| minimal + 双工具（含假 bash）                  | standard-like（"The user wants.../Let me"） | giveup                    |
| minimal + 0 工具 + 首轮注入（含 stripPersona） | 非 we                                       | giveup                    |
| flash-free（任意形态）                         | standard-like                               | giveup（免费模型不出 we） |

- **0 工具是唯一实证出 we 的形态** → D13 zero-anchored 定案（真实消息推迟 +
  event 自动轮 2，round-10 实现）

## 5.1 D13 全链路真机验证（round-10，`opencode serve` + HTTP API）

> `opencode run` 单次模式在 runLoop 完成后立即 dispose（cancel runner）→
> 轮 2 没有机会执行。**用 `opencode serve` 持续运行验证全链路**：

```bash
cd /tmp/opencode/smoke
opencode serve --port 43210 --print-logs &        # 插件从 .opencode/plugins/*.js 加载
SID=$(curl -s -X POST "http://127.0.0.1:43210/session?directory=/tmp/opencode/smoke" \
  -H "content-type: application/json" -d '{"title":"t"}' | jq -r .id)
curl -s -X POST "http://127.0.0.1:43210/session/$SID/message" -H "content-type: application/json" \
  -d '{"model":{"providerID":"deepseek","modelID":"deepseek-v4-pro"},"parts":[{"type":"text","text":"任务"}]}'
# 锚定回复返回后，轮 2 在后台自动执行；grep dsv4-anchored serve.log 核对事件链
```

**实测结果（2026-08-16）——全链路闭环 ✅**：

| 事件        | 日志                                              | 验证点                                                             |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| 锚定轮      | `chat.message stage=pristine injectSource=anchor` | 首条消息 parts=纯锚定消息（synthetic），真实任务进 pending         |
| system 替换 | `system.transform replace 10025→46`               | Minimal persona                                                    |
| 锚定回复    | —（数据库消息）                                   | reasoning **we 风格**（v4-pro："We need answer user..."）✅        |
| 解锁        | `unlock agent=build`                              | agent ruleset 恢复（`*: allow` 等）                                |
| 轮 2        | `round2.sent partCount=2 sysInjected=true`        | user system（INJECT_MARKER）+ 真实任务自动发出                     |
| 真实任务    | —（消息含工具调用）                               | 轮 2 模型用 bash/glob/read 完整干活（v4-pro 与 flash-free 均验证） |
| 判别        | `verify.passed checked=6`                         | 锚定回复 we 先于 let → 哨兵 verified 落库                          |

- **flash-free 同样验证**（用户指示：调试统一用 flash-free，链路一样触发插件；
  实测 flash-free 锚定轮 reasoning 也是 "We need answer user..."——与 round-9
  的 standard-like 结论不同，可能是锚定消息形态差异；判别 verified 达成）

**本轮真机发现并修复的 4 个 bug**：

1. **`Plugin export is not a function`**：插件模块**所有导出必须是函数**
   （`plugin/index.ts:94-109` getLegacyPlugins）——`ZERO_ANCHOR_TEXT` 字符串
   具名导出导致加载失败。修复：去掉具名导出。
2. **`session.permission` 可能 undefined**：serve 新建会话的 wire `Session`
   **无 permission 字段**（GET /session/:id 实测）→ `getStage` 崩溃。修复：
   `session.permission ?? []` 防御（首次 ensure 写入后自愈）。
3. **wire Agent 无 `id` 字段（用 `name`）**：`agents.find(a => a.id ===
session.agent)` 永远失败 → agentRuleset 为空 → 解锁后工具没恢复 → 轮 2
   模型无工具（"tools aren't open yet"）。修复：`a.name === session.agent`。
4. **`chat.message` 的 `input.model` 可为 undefined**（POST message 不带
   model）→ 门控旁路。修复：`input.model ?? output.message.model` 兜底。

## 6. 花钱注意

- deepseek/deepseek-v4-pro 计费：一次 run ≈ 几百 token（探针零 token +
  模型回复），thinking(max) 会多一些；别反复跑同一场景
- 探针本身零 token（system.transform 抛错终止，不发模型）
- 免费对照：`opencode/deepseek-v4-flash-free`（验证链路；round-10 起实测
  锚定轮也能出 we 风格，判别可达成）——**调试统一用它**
