[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Español](README.es.md)

# cc-costline

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 向けの拡張ステータスライン — コスト追跡、使用制限、リーダーボードランキングをターミナルに表示します。

![cc-costline スクリーンショット](screenshot.png)

```
14.6k $2.42 · 40% Opus 4.6 / 5h:45% · 7d:8% · 30d:$866 / #2 $67.0
```

## インストール

```bash
npm i -g cc-costline && cc-costline install
```

新しい Claude Code セッションを開くと、拡張ステータスラインが表示されます。Node.js >= 22 が必要です。

### アップデート

npm はグローバルパッケージを自動更新しません。最新版にアップグレードしたい時は手動で：

```bash
npm i -g cc-costline@latest
```

## 機能

| セグメント | 例 | 説明 |
|-----------|---|------|
| トークン / コスト / コンテキスト | `14.6k $2.42 · 40% Opus 4.6` | セッションのトークン数、コスト、コンテキスト使用率、モデル |
| 使用制限 | `5h:45% · 7d:8%` | Claude の 5 時間・7 日間の使用率（コンテキストと同じ色分け）。100% 到達時はカウントダウン表示：`5h:-03:20` |
| 期間コスト | `30d:$866` | ローリングコスト合計（7d、30d、または both で設定可能） |
| リーダーボード | `#2 $67.0` | [ccclub](https://github.com/mazzzystar/ccclub) ランキング（インストール時） |

### カラールール

- **コンテキスト・使用制限** — 緑（< 60%）→ オレンジ（60-79%）→ 赤（≥ 80%）
- **リーダーボードランク** — 1 位：ゴールド、2 位：ホワイト、3 位：オレンジ、その他：シアン
- **期間コスト** — イエロー

### オプション連携

- **Claude 使用制限** — macOS キーチェーンから OAuth 認証情報を自動で読み取ります。`claude login` するだけで動作します。
- **ccclub リーダーボード** — [ccclub](https://github.com/mazzzystar/ccclub) をインストール（`npm i -g ccclub && ccclub init`）すると、ランキングが自動表示されます。

どちらもゼロ設定：利用できない場合、該当セグメントは静かに非表示になります。

## コマンド

```bash
cc-costline install              # Claude Code 連携のセットアップ
cc-costline uninstall            # 設定から削除
cc-costline refresh              # コストキャッシュを手動再計算
cc-costline config --period 7d   # 7 日間のコストを表示（デフォルト）
cc-costline config --period 30d  # 30 日間のコストを表示
cc-costline config --period both # 両方の期間を表示
```

## 仕組み

1. `install` は `~/.claude/settings.json` を設定 — ステータスラインコマンドとセッション終了フックを追加します。既存の設定は保持されます。
2. `render` は毎ターン Claude Code から呼び出されます。Claude Code が提供する場合は stdin のトークン合計を読み、その後 3 つのキャッシュを読みます（HTTP もディレクトリ全スキャンも行いません）：
   - **ローカルコスト** → `~/.cc-costline/cache.json`
   - **使用率** → `<os.tmpdir()>/sl-claude-usage`
   - **ccclub ランキング** → `<os.tmpdir()>/sl-ccclub-rank`
3. キャッシュが期限切れの場合、`render` は detached サブプロセス `cc-costline refresh-bg` を起動してバックグラウンドで更新します。`<os.tmpdir()>/sl-refresh.lock` で複数 Claude Code ウィンドウ間の並行更新を防ぎ、`<os.tmpdir()>/sl-refresh.last` で 30 秒に 1 回までに制限します。
4. バックグラウンド更新は各ソースの TTL に従います：
   - **ローカルコスト**（2 分 TTL）：インクリメンタルスキャン — ファイル `mtime+size` でキャッシュし、変更のないファイルはそのまま再利用（1000+ jsonl で典型 25 ms vs コールド 2 s）
   - **使用率**（5 分リトライ、トークンローテーション検知）：`api.anthropic.com/api/oauth/usage` から取得。OAuth トークンのローテーションを検知して即座にリトライ（新トークン＝新レート制限枠）。API 失敗時も過去のデータを保持。
   - **ccclub ランキング**（90 秒リトライ）：`ccclub.dev/api/rank` から取得
5. `refresh` はローカルコストキャッシュの手動再計算に使用できます。セッション終了フックは `refresh-bg` を使い、Claude Code をブロックせずに全キャッシュをウォームアップします。

<details>
<summary>料金表</summary>

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

## ライセンス

MIT
