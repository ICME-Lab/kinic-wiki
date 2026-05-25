# Kinic Wiki Operations Playbook

この文書は、Kinic Wiki を個人作業で使うための運用入口。

Wiki は自動正答エンジンではなく、作業記憶、根拠確認、報告素材として使う。note schema の正本は `WIKI_CANONICALITY.md`。

## 基本方針

- 回答前に必要な note を読む。
- 回答には実際に読んだ source note を添える。
- 不確かな場合は「Wiki 上はここまで」と明示する。
- 作業後は決定、current value、selected option、安定した preference を Wiki に戻す。
- 矛盾、不明点、要確認事項は `open_questions.md` に残す。
- `facts.md` には current value と確定事実だけ置く。

## 使い分け

| 目的 | 使う skill | 使う場面 |
| --- | --- | --- |
| 過去文脈の確認 | `kinic-wiki-query` | 作業前、回答前、報告前 |
| 新しい事実の反映 | `kinic-wiki-ingest` | 作業後、決定後、資料取り込み後 |
| 構造と note role の点検 | `kinic-wiki-lint` | 週次、大きな ingest 後、違和感がある時 |

## 作業前の query

`kinic-wiki-query` は、過去決定、好み、関連事実、報告素材を確認するために使う。

向いている用途:

- 前に決めた方針の確認
- ユーザーや案件ごとの preference 確認
- ブランチ変更や作業経緯の要約
- 上申資料、報告文、議事メモの素材抽出
- 矛盾や未確定事項の洗い出し

運用規則:

- `index.md` から入り、質問形に合う canonical note を読む。
- exact fact は `facts.md`、時系列は `events.md`、予定や pending は `plans.md`、嗜好は `preferences.md`、矛盾は `open_questions.md` を優先する。
- `summary.md` は recap 補助として使い、exact evidence source にしない。
- search は direct note read で足りない時だけ使う。

## 作業後の ingest

`kinic-wiki-ingest` は、作業結果を review-ready な Wiki 更新として残すために使う。

残すもの:

- 決定事項
- current value
- selected option
- 安定した preference
- stable relationship / duration
- 未解決の contradiction / verification-needed

残さないもの:

- ただの会話 residue
- 感謝、相槌、自己励まし
- topic-only mention
- exact evidence のない recap
- `facts.md` への future / pending / chronology-only event

作業後の最小チェック:

- `facts.md` に current value があるか
- old value だけ残っていないか
- `open_questions.md` に矛盾が隠れず残っているか
- `log.md` が append-only で更新されているか

公開 Wiki の `open_questions.md` は読者向けの要検証事項だけに使う。解決済みの質問は `facts.md`、`plans.md`、または repo docs に移し、公開不要な内部実装論点は公開 Wiki から削除する。

現行判断:

- Self DB seed は既存の `write_nodes` を使う。
- URL ingest / draft generation を使う DB では default LLM writer principal を `writer` のままにする。
- raw 正本は `/Sources/raw/...` に置き、`/Wiki/...` には短い evidence span / recap だけを残す。

## Code Notes

Wiki はコード正本ではない。実装の正本は常に repo の実ファイル。

code note に残すもの:

- source path
- crate / module の責務
- 設計判断
- 判断理由
- 検証コマンドと結果要約
- follow-up
- open questions

code note に残さないもの:

- コード本文
- 長い diff
- 生成物
- schema dump
- README や generated docs のコピー
- すぐ変わる内部詳細

推奨形:

```md
## Source of Truth

- Implementation: `crates/...`
- Tests: `cargo test ...`

## Current Decision

- ...

## Why

- ...

## Verification

- ...

## Follow-up

- ...
```

snippet は原則使わない。必要な場合も短い例示に留め、正本ではないと明記する。

## 定期 lint

`kinic-wiki-lint` は report-only を基本にする。

実行タイミング:

- 週1
- 大きな ingest 後
- `facts.md` が薄い、または雑多に見える時
- current value が不明な時
- `summary.md` が exact evidence source として使われ始めた時

見るべき finding:

- stable exact fact が `facts.md` に無い
- current value が `facts.md` に明示されていない
- `facts.md` に future / pending / chronology-only event / recap prose が混ざっている
- exact evidence が `summary.md` に漏れている
- unresolved state が settled note に混ざっている

修正は user が明示した時だけ行う。

## 注意用途

以下は Wiki だけで断定しない。

- 日付計算
- 複数 note をまたぐ最終判断
- old value / new value が混ざる状態の最新値判定
- gold span 的な exact QA
- 外部状況や最新情報が関係する質問

この場合は、source note を示したうえで確認前提にする。

## 日常 cadence

- 作業前: 必要なら `query`
- 作業中: 重要な決定や不明点をメモ
- 作業後: `ingest` で決定と current value を反映
- 週次: `lint` で canonicality を確認
