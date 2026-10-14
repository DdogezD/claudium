# Claudium

Claudium 是一个对非 Anthropic 模型友好，终端原生，去 Anthropic 化的 Claude Code Fork。

它保留 Claude Code 的本地 CLI 工作流，移除上游 OAuth、远程控制、遥测和自动更新相关服务，使用你配置的 Anthropic API 端点。

## 自动安装

要求：Bun `>=1.4.0`、Git、ripgrep；支持 macOS、Linux 和 WSL。

*(Windows 支持不在计划中，想看 claudium 大战 pwsh 的请通过 WSL 穿透执行 powershell.exe)*

**执行此安装脚本将拉取最新源码并构建，你可以随时[审查安装脚本](https://github.com/DdogezD/claudium/blob/main/install.sh)，再次执行此命令即可更新最新版本。**

```bash
curl -fsSL https://raw.githubusercontent.com/DdogezD/claudium/main/install.sh | bash
```

安装后提供：

```bash
claudium                 # 交互式 REPL
claudium-bypass          # bypassPermissions 模式
claudium -p "..."        # 单次执行
```

## 手动构建

```bash
bun install
bun run build            # ./claudium-cli
bun run compile          # ./dist/claudium-cli
bun run dev              # 从源码运行
```

在此快照基础上修复的实验性 feature 可通过 `--feature=NAME` 临时追加；完整审计见 [FEATURES.md](FEATURES.md)。

## API 配置

**这是最基础的配置，其余的配置可通过 `/config` 或与 Claudium 对话来访问。**

Claudium 是一个对非 Anthropic 模型友好的 Claude Code Fork，你可以搭配任何支持 tool call 的模型来使用。

推荐使用 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 这样的路由来访问你的所有模型。

使用 Anthropic Messages API：

```bash
export ANTHROPIC_BASE_URL="your-api-endpoint"
export ANTHROPIC_API_KEY="sk-ant-..."
```

Claudium 不提供 claude.ai OAuth 登录。

## 模型与 effort

`settings.json` 支持为主模型、subagent 和 advisor 分别配置 model、context window 与 reasoning effort。

```json
{
  "modelProfiles": {
    "main": {
      "model": "your-model-id",
      "contextWindowTokens": 262144,
      "reasoningEffort": "high"
    }
  },
  "webSearch": {
    "effort": "low"
  },
  "sessionTitle": {
    "effort": "none"
  },
  "promptSuggestion": {
    "effort": "low"
  }
}
```

也可以使用 `/model  [model] [context] [effort]` 来快速切换模型。

其中：

```
webSearch.effort 用于搜索摘要和结果重排。
sessionTitle.effort 用于会话标题生成；
```

这些辅助任务未配置独立 effort 时继承当前主请求的 effort/thinking 配置；显式配置后才使用自己的 thinking block 配置。三者均可在 `/config` 编辑；显式配置 Prompt suggestion 后，可能不再复用主请求缓存。

全局 `CLAUDE_CODE_EFFORT_LEVEL` 环境变量仍将覆盖这些配置。

## AntiRep / Reasoning Loop Guard

AntiRep 在消费 Anthropic Messages SSE 时实时检测病态复读。该功能**默认关闭**，不会修改模型采样参数。可在 `settings.json` 中启用：

```json
{
  "antiRepetition": {
    "enabled": true,
    "autoResume": true,
    "maxRecoveries": 2,
    "maxCyclePeriod": 512,
    "cycleMinChars": 512,
    "lineRepeatedMinChars": 2048,
    "lineCoverageMin": 0.6,
    "lineConcentrationMin": 4
  }
}
```

- AntiRep 只检测 thinking/reasoning 输出。尾部字符周期至少重复三次才会命中；有界短语池还可识别顺序不断变化的重复行。对代码、JSON、XML 和 Markdown 表格等结构化内容采取保守排除。
- 命中后关闭当前上游流，报告 `REASONING_LOOP`，不会误标为 token 用尽或用户取消。本次失败的 assistant 内容会从有效历史撤销，不回放残缺 thinking 或无效签名。
- `/config` 的 `AntiRep settings` 子菜单提供总开关、Auto-resume 与恢复次数设置；修改在下一条 query 生效。Auto-resume 对应 **`antiRepetition.autoResume`**，不是全局自动续跑开关，不影响 `max_output_tokens` 或 token budget。检测阈值可在 `settings.json` 中调整。
- 恢复通过一条 meta 指令继续**原本未完成的任务**，不从头重做。默认最多连续自动恢复两次；成功且配对的工具结果会重置连续恢复计数。设置 `autoResume: false` 或 `maxRecoveries: 0` 可仅检测、不恢复。
- 本请求一旦出现工具调用起始事件、流式工具 JSON 或完整工具调用，就禁用 Guard。这优先保障工具安全，代价是无法熔断工具启动后出现的复读。用户取消始终优先于自动恢复。
- 适用于交互 CLI、`-p`、SDK 与 agent 请求；不作用于压缩、标题、建议等辅助请求。每条 query/subagent 独立维护检测状态与恢复配额。
- SDK 与 `--output-format stream-json` 消费者需要处理新增的 `system` / `stream_reset` 消息：清除被中断的 partial response，并撤销 `withdrawn_message_ids`。无法处理撤销的旧客户端应保持 AntiRep 关闭。
- 中断请求可能收不到最终 usage。SDK 仅累计实际收到的 usage，不虚构剩余 token。诊断只包含规则与计数，不记录原始 reasoning。

该功能只监测流式输出，不扫描或中断非流式 fallback 响应。阈值需要在检测延迟与误判之间取舍；保守的结构化排除也可能漏掉结构内部的复读。

## Advisor

Advisor 是本 fork 的独特特性，它是用于难题协助和风险检查的只读模型。

它通过 tool call 调用。可以分析当前会话上下文、代码和搜索结果，但不能直接修改。它适合检查架构、边界条件、安全问题和复杂调试决策。

通过 `settings.json` 或环境变量配置模型：

```json
{
  "modelProfiles": {
    "advisor": {
      "model": "your-review-model-id"
    }
  },
  "advisorPreference": "default"
}
```

也可以使用 `CLAUDE_CODE_ADVISOR_MODEL`。

`advisorPreference` 支持 `default`、`prefer` 和 `atUserDemand`：分别表示在重要决策时使用、优先在实质性任务前使用、以及仅在用户明确要求时使用。未配置 Advisor 模型时，该功能关闭。

## SearXNG WebSearch

设置以下变量后，内置 WebSearch 会使用你部署的 SearXNG 实例：

```bash
export CLAUDE_CODE_SEARXNG_BASE_URL=http://localhost:8888/
```

该路径保留 WebSearch 工具契约，并支持：

- `allowed_domains` / `blocked_domains` 以及 `settings.json` 中的持久化域名规则
- 结果分页、去重和本地过滤
- 仅在 SearXNG 路径启用的来源指导与 LLM rerank
- 对来源优先级、来源冲突和引用编号的搜索摘要指导

未设置 SearXNG 时，WebSearch 使用默认 provider 行为。

**请注意，此功能高度依赖 SearXNG 的搜索质量，实际效果与在线 API 可能有差距。Claudium 尽力优化了搜索结果。**

## 隐私与安全边界

- 内置 analytics、GrowthBook 和遥测上报实现已 stub。Claudium 只链接 Anthropic Marketplace。
- claude.ai OAuth 登录、远程控制、远程环境和相关云服务 CLI 入口已移除或禁用；认证改为本地 Anthropic Messages API 端点。
- cyber-risk prompt 不再从 CLI 注入。

## License

原始 Claude Code 源码属于 Anthropic。

本项目是基于公开 npm source snapshot 的个人 fork。Uses On Your Own Risk。
