# CLI 真机测试手册（opencode run）

> 用 `opencode run` 无头跑真实模型验证插件行为。**会花钱**（deepseek 官方
> v4-pro 计费；flash-free 免费但不出 we 锚定）——按需跑，别乱试。
> 术语见 design.md（zero-anchored / seeded / unsealed / verified / giveup）。

## 1. 构建与部署

```bash
cd /home/liubohan/opencode/dsv4-adapter
npm run build                 # esbuild bundle → dist/index.js（prebuild 自动 prettier）
cp dist/index.js /tmp/opencode/smoke/.opencode/plugins/dsv4-anchored.js
```

- 测试目录：`/tmp/opencode/smoke`（已建，含 README.md、opencode.json、
  `.opencode/plugins/`）
- **不要同时存在 `.opencode/plugins/*.js` 和 `plugin` 配置**（双加载会导致
  chat.message 触发两次、注入行为错乱）
- 安装方式（opencode 官方）：`.opencode/plugins/*.{ts,js}` 自动发现；配置字段
  是 `plugin`（单数）

## 2. 配置（opencode.json）

```json
{
  "plugin": [["/home/liubohan/opencode/dsv4-adapter", { "options": "在此" }]]
}
```

选项（Dsv4Options）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `models` | `["deepseek*v4*"]` | 门控通配符 |
| `whitelist` | `["bash","str_replace_editor"]` | seeded 白名单；**0 工具 = `[]`**（实证唯一出 we 的形态） |
| `injectSystem` | 开启（解锁后注入） | `false` 关闭注入 |
| `anchorText` | 无 | zero 锚定消息（D13 定案后默认启用） |
| `firstTurnFilter` | `{stripPersona: true}` | 注入前去 opencode 身份句 |

## 3. 命令模板

```bash
# 首轮（新会话）：锚定 + 真实任务
cd /tmp/opencode/smoke && OPENCODE_LOG_LEVEL=DEBUG opencode run \
  --model deepseek/deepseek-v4-pro --variant max --thinking --auto \
  --print-logs "任务 prompt"

# 继续同一会话（解锁/判别在后续轮）
opencode run -c --model deepseek/deepseek-v4-pro --variant max --thinking \
  --auto --print-logs "Continue"

# 门控对照（非 v4 模型 → 插件零处理）
opencode run --model opencode/hy3-free "hi" --print-logs
```

参数要点：
- `--variant max`：reasoning effort（deepseek 官方经 `@ai-sdk/openai-compatible`
  支持 low/medium/high/max）
- `--thinking`：显示 thinking 块（判别/锚定看这里）
- `--auto`：自动批准权限（测试用）
- `--print-logs` + `OPENCODE_LOG_LEVEL=DEBUG`：stderr 打插件日志
- `-c`：继续上个会话（跨进程，状态从 ruleset/磁盘恢复）

## 4. 日志核对（grep dsv4-anchored）

```bash
# 完整事件链
opencode run ... 2>&1 | grep "dsv4-anchored"
```

| 事件 | 含义 |
| --- | --- |
| `probe.success key=... sysLen=...` | 探针捕获 system（10025B 级） |
| `chat.message stage=... gating=hit injectSource=...` | 阶段/注入来源（probe/none） |
| `system.transform action=replace beforeLen=... afterLen=46` | system 替换 minimal（46 = persona 长度） |
| `unlock agent=build` | 晋升信号 → 全量工具 |
| `verify.passed checked=N` | 判别达成（we 先于 let）→ verified |
| `verify.giveup checked=N` | N 条未达成（warn 一次，不锁死） |
| `compaction.rollback` | 压缩回退 |

状态文件：`cat ~/.local/share/opencode/dsv4-anchored/probe-cache.json`
（按天清理，含捕获的完整 system）。

## 5. 实测结论（2026-08-16，deepseek 官方 v4-pro + variant max）

| 首轮形态 | thinking | 判别 |
| --- | --- | --- |
| minimal + **0 工具** | **we 风格**（"We need answer..."）✅ | verified |
| minimal + 双工具（含假 bash） | standard-like（"The user wants.../Let me"） | giveup |
| minimal + 0 工具 + 首轮注入（含 stripPersona） | 非 we | giveup |
| flash-free（任意形态） | standard-like | giveup（免费模型不出 we） |

- **0 工具是唯一实证出 we 的形态** → D13 zero-anchored 定案（真实消息推迟 +
  event 自动轮 2，代码未实现）
- 判别恒 giveup 也不锁死（工具照常解锁，功能正常）

## 6. 花钱注意

- deepseek/deepseek-v4-pro 计费：一次 run ≈ 几百 token（探针零 token +
  模型回复），thinking(max) 会多一些；别反复跑同一场景
- 探针本身零 token（system.transform 抛错终止，不发模型）
- 免费对照：`opencode/deepseek-v4-flash-free`（验证链路，但不出 we）
