# Jev による NNS 判定と自動投票

状態: DONE — Wiki-backed Worker・Forum evidence収集・テスト・運用文書を実装済み。デプロイ、外部 API の実呼出し、本番投票、有効化は未実施。
対象: `feat/nns-proposal-reviews` / 基点 `37090346`

## 目的

NNS 提案レビュー Worker の判断処理を DeepSeek から Jev に置き換え、明示的に設定した投票方針と提案種別について自動投票する。Wiki に証拠、判定項目、方針の版、投票結果を残し、判断から実行まで追跡できるようにする。

成功は単なる既存モデルとの一致率では測らない。必要な証拠を使った正しい賛否、証拠不足での保留、送信結果の確実な照合を評価する。

## 現状と変更範囲

- `nns-index.ts` / `nns-audit.ts`: 1日1回のCron、Dashboard API による検出、Forum・参照 URL 取得、生成、公開。
- `nns-review.ts`: DeepSeek の自由文 JSON を検証し、Markdown に変換。Jev はこの自由文契約を満たせないので専用の判定契約へ変更する。
- `nns-jobs.ts`: WikiノードとETagによるリース、入力・生成物のcheckpoint、公開再試行。
- `/Knowledge/nns/system/discovery-state.md`と各提案の`workflow.md`: discoveryと処理状態の正本。
- 原提案は初回 Dashboard snapshot のみ。投票前の Governance 状態確認、投票鍵、送信・照合は未実装。
- 一般の Wiki Generator は引き続き DeepSeek を使用する。NNS の切り替えで一般生成を変更しない。
- 既存レビューは維持し、新判定・投票記録は別パスに追加する。過去の生成物を新形式へ暗黙変換しない。

## 採用する設計

### 証拠と方針

Dashboard は検出に使用する。判断の対象となる proposal ID、action、payload は Governance から取得したデータと照合する。認証付き状態確認の具体的方法は実装前に公式 Candid と query/update の保証を確認し、Dashboard データを暗号学的証明と表記しない。

提案種別ごとに必要証拠を定義する。アップグレードならコード・ビルド・ハッシュ等の検証を別途用意し、提案文を読めたことを検証完了と扱わない。未対応種別、欠落・切詰め・取得失敗は自動投票対象外。

投票方針の正本は `/Knowledge/nns/autovote-policy.md` とする。Wiki DB の writer を v1 の方針管理者として信頼し、保存された有効な変更は次の判断から反映する。参照資料内の命令を方針として取り込まない。

### Jev 判定

追加 SDK は必須にせず、専用 HTTP client で `POST /v1/systemone` を呼ぶ。Choice/Noul/Score の応答を実行時検証し、有限数、範囲、必須項目、既知選択肢を確認する。429/529、タイムアウト、無効応答は既存の有界な再試行と保留へ接続する。NNS 用 DeepSeek fallback は設けない。

独立した問いの例:

- 提案の説明は実行 payload と整合するか。
- 指定した必須証拠が主張を裏づけるか。
- 明示した方針の禁止条件に該当するか。
- 適用条件、単位、基準値に重要な不明点があるか。

数値比較、期限、ハッシュ一致、許可リストはコードで判定する。Jev の confidence を正答率と同一視しない。閾値は評価で定め、未設定なら投票しない。

コードで `ADOPT / REJECT / HOLD` を決定する。必要条件の全充足で ADOPT、明示した拒否条件への該当で REJECT、証拠不足や判断の競合は HOLD。保留は投票しない状態であり、NO や架空の棄権票へ変換しない。

判定記録には入力証拠の ID/hash、policy version/hash、質問セットの版、要求・応答モデル ID、各確率、コード側判定理由を含める。`jev-latest` が可変なら固定版の提供有無を確認し、更新時に再評価する。完全な再現性を保証すると記載しない。

### Wiki 公開

判定項目・コードの理由・証拠リンクからテンプレートで表示する。生成 LLM の自由文理由を投票条件にしない。

`/Knowledge/nns/proposals/<id>/decision.md` と `vote.md` に現在の決定・投票状態を公開する。decision ID は対象証拠と方針・モデル応答に結びつける。既存 `review.md` は人向け説明として保持する。Wiki は管理者が編集できる公開記録であり、改ざん不能とは表記しない。

