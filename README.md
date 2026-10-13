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

`webSearch.effort` 同时控制 WebSearch 摘要和结果重排子查询的 thinking block：未设置时关闭 thinking；设置后按原值发送 effort 并启用 thinking。`/config` 可编辑该设置。

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

## 设计边界

Claudium 不保证搜索结果天然可靠。SearXNG 返回的来源质量取决于实例配置和上游搜索引擎；rerank 与来源指导用于降低垃圾、冲突和聚合转载对最终摘要的影响，但不会替代人工核验。

## License

原始 Claude Code source 属于 Anthropic。本项目是基于公开 npm source snapshot 的个人 fork，按你自己的风险使用。
