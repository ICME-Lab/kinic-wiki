# Wiki Canonicality Policy

この文書は、この repo の current wiki schema を定義する repo-local policy。

- skill には一般原則だけ置く
- current note 名と責務はここに置く
- schema が変わったら、この文書を正本として更新する

## Current Principles

- `/Sources/raw/...` が原資料正本
- `/Wiki/...` は整理済み知識面
- raw transcript を `/Wiki/...` の正本として重複保持しない
- exact evidence と recap を混ぜない
- unresolved state を settled fact として昇格しない

## Current Note Roles

- `facts.md`
  - 確定した stable fact と stable attribute
  - topic-only mention、曖昧情報、未解決事項は置かない
- `events.md`
  - 起きた事実の時系列
  - 解釈や要約は置かない
- `plans.md`
  - 予定、意図、次アクション
  - scope 固有の明示指示、一時的な制約、運用方針
- `preferences.md`
  - 嗜好、判断基準、選好
- `open_questions.md`
  - 未解決事項、要確認事項、競合情報
- `summary.md`
  - 人間向け recap
  - exact evidence source にしない
- `provenance.md`
  - raw source id / path / import metadata / 参照位置

## Current Anti-Rules

- `facts.md` に topic-only line を入れない
- `summary.md` に exact fact、causal claim、resolution claim を入れない
- unresolved contradiction を settled note に入れない
- raw transcript を `/Wiki/...` に正本として複製しない