### 投票実行

判定 Worker から署名機能を分離した投票 Worker を用意する。共有コードは必要最小限にする。既存 Wiki 書き込み鍵は流用せず、専用 hotkey を用いる。hotkey は投票以外の権限も持つため、実行 API は allowlist 済み neuron の RegisterVote のみに限定する。

投票前に proposal/payload の対応、対象 neuron の投票資格、現在の投票受付状態・期限、既存 ballot、方針有効状態を確認する。既存 following による投票も照合し、following 設定を自動変更しない。

投票意図を提案ごとの`vote.md`に先に永続化する。単一neuron v1では提案ごとにパスを一意化し、ETagのリースとCASで複数Workerによる同時実行を防ぐ。

状態案: `planned → submitting → confirmed`。曖昧な結果は `unknown` として照合し、確認不能なまま別の票を送らない。安全に再送できる条件は Governance の実際の応答・重複処理を確認して定義する。別経路で既に投票された場合は observed/conflict として記録する。`held / expired / failed` を区別する。

投票送信前に`submitting`をWikiへ保存する。送信後のWiki更新が失敗しても、再配信はballot照合だけを行い再投票しない。停止スイッチは未送信票を停止するが、送信済み票の取消を約束しない。

## 実装順序と完了条件

1. **契約と評価データ**: 正式な NNS Candid、投票・following・期限の仕様、Jev API の利用可否と入力上限を確認。対象種別の証拠要件と判定スキーマを定義する。当時の証拠だけで過去提案の評価セットを作り、人によるラベルと保留理由を付ける。最終可決結果を正解ラベルにしない。
2. **Jev によるレビュー**: Forumと参照資料を先にWikiへ固定して`evidence.md`へ整理し、そのbundleを`nns-jev.ts`へ渡す。専用secret/configとWiki checkpointを実装し、切り替え時にQueueをdrainする。
3. **投票しない運用**: 実提案に対して判定と予定票だけを記録。誤賛成・誤反対・保留率、判定安定性、費用、遅延を DeepSeek 基準と比較する。開発用と評価用を分け、種別ごとに閾値を決める。
4. **投票実行部**: 上記の独立 Worker、Governance client、状態遷移、一意制約、送信照合、停止機能を追加。fake Governance と障害注入で検証し、本番送信は無効を初期値とする。
5. **限定有効化**: ユーザーが確定した neuron・対象種別・方針版と評価合格条件で有効化。実投票後は Governance の ballot と公開記録を照合する。対象拡大は追加評価後に行う。

## 必須検証

- Jev 応答欠落、未知選択肢、不正確率、429/529、タイムアウト。
- 証拠欠落・切詰め、payload 不整合、禁止条件、矛盾する判定、資料中の命令による方針変更の試み。
- 方針変更後の古いジョブ、無効化、入力 hash の不一致。
- Queue 重複・並行処理、署名前後のクラッシュ、送信成功後の応答喪失、Wiki ETag競合・書込み失敗。
- 他経路/following での投票済み、締切変動、投票資格なし、停止後の未送信ジョブ。
- 投票済み・Wiki 未公開からの回復で再投票しないこと。
- 一般 Wiki Generator と既存 NNS 公開処理の回帰。

実装時の基本チェック:

```sh
pnpm --dir workers/wiki-generator typecheck
qrun -- pnpm --dir workers/wiki-generator test
qrun -- pnpm --dir workers/wiki-generator test:worker:nns
qrun -- pnpm --dir workers/wiki-generator build:nns
```

新投票 Worker には対応する runtime test / dry-run build を追加する。有料 API 評価と本番投票は通常テストに含めない。

## 本番有効化までの未確定事項

- 対象 neuron と hotkey の管理主体、既存 following との運用関係。
- 最初に自動化する提案種別と、実際の賛否を決める投票方針。
- 種別ごとの許容誤判定率・必要評価件数・保留時の対応・投票タイミング。
- Jev early access、利用上限、モデル版固定、実データでの品質。

これらは実装の読み取り・試験設計を止める理由ではない。ただし未確定のまま実投票は有効化しない。この計画作成は本番投票の承認ではない。

## 参考

- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/confidence
- https://docs.internetcomputer.org/concepts/governance/
- https://docs.internetcomputer.org/references/nns-proposal-types/
