[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Español](README.es.md)

# cc-costline

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 向けの拡張ステータスライン — コスト追跡、使用制限、Zhipu GLM 使用量、リーダーボードランキングをターミナルに表示します。

![cc-costline スクリーンショット](img/status-zhipu.png)

```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 / ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228
```

## インストール

```bash
npm i -g cc-costline && cc-costline install
```

新しい Claude Code セッションを開くと、拡張ステータスラインが表示されます。Node.js >= 22 が必要です。

## 機能

| セグメント | 例 | 説明 |
|-----------|---|------|
| トークン ~ コスト / コンテキスト | `526.3k ~ $16.3 / 57% glm-4.7` | セッションのトークン数、コスト、コンテキスト使用率、モデル |
| 使用制限 | `5h: 27%` | Claude の 5 時間使用率（コンテキストと同じ色分け） |
| 期間コスト | `7d: $137` または `30d: $246` | ローカル計算コスト（設定可能：none/7d/30d/both） |
| Zhipu GLM 使用量 | `ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228` | 24時間使用、5h クォータ、月次 MCP、月次累計 |
| リーダーボード | `#2/22 $67.0` | [ccclub](https://github.com/mazzzystar/ccclub) ランキング（インストール時） |

### Zhipu GLM 使用量詳細

| 表示項目 | 例 | 説明 |
|---------|---|------|
| 24時間モデル使用量 | `ZHIPU:124.0M ~ $74.4` | 24 時間トークン合計と推定コスト |
| 5h クォータ | `5h:27%` または `5h:2:30` | 5 時間トークン使用率、100%超過時にカウントダウン表示 |
| MCP 月次使用 | `MCP:10/100` | MCP ツール月次呼び出し回数（search-prime + web-reader + zread） |
| 月次累計 | `M:380.5M ~ $228` | 1 日から当日までの累計使用量 |

### ステータスライン例

#### デフォルト（period=7d, showResetTime=false）
```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 / ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228
```

#### 最小構成（period=none, showZhipu=false）
```
526.3k $16.3 · 57% glm-4.7 / 5h:27%
```

#### 完全構成（period=both, showResetTime=true）
```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 · 30d:$246 / ZHIPU:124.0M ~ $74.4 · 5h:27% (17:16) · MCP:10/100 · M:380.5M ~ $228
```

#### クォータ超過（5h > 100%）
```
526.3k $16.3 · 57% glm-4.7 / ZHIPU:124.0M ~ $74.4 · 5h:2:30 · MCP:10/100 · M:380.5M ~ $228
```
→ `5h:2:30` はリセットまでのカウントダウンを表示（残り 2 時間 30 分）

### カラールール

- **コンテキスト・使用制限** — 緑（< 60%）→ オレンジ（60-79%）→ 赤（≥ 80%）
- **リーダーボードランク** — 1 位：ゴールド、2 位：ホワイト、3 位：オレンジ、その他：ブルー
- **期間コスト** — イエロー

### オプション連携

- **Claude 使用制限** — macOS キーチェーンから OAuth 認証情報を自動で読み取ります。`claude login` するだけで動作します。
- **Zhipu GLM 使用量** — `~/.claude/settings.json` から `ANTHROPIC_AUTH_TOKEN` と `ANTHROPIC_BASE_URL` を読み取ります（Zhipu 互換設定）。
- **ccclub リーダーボード** — [ccclub](https://github.com/mazzzystar/ccclub) をインストール（`npm i -g ccclub && ccclub init`）すると、ランキングが自動表示されます。

すべてゼロ設定：利用できない場合、該当セグメントは静かに非表示になります。

## コマンド

```bash
cc-costline install              # Claude Code 連携のセットアップ
cc-costline uninstall            # 設定から削除
cc-costline refresh              # コストキャッシュを手動再計算

# 表示期間の設定
cc-costline config --period none   # 7d/30d コストを非表示
cc-costline config --period 7d     # 7 日間コストのみ表示
cc-costline config --period 30d    # 30 日間コストのみ表示
cc-costline config --period both   # 7d と 30d の両方を表示

# Zhipu 使用設定
cc-costline config --zhipu true    # Zhipu 使用量を表示（デフォルト）
cc-costline config --zhipu false   # Zhipu 使用量を非表示
cc-costline config --reset-time true   # 5h クォータリセット時間を表示
cc-costline config --reset-time false  # リセット時間を非表示（デフォルト）
```

## 仕組み

1. **install** は `~/.claude/settings.json` を設定 — ステータスラインコマンドとセッション終了フックを追加します。既存の設定は保持されます。
2. **render** は Claude Code の stdin JSON とコストキャッシュを読み取り、フォーマットされたステータスラインを出力します。
3. **refresh** は `~/.claude/projects/**/*.jsonl` をスキャンし、トークン使用量を抽出、モデル別価格を適用して `~/.cc-costline/cache.json` に書き込みます。
4. **Claude 使用量**は `api.anthropic.com/api/oauth/usage` から取得され、60 秒のファイルキャッシュが `/tmp/sl-claude-usage` に保存されます。
5. **Zhipu GLM 使用量**は Zhipu API（`/api/monitor/usage/model-usage`、`/api/monitor/usage/quota/limit`）から取得され、60 秒のファイルキャッシュが `/tmp/sl-zhipu-usage` に保存されます。
6. **ccclub ランキング**は `ccclub.dev/api/rank` から取得され、120 秒のファイルキャッシュが `/tmp/sl-ccclub-rank` に保存されます。

<details>
<summary>Claude モデル料金表</summary>

100 万トークンあたりの価格（USD）：

| モデル | 入力 | 出力 | キャッシュ書込 | キャッシュ読取 |
|--------|-----:|-----:|-------------:|-------------:|
| Opus 4.6 | $5 | $25 | $6.25 | $0.50 |
| Opus 4.5 | $5 | $25 | $6.25 | $0.50 |
| Opus 4.1 | $15 | $75 | $18.75 | $1.50 |
| Sonnet 4.5 | $3 | $15 | $3.75 | $0.30 |
| Sonnet 4 | $3 | $15 | $3.75 | $0.30 |
| Haiku 4.5 | $1 | $5 | $1.25 | $0.10 |
| Haiku 3.5 | $0.80 | $4 | $1.00 | $0.08 |

不明なモデルはファミリー名でフォールバックし、デフォルトで Sonnet の価格が適用されます。

</details>

<details>
<summary>Zhipu GLM モデル料金表</summary>

100 万トークンあたりの価格（USD）、ソース [LiteLLM](https://github.com/BerriAI/litellm)：

| モデル | 入力 | 出力 | キャッシュ読取 |
|--------|-----:|-----:|--------------:|
| zai/glm-4.7 | $0.60 | $2.20 | $0.11 |
| zai/glm-4.6 | $0.60 | $2.20 | $0.11 |
| zai/glm-4.5-air | $0.20 | $1.10 | - |
| zai/glm-5 | $1.00 | $3.20 | $0.20 |

**注意**: コスト計算は入力価格を一律使用します（$0.60/M）、入力/出力トークンの区別はありません。

</details>

## 開発

```bash
npm test    # ビルド + ユニットテスト実行（node:test、依存関係なし）
```

## アンインストール

```bash
cc-costline uninstall
npm uninstall -g cc-costline
```

## 謝辞

- [ccclub](https://github.com/mazzzystar/ccclub) by 碎瓜 ([@mazzzystar](https://github.com/mazzzystar)) — Claude Code フレンドリーダーボード
- [LiteLLM](https://github.com/BerriAI/litellm) — 統一モデル価格データベース
- [Zhipu AI](https://open.bigmodel.cn/) — GLM モデルサービス

## ライセンス

MIT
