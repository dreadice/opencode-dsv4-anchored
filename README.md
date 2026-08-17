# opencode-dsv4-anchored

一个面向 opencode 的插件，用来改善 DeepSeek V4 系列模型在编码助手里的“抢跑”问题。

如果你刚接触这个项目，可以把它理解为：**在 DeepSeek V4 真正开始干活之前，先让它“热身”一轮，再把工具和完整上下文交给它。**

---

## 这个插件解决什么问题？

DeepSeek V4 模型在拿到完整系统提示词后，经常会出现这些现象：

- 第一轮就急着调用大量工具；
- 同时并行做好几件事；
- 输出很长，但思路一开始就跑偏。

这个插件借鉴了 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 的做法：先用一轮“锚定消息”把模型的起始轨迹拉回稳定状态，然后再放开工具执行真实任务。

---

## 它怎么工作？

简单来说，插件会把一次真实的对话拆成两轮：

### 第一轮：先热身，不干活

1. 插件会先“探针”一次：把当前真正的系统提示词保存下来。这个过程不会真正调用模型生成内容，所以不会消耗 token。
2. 插件把系统提示词替换成一句很简短的角色说明。
3. 你真正要问的问题会被暂时放在一边（存到本地 pending 文件）。
4. 模型只看到一句固定的测试消息，并且**不开放任何工具**。
5. 模型通常会先给出一个简短、稳定的回复。

### 第二轮：再干活

1. 第一轮回复落库后，插件自动恢复工具权限。
2. 插件把之前保存的系统提示词（去掉 opencode 自带身份描述）和你的真实问题一起发给模型。
3. 此时模型带着完整上下文和全部工具开始处理真实任务。

### 后续：持续判断

插件会根据模型前几轮回复的用词特征，判断锚定是否成功。例如：

- 如果模型先出现类似 `we need` 的表达，通常说明锚定成功；
- 如果先出现类似 `let me` 的表达，可能说明锚定效果不够好。

判断结果只会影响插件内部状态，不会锁死工具，也不会阻止你继续使用。

---

## 安装

要求：opencode `>= 1.18.18`。

### 配置文件在哪里？

opencode 会读取以下位置的配置文件，任选其一即可：

- 全局配置：`~/.config/opencode/opencode.json` 或 `~/.config/opencode/opencode.jsonc`
- 项目配置：项目根目录下的 `opencode.json` 或 `opencode.jsonc`

把下面的 `plugin` 配置写到其中一个文件里。全局配置对所有项目生效，项目配置只对当前项目生效。

### 方式一：通过 npm 安装（推荐）

在 opencode 配置文件中加入插件即可：

```json
{
  "plugin": [["@dreadice/opencode-dsv4-anchored", {}]]
}
```

### 方式二：使用本地文件

先构建插件：

```bash
npm run build
```

然后有两种用法：

**1. 默认行为：放到自动发现目录**

把 `dist/index.js` 复制到项目的插件目录：

```bash
cp dist/index.js <项目>/.opencode/plugins/dsv4-anchored.js
```

opencode 会自动加载，但这种方式不能传配置项，只能使用默认配置。

**2. 需要传配置项：用 `plugin` 配置指定文件路径**

把文件放到任意位置（建议不要放在 `.opencode/plugins/`，避免重复加载），然后在 `opencode.json` 里写：

```json
{
  "plugin": [
    [
      "/绝对路径/dsv4-anchored.js",
      {
        "skipSubagents": true,
        "injectSystemFirst": true
      }
    ]
  ]
}
```

> 注意：两种安装方式任选其一，不要同时使用。本地文件也不要同时“自动发现”和“在 `plugin` 配置里指定”，否则可能造成插件重复加载。

---

## 配置

插件提供以下配置项：

| 配置项              | 默认值                                                                            | 作用                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `models`            | `["deepseek*v4*"]`                                                                | 只有匹配这些模型名时插件才会生效                                                                                                              |
| `whitelist`         | `[]`                                                                              | 第一轮允许使用的工具白名单。默认是空，也就是第一轮不开放任何工具                                                                              |
| `anchorText`        | `"This round is a test. Tools are not open yet; all tools will open next round."` | 第一轮展示给模型的固定消息。设为 `""` 可关闭锚定轮                                                                                            |
| `injectSystem`      | 启用                                                                              | 第二轮是否把保存的完整系统提示词注入回去                                                                                                      |
| `injectSystemFirst` | `false`                                                                           | 开启后恢复“变更前”的单条消息实现：轮 2 把 user system 和真实任务合并成同一条消息且 system 在前。指令遵循更强，但可能导致会话摘要/标题生成错误 |
| `firstTurnFilter`   | `{stripPersona: true}`                                                            | 注入系统提示词前，是否去掉 opencode 自带的身份描述                                                                                            |
| `verifyN`           | `3`                                                                               | 判断锚定是否成功时，最多检查前几轮回复                                                                                                        |
| `verifyTerms`       | `{"we": ["we need", "we"], "let": ["let me"]}`                                    | 用于判断锚定成功的英文关键词                                                                                                                  |
| `toast`             | 启用                                                                              | 是否在 opencode 界面显示插件运行提示                                                                                                          |
| `skipSubagents`     | `false`                                                                           | 是否跳过子代理会话。默认不跳过；设为 `true` 可让子代理不经过锚定流程                                                                          |
| `probeTtlMs`        | `300000`                                                                          | 探针失败后，多久内不再重试                                                                                                                    |
| `cacheDir`          | `~/.local/share/opencode/dsv4-anchored/`                                          | 插件状态和探针缓存的存放目录                                                                                                                  |

