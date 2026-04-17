# AGENTS.md

**モットー:** 「小さく、明確で、安全なステップ。互換より単純さを優先する。」

## 原則

- 変更は最小限にする。常に安全で、すぐ元に戻せる形にする。
- トリッキーさより明確さ、複雑さよりシンプルさを優先する。
- 不要な新規依存は追加しない。
- 後方互換のための shim、fallback、旧データ救済、旧 schema 吸収ロジックは原則入れない。
- migration は明示的な version 管理を前提にし、未適用のものだけを 1 回適用する。
- 既存 DB や旧形式を自動吸収して延命する設計は採らない。必要なら破壊的変更として明示する。

## 実装方針

- app schema と search schema はどちらも versioned migration で管理する。
- `IF NOT EXISTS` に依存した schema 管理はしない。
- 正本と検索更新は同じ SQLite、同じ transaction にまとめる。
- 判断に迷う場合は、互換維持より構成の単純さを優先する。

## コミュニケーション

- ユーザー向けの説明は日本語で簡潔に書く。
- 互換を切る場合は、その理由と影響範囲を明示する。

## レビュー規約

- このリポジトリをレビューするときは、まず [`kinic-rust-review`](/Users/0xhude/Desktop/MyCLI/checker/skills/kinic-rust-review/SKILL.md) を読むこと。
- レビューでコマンドによる確認が必要な場合は、次に [`kinic-rust-verify`](/Users/0xhude/Desktop/MyCLI/checker/skills/kinic-rust-verify/SKILL.md) を使うこと。
- ローカルの lint、テスト、日常的なチェック手順が必要な場合は、[`kinic-dev-checks`](/Users/0xhude/Desktop/MyCLI/checker/skills/kinic-dev-checks/SKILL.md) を参照すること。

## ローカル補助

- ローカル専用の確認コマンドには [`lint.sh`](/Users/0xhude/Desktop/MyCLI/checker/lint.sh) と [`check.sh`](/Users/0xhude/Desktop/MyCLI/checker/check.sh) を使うこと。
- `/Users/0xhude/Desktop/MyCLI/checker/` はこのリポジトリ専用のメモと補助ファイルとして扱うこと。これらのリポジトリ専用スキルをグローバルなスキルディレクトリに置かないこと。

## ローカル編集ログ

- 実装作業の後は `/Users/0xhude/Desktop/MyCLI/checker/<repo名>/<current-branch>/edit.md` を更新すること。このファイルは決してコミットしない。
- 内容は抽象的かつ PR 向けに保ち、目的、振る舞い、実装概要、検証、フォローアップを書くこと。
- 手順ごとの作業メモや大きなコード抜粋には使わないこと。
