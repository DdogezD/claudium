# Claudium

Claudium 是一个终端原生的 AI coding agent。它保留 Claude Code 的本地 CLI 工作流，移除上游 OAuth、远程控制、遥测和自动更新相关服务，使用你配置的 Anthropic API endpoint。

## 安装

要求：Bun `>=1.3.11`、Git、ripgrep；支持 macOS、Linux 和 WSL。

```bash
curl -fsSL https://raw.githubusercontent.com/DdogezD/claudium/main/install.sh | bash
```

安装后提供：

```bash
claudium                 # 交互式 REPL
claudium-bypass          # bypassPermissions 模式
claudium -p "..."       # 单次执行
```

## 本地构建

```bash
bun install
bun run build            # ./claudium-cli
bun run compile          # ./dist/claudium-cli
bun run dev              # 从源码运行
```

默认构建使用当前 Claudium feature preset。实验性 feature 可通过 `--feature=NAME` 临时追加；完整审计见 [FEATURES.md](FEATURES.md)。

## API 配置

使用 Anthropic Messages API：

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

也可以通过 `ANTHROPIC_BASE_URL` 使用兼容 Anthropic Messages API 的 endpoint，并配合 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` 完成认证。

Claudium 不提供 claude.ai OAuth 登录，认证完全由本地环境中的 API key、token 和 endpoint 配置决定。

## 模型与 effort

`settings.json` 支持为主模型、subagent 和 advisor 分别配置 model、context window 与 reasoning effort。辅助任务默认不继承主任务 effort，而是使用 `none`：

```json
{
  "modelProfiles": {
    "main": {
      "model": "your-model-id",
      "contextWindowTokens": 131072,
      "reasoningEffort": "high"
    }
  },
  "webSearch": {
    "effort": "low"
  },
  "sessionTitle": {
    "effort": "none"
  }
}
```

`webSearch.effort` 用于搜索摘要和结果重排，`sessionTitle.effort` 用于会话标题生成；两者均可在 `/config` 编辑，默认 `none` 关闭 thinking block，其他值原样透传并启用模型支持的 thinking。它们不继承 model profile 的 effort，但全局 `CLAUDE_CODE_EFFORT_LEVEL` 环境变量仍优先。

## Advisor

Advisor 是用于方案审查和风险检查的只读辅助模型，可以分析当前会话上下文、代码和搜索结果，但不能直接修改文件。它适合检查架构、边界条件、安全问题和复杂调试决策。

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

也可以使用 `CLAUDE_CODE_ADVISOR_MODEL`。`advisorPreference` 支持 `default`、`prefer` 和 `atUserDemand`：分别表示在重要决策时使用、优先在实质性任务前使用、以及仅在用户明确要求时使用。未配置 Advisor 模型时，该功能关闭。

## SearXNG WebSearch

设置以下变量后，内置 WebSearch 会使用自己的 SearXNG 实例：

```bash
export CLAUDE_CODE_SEARXNG_BASE_URL=http://localhost:8888/
```

该路径保留 WebSearch 工具契约，并支持：

- `allowed_domains` / `blocked_domains` 以及 `settings.json` 中的持久化域名规则
- 结果分页、去重和本地过滤
- 仅在 SearXNG 路径启用的来源指导与 LLM rerank
- 对来源优先级、来源冲突和引用编号的搜索摘要指导

未设置 SearXNG 时，WebSearch 使用默认 provider 行为；SearXNG 质量层不会介入。域名规则可通过 `/config` → **Domain rules (search · fetch · sandbox)** 编辑。

## 隐私与安全边界

- 内置 analytics、GrowthBook 和遥测上报实现已 stub 化，正常启动路径不提供有效的上报；源码仍保留部分 OpenTelemetry/OTLP 兼容接口和 tracing 代码，因此不宣称删除了所有 OTel 依赖。
- claude.ai OAuth 登录、远程控制、远程环境和相关云服务 CLI 入口已移除或禁用；认证改为本地 API key/token 与 Anthropic-compatible endpoint。
- 专门的 cyber-risk prompt 指令不再由 CLI 注入；这不等于关闭模型自身的安全策略。
- system reminders、prompt-injection 提示、安全编码要求和高风险操作确认仍然保留。
- 工具权限规则、用户确认、PermissionRequest hooks、sandbox 隔离和部分 bypass-immune safety checks 仍然生效；`claudium-bypass` 不是无条件关闭全部防护。

## 设计边界

Claudium 不保证搜索结果天然可靠。SearXNG 返回的来源质量取决于实例配置和上游搜索引擎；rerank 与来源指导用于降低垃圾、冲突和聚合转载对最终摘要的影响，但不会替代人工核验。

## License

原始 Claude Code source 属于 Anthropic。本项目是基于公开 npm source snapshot 的个人 fork，按你自己的风险使用。