### 配置示例

在 opencode 配置文件的 `plugin` 数组里，把插件名后面的 `{}` 换成你的配置即可：

```json
{
  "plugin": [
    [
      "@dreadice/opencode-dsv4-anchored",
      {
        "models": ["deepseek*v4*"],
        "whitelist": [],
        "anchorText": "This round is a test. Tools are not open yet; all tools will open next round.",
        "injectSystem": true,
        "injectSystemFirst": false,
        "firstTurnFilter": {
          "stripPersona": true
        },
        "verifyN": 3,
        "verifyTerms": {
          "we": ["we need", "we"],
          "let": ["let me"]
        },
        "toast": true,
        "skipSubagents": false,
        "probeTtlMs": 300000,
        "cacheDir": "~/.local/share/opencode/dsv4-anchored/"
      }
    ]
  ]
}
```

如果只想用默认配置，保留空对象 `{}` 即可，不需要写上面这些内容。

---

## 怎么确认插件生效了？

1. 打开 opencode，随便发一条消息。
2. 如果第一轮回复是默认锚定消息（`This round is a test...`），说明插件已经接管第一轮。
3. 稍等片刻，你的真实消息会自动在第二轮发出。
4. 也可以查看日志：

```bash
grep dsv4-anchored ~/.local/share/opencode/log/opencode.log
```

---

## 常见问题（FAQ）

### 这个插件会改变我使用的模型吗？

不会。插件只改变发送给模型的上下文和工具开放时机，不会替换你选择的模型。

### 会影响非 DeepSeek 模型吗？

默认不会。只有模型名匹配 `deepseek*v4*` 时，插件才会介入。

### 探针会消耗 token 吗？

当前实现不会。探针在真正调用模型之前就被终止，它只负责把系统提示词保存下来。

### 为什么我看到了 “This round is a test...”？

这是插件默认的锚定消息，表示第一轮正在执行。你的真实消息会在第二轮自动发出，不需要手动重发。

### 如果探针失败会怎样？

插件会临时按“原生模式”放行，你的会话不会被卡住，也不会丢失消息。

### 可以关闭这个插件吗？

可以。常见做法：

- 把 `anchorText` 设为 `""`，关闭锚定轮；
- 把 `models` 改为不匹配的模型名；
- 或者直接从 opencode 配置中移除插件。

### 状态和数据存在哪里？

探针缓存和会话状态存放在：

```text
~/.local/share/opencode/dsv4-anchored/
```

### 和其他插件一起用会冲突吗？

大多数情况下可以共存。需要注意两点：

- 多个插件同时修改系统提示词时，后注册的插件会生效；
- 锚定轮期间工具会被临时隐藏，第二轮会按 agent 规则恢复。

### 为什么默认先发真实消息，再发系统提示词？

这是为了避免标题/摘要生成看到注入的 system part 后产生类似 `<tool_calls>` 的错误。

如果你觉得指令遵循不够强，可以开启：

```json
{
  "plugin": [
    [
      "@dreadice/opencode-dsv4-anchored",
      {
        "injectSystemFirst": true
      }
    ]
  ]
}
```

开启后相当于恢复“变更前”的单条消息实现：user system 和真实任务合并成同一条消息，并且 system 在最前。

但请注意：开启后 system part 会放在同一条消息的最前面，可能导致会话摘要/标题生成错误。默认关闭。

### 子代理会受影响吗？

默认情况下，子代理也会走锚定流程，所以可能出现“先回复 Understood，之后才继续干活”的现象。如果你希望子代理完全跳过插件处理，可以在配置里设置：

```json
{
  "plugin": [
    [
      "@dreadice/opencode-dsv4-anchored",
      {
        "skipSubagents": true
      }
    ]
  ]
}
```

该行为已记录为 [ISSUE-003](docs/issues.md)。

---

## 文档

- [设计文档](docs/design.md) — 系统设计、状态机、配置说明
- [研究报告](docs/research.md) — opencode 机制源码分析
- [决策记录](docs/decisions.md) — 设计决策历史
- [测试文档](docs/testing.md) — 测试用例说明
- [真机测试手册](docs/live-testing.md) — 使用 opencode serve 验证插件
- [计划](docs/plan.md) — 项目执行计划
- [跨会话记录](docs/handoff.md) — 开发过程讨论留档

## License

[MIT](LICENSE)。
