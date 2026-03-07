[English](README.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Español](README.es.md)

# cc-costline

为 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 打造的增强状态栏 — 在终端中显示费用追踪、使用限额、智谱用量和排行榜排名。

![cc-costline 截图](img/status-zhipu.png)

```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 / ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228
```

## 安装

```bash
npm i -g cc-costline && cc-costline install
```

打开一个新的 Claude Code 会话即可看到增强状态栏。需要 Node.js >= 22。

## 功能一览

| 模块 | 示例 | 说明 |
|------|------|------|
| Token ~ 费用 / 上下文 | `526.3k ~ $16.3 / 57% glm-4.7` | 会话 token 数量、费用、上下文使用率和模型 |
| 使用限额 | `5h: 27%` | Claude 5 小时使用率（颜色同上下文） |
| 周期费用 | `7d: $137` 或 `30d: $246` | 本地计算的滚动费用（可配置：none/7d/30d/both） |
| 智谱用量 | `ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228` | 智谱 24h 用量、5h 配额、MCP 月度使用、本月累计 |
| 排行榜 | `#2/22 $67.0` | [ccclub](https://github.com/mazzzystar/ccclub) 排名（需安装） |

### 状态栏示例

#### 默认配置（period=7d, showResetTime=false）
```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 / ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228
```

#### 最小配置（period=none, showZhipu=false）
```
526.3k $16.3 · 57% glm-4.7 / 5h:27%
```

#### 完整配置（period=both, showResetTime=true）
```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 · 30d:$246 / ZHIPU:124.0M ~ $74.4 · 5h:27% (17:16) · MCP:10/100 · M:380.5M ~ $228
```

#### 配额超限（5h > 100%）
```
526.3k $16.3 · 57% glm-4.7 / ZHIPU:124.0M ~ $74.4 · 5h:2:30 · MCP:10/100 · M:380.5M ~ $228
```
→ `5h:2:30` 显示距离刷新的倒计时（2 小时 30 分钟）

### 智谱用量详情

| 显示项 | 示例 | 说明 |
|--------|------|------|
| 24 小时模型用量 | `ZHIPU:124.0M ~ $74.4` | 24 小时 Token 总量和预估成本 |
| 5 小时配额 | `5h:27%` 或 `5h:2:30` | 5 小时 Token 使用率，≥100% 时显示倒计时 |
| MCP 月度使用 | `MCP:10/100` | MCP 工具月度调用次数（search-prime + web-reader + zread） |
| 本月累计 | `M:380.5M ~ $228` | 从 1 号到今天的累计 Token 和成本 |

### 颜色规则

- **上下文和使用限额** — 绿色（< 60%）→ 橙色（60-79%）→ 红色（≥ 80%）
- **排行榜排名** — 第 1 名金色，第 2 名白色，第 3 名橙色，其余蓝色
- **周期费用** — 黄色

### 可选集成

- **Claude 使用限额** — 自动从 macOS 钥匙串读取 OAuth 凭证。只需 `claude login` 即可。
- **智谱用量查询** — 自动从 `~/.claude/settings.json` 读取 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL`（智谱兼容配置）。
- **ccclub 排行榜** — 安装 [ccclub](https://github.com/mazzzystar/ccclub)（`npm i -g ccclub && ccclub init`），排名自动显示。

三者均为零配置：不可用时对应模块静默隐藏。

## 命令

```bash
cc-costline install              # 设置 Claude Code 集成
cc-costline uninstall            # 从设置中移除
cc-costline refresh              # 手动重新计算费用缓存

# 配置显示周期
cc-costline config --period none   # 不显示 7d/30d 成本
cc-costline config --period 7d     # 只显示 7 天成本
cc-costline config --period 30d    # 只显示 30 天成本
cc-costline config --period both   # 同时显示 7 天和 30 天成本

# 智谱用量配置
cc-costline config --zhipu true    # 显示智谱用量（默认）
cc-costline config --zhipu false   # 隐藏智谱用量
cc-costline config --reset-time true   # 显示 5h 配额刷新时间
cc-costline config --reset-time false  # 不显示刷新时间（默认）
```

## 工作原理

1. **install** 配置 `~/.claude/settings.json` — 设置状态栏命令并添加会话结束 hook 以自动刷新。你的现有设置会被保留。
2. **render** 读取 Claude Code 的 stdin JSON 和费用缓存，输出格式化的状态栏。
3. **refresh** 扫描 `~/.claude/projects/**/*.jsonl`，提取 token 用量，按模型定价计算，写入 `~/.cc-costline/cache.json`。
4. **Claude 使用率**从 `api.anthropic.com/api/oauth/usage` 获取，60 秒文件缓存于 `/tmp/sl-claude-usage`。
5. **智谱用量**从智谱 API 获取（`/api/monitor/usage/model-usage`、`/api/monitor/usage/quota/limit`），60 秒文件缓存于 `/tmp/sl-zhipu-usage`。
6. **ccclub 排名**从 `ccclub.dev/api/rank` 获取，120 秒文件缓存于 `/tmp/sl-ccclub-rank`。

<details>
<summary>Claude 模型定价表</summary>

每百万 token 价格（美元）：

| 模型 | 输入 | 输出 | 缓存写入 | 缓存读取 |
|------|-----:|-----:|---------:|---------:|
| Opus 4.6 | $5 | $25 | $6.25 | $0.50 |
| Opus 4.5 | $5 | $25 | $6.25 | $0.50 |
| Opus 4.1 | $15 | $75 | $18.75 | $1.50 |
| Sonnet 4.5 | $3 | $15 | $3.75 | $0.30 |
| Sonnet 4 | $3 | $15 | $3.75 | $0.30 |
| Haiku 4.5 | $1 | $5 | $1.25 | $0.10 |
| Haiku 3.5 | $0.80 | $4 | $1.00 | $0.08 |

未知模型按系列名称回退，默认使用 Sonnet 定价。

</details>

<details>
<summary>智谱模型定价表</summary>

每百万 token 价格（美元），来源 [LiteLLM](https://github.com/BerriAI/litellm)：

| 模型 | 输入 | 输出 | 缓存读取 |
|------|-----:|-----:|---------:|
| zai/glm-4.7 | $0.60 | $2.20 | $0.11 |
| zai/glm-4.6 | $0.60 | $2.20 | $0.11 |
| zai/glm-4.5-air | $0.20 | $1.10 | - |
| zai/glm-5 | $1.00 | $3.20 | $0.20 |

**注意**：成本计算统一使用输入价格（$0.60/M），不区分输入/输出 Token。

</details>

## 开发

```bash
npm test    # 构建 + 运行单元测试（node:test，零依赖）
```

## 卸载

```bash
cc-costline uninstall
npm uninstall -g cc-costline
```

## 致谢

- [ccclub](https://github.com/mazzzystar/ccclub) by 碎瓜 ([@mazzzystar](https://github.com/mazzzystar)) — Claude Code 好友排行榜
- [LiteLLM](https://github.com/BerriAI/litellm) — 统一模型定价数据库
- [智谱 AI](https://open.bigmodel.cn/) — GLM 模型服务

## 许可证

MIT
