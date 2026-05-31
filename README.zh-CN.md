[English](README.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Español](README.es.md)

# cc-costline

为 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 打造的增强状态栏 — 在终端中显示费用追踪、使用限额和排行榜排名。

![cc-costline 截图](screenshot.png)

```
14.6k ~ $2.42 / 40% by Opus 4.6 | 5h: 45% / 7d: 8% | 30d: $866 | #2/22 $67.0
```

## 安装

```bash
npm i -g cc-costline && cc-costline install
```

打开一个新的 Claude Code 会话即可看到增强状态栏。需要 Node.js >= 22。

### 升级

npm 不会自动更新全局包。想升级到最新版本时手动运行：

```bash
npm i -g cc-costline@latest
```

## 功能一览

| 模块 | 示例 | 说明 |
|------|------|------|
| Token ~ 费用 / 上下文 | `14.6k ~ $2.42 / 40% by Opus 4.6` | 会话 token 数量、费用、上下文使用率和模型 |
| 使用限额 | `5h: 45% / 7d: 8%` | Claude 5 小时和 7 天使用率（颜色同上下文）。达到 100% 时显示倒计时：`5h:-3:20` |
| 周期费用 | `30d: $866` | 滚动费用合计（可配置：7d、30d 或 both） |
| 排行榜 | `#2/22 $67.0` | [ccclub](https://github.com/mazzzystar/ccclub) 排名（需安装） |

### 颜色规则

- **上下文和使用限额** — 绿色（< 60%）→ 橙色（60-79%）→ 红色（≥ 80%）
- **排行榜排名** — 第 1 名金色，第 2 名白色，第 3 名橙色，其余青色
- **周期费用** — 黄色

### 可选集成

- **Claude 使用限额** — 自动从 macOS 钥匙串读取 OAuth 凭证。只需 `claude login` 即可。
- **ccclub 排行榜** — 安装 [ccclub](https://github.com/mazzzystar/ccclub)（`npm i -g ccclub && ccclub init`），排名自动显示。

两者均为零配置：不可用时对应模块静默隐藏。

## 命令

```bash
cc-costline install              # 设置 Claude Code 集成
cc-costline uninstall            # 从设置中移除
cc-costline refresh              # 手动重新计算费用缓存
cc-costline config --period 7d   # 显示 7 天费用（默认）
cc-costline config --period 30d  # 显示 30 天费用
cc-costline config --period both # 同时显示两个周期
```

## 工作原理

1. `install` 配置 `~/.claude/settings.json` — 设置状态栏命令并添加会话结束 hook。你的现有设置会被保留。
2. `render` 在每次对话时被 Claude Code 调用，约 65 ms 返回。它只读三份缓存（不发起 HTTP，不扫描全目录）：
   - **本地费用** → `~/.cc-costline/cache.json`
   - **使用率** → `/tmp/sl-claude-usage`
   - **ccclub 排名** → `/tmp/sl-ccclub-rank`
3. 任一缓存过期时，`render` 启动 detached 子进程 `cc-costline refresh-bg` 在后台刷新。`/tmp/sl-refresh.lock` 防止多个 Claude Code 窗口并发刷新，`/tmp/sl-refresh.last` 限制 30 秒内最多触发一次。
4. 后台刷新遵守各数据源各自的 TTL：
   - **本地费用**（2 分钟 TTL）：增量扫描 — 按文件 `mtime+size` 缓存，未变更的文件直接复用（1000+ jsonl 时典型 25 ms vs 冷启动 2 s）
   - **使用率**（5 分钟重试，感知 token 轮换）：从 `api.anthropic.com/api/oauth/usage` 获取。检测 OAuth token 轮换后立即重试（新 token 有新的速率配额）。API 失败时保留历史数据。
   - **ccclub 排名**（90 秒重试）：从 `ccclub.dev/api/rank` 获取
5. `refresh` 可手动运行以重新计算本地费用缓存；会话结束 hook 使用 `refresh-bg` 预热全部缓存，避免阻塞 Claude Code。

<details>
<summary>定价表</summary>

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

## 许可证

MIT
