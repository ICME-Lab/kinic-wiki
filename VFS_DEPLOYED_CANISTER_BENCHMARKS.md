# VFS Deployed Canister Benchmarks

## 目的

この文書は、deploy 済み canister を `ic-agent` 経由で直接叩く benchmark の契約をまとめるものです。
host filesystem benchmark とは別系統の、API 契約ベースの計測として扱います。
README と validation docs では概要だけを扱い、この文書を deployed canister bench 契約の正本とします。

主評価は host filesystem 風 workload ではなく、実際に使う canister API operation 単位の:

- `cycles`
- `latency`
- `wire IO`

です。

## ベンチ系列

| Bench | 役割 | 主対象 |
| --- | --- | --- |
| `canister_vfs_workload` | API-centric repeated request bench | `create`, `update`, `append`, `edit`, `move_same_dir`, `move_cross_dir`, `delete`, `read`, `list`, `search`, `mkdir`, `glob`, `recent`, `multi_edit`（各 run の `raw/*.txt` に `openai_tool` / `openai_tool_variant` を併記） |
| `canister_vfs_latency` | single-update latency bench | `write_node`, `append_node` |

`query` は独立 method 名ではなく、文書上は `read / list / search / mkdir / glob / recent` の総称です。

## 固定条件

| Item | Value |
| --- | --- |
| Payload Sizes | `1k`, `10k`, `100k`, `1MB` |
| Workload File Count | `100` |
| Concurrency | `1` |
| Transport | `ic-agent` |
| Cycles Source | `icp canister status --json` |
| Update Cycles Scope | `isolated_single_op`（`multi_edit` を含む） |
| Query Cycles Scope | `isolated_single_op`（`read` / `list` / `search` / `glob` / `recent`） |
| Validation-only Query Scope | `scenario_total`（`mkdir`） |

`isolated_single_op` は setup phase と measure phase を分けて cycles を取り、measure phase では純粋な API 呼び出しだけを測ります。  
主指標は query/update を問わず `measured_cycles_delta` と `cycles_per_measured_request` です。  
`scenario_total` は `mkdir` のような setup 不要 scenario か、互換用の補助値としてだけ読みます。
`summary.txt` は scenario ごとに必要な cycles 項目だけを出します。`isolated_single_op` では measured 系、`scenario_total` では total 系だけを読みます。

update 系 API は benchmark 用に特別扱いせず、本番 API 契約のまま叩きます。  
ただし `write / append / edit / move / delete / multi_edit` の返り値は、現在は `Node` 全体ではなく軽量 ACK です。  
そのため `avg_response_payload_bytes` は update 後の node 本文サイズではなく、ACK の wire bytes を表します。

## 成果物

出力先:

- `.benchmarks/results/canister_vfs_workload/<timestamp>/`
- `.benchmarks/results/canister_vfs_latency/<timestamp>/`

各 run は次を必須にします。

- `summary.txt`
- `config.txt`
- `environment.txt`
- `raw/*.txt`

役割:

- `summary.txt`: 人間向け要約
  `timestamp` に加えて人間向けの `generated_at_utc` を含む
- `config.txt`: 真の設定値を JSON text で保存
- `environment.txt`: 実行環境を JSON text で保存
- `raw/*.txt`: scenario 単位の集計済み一次データを JSON text で保存

## 保存指標

各 scenario で次を残します。

- `measurement_mode`
- `setup_request_count`
- `measured_request_count`
- `cycles_before`
- `cycles_after`
- `cycles_delta`
- `cycles_per_request`
- `cycles_per_measured_request`
- `setup_cycles_delta`
- `measured_cycles_delta`
- `cycles_error`
- `cycles_source`
- `cycles_scope`
- `total_seconds`
- `avg_latency_us`
- `p50_latency_us`
- `p95_latency_us`
- `p99_latency_us`
- `request_count`
- `total_request_payload_bytes`
- `total_response_payload_bytes`
- `avg_request_payload_bytes`
- `avg_response_payload_bytes`
- `openai_tool`（OpenAI 互換ツール名; `wiki_cli::agent_tools` と対応）
- `openai_tool_variant`（`write` の `create` / `overwrite` や `mv` の `same_dir` / `cross_dir` など）

cycles が取得できない場合は benchmark を止めず、cycles 値は `null`、理由は `cycles_error` に残します。
summary では `isolated_single_op` に対して `setup_cycles_delta` / `measured_cycles_delta` / `cycles_per_measured_request` を出し、`scenario_total` に対して `cycles_delta` / `cycles_per_request` を出します。

## Operation 定義

| Operation | OpenAI tool | Underlying API | 定義 |
| --- | --- | --- | --- |
| `create` | `write` (`variant=create`) | `write_node` | 新規 path に `expected_etag = None` で書く |
| `update` | `write` (`variant=overwrite`) | `write_node` | 既存 path に `expected_etag = Some(current_etag)` で overwrite |
| `append` | `append` | `append_node` | 小さい seed node に対して target payload を append |
| `edit` | `edit` | `edit_node` | 固定 token を `search/replace` する |
| `move_same_dir` | `mv` (`variant=same_dir`) | `move_node` | 同一 parent 内 rename |
| `move_cross_dir` | `mv` (`variant=cross_dir`) | `move_node` | 別 parent への rename |
| `delete` | `rm` | `delete_node` | seed 済み node を delete |
| `read` | `read` | `read_node` | seed 済み node を read |
| `list` | `ls` | `list_nodes` | seed 済み prefix を list |
| `search` | `search` | `search_nodes` | 共通 token を含む corpus へ hit あり検索 |
| `mkdir` | `mkdir` | `mkdir_node` | 反復ごとに一意 path へ `mkdir_node`（store 上は主に path 正規化の軽量 query） |
| `glob` | `glob` | `glob_nodes` | seed 済み corpus に対し `pattern=node-*.md`、scope は bench `prefix` |
| `recent` | `recent` | `recent_nodes` | seed 済み corpus に対し `limit = min(10, file_count)` |
| `multi_edit` | `multi_edit` | `multi_edit_node` | `BENCH_MULTI_A0/B0` と `A1/B1` を往復する 2 置換を atomic に適用 |

`mkdir` / `glob` / `recent` の反復数はデフォルトで `list` と同系（`WORKLOAD_QUERY_ITERATIONS`、未設定時は `WORKLOAD_LIST_ITERATIONS`、それも未設定なら `100`）。  
`payload_size_bytes` は `mkdir` でもシナリオ行列の軸として残しますが、計測 RPC 自体は path のみです。  
`search` は各 file に共通 token と file 固有 token を埋め込み、共通 token で検索します。
`delete` は latency / request_count / wire IO では delete 呼び出しだけを数えます。cycles 主表は `isolated_single_op` の measured 値です。

## Update ACK

| Method | Response Shape |
| --- | --- |
| `write_node` | `path`, `kind`, `updated_at`, `etag`, `deleted_at`, `created` |
| `append_node` | `path`, `kind`, `updated_at`, `etag`, `deleted_at`, `created=false` |
| `edit_node` | `path`, `kind`, `updated_at`, `etag`, `deleted_at`, `replacement_count` |
| `move_node` | `from_path`, `path`, `kind`, `updated_at`, `etag`, `deleted_at`, `overwrote` |
| `delete_node` | `path`, `etag`, `deleted_at` |
| `multi_edit_node` | `path`, `kind`, `updated_at`, `etag`, `deleted_at`, `replacement_count` |

大きい本文は暗黙に返りません。更新直後に本文が必要な caller は、別途 `read_node` を呼びます。

## 注意

- `append 1MB` や `search 1MB` のように、canister の reply size や内部制約に当たる scenario はありえます。
- その場合も wrapper は run を止めず、失敗 scenario を `raw/*.txt` と `summary.txt` に残します。
- deployed canister bench は host filesystem benchmark ではありません。
- snapshot/export/update の scaling は `canbench` 側の責務です。
- diagnostic build は `WIKI_CANISTER_DIAGNOSTIC_PROFILE=baseline|fts_disabled_for_bench` を使います。
- `run_canister_vfs_workload.sh` / `run_canister_vfs_latency.sh` はワークスペースルートへ `cd` してから `vfs_bench` をビルドし、実行ファイルは `CARGO_TARGET_DIR` が設定されていればその配下の `debug/vfs_bench`、なければ `<repo>/target/debug/vfs_bench` を使います。

## 軽量 ACK 化の比較

update 系 API は、以前は更新後の `Node` 全体を返していました。  
現在は軽量 ACK だけを返すため、特に `avg_response_payload_bytes` が大きく下がります。

### Latency Bench

baseline:

- before: [20260409T224626Z latency summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_latency/20260409T224626Z/summary.txt)
- after: [20260409T235310Z latency summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_latency/20260409T235310Z/summary.txt)

| Operation | Payload | Before cycles/request | After cycles/request | Before avg latency | After avg latency | Before avg response bytes | After avg response bytes | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `write_node` | `1k` | `590,361,208` | `472,002,980` | `383 ms` | `321 ms` | `1,283` | `172` | 改善 |
| `write_node` | `10k` | `830,462,987` | `509,077,382` | `462 ms` | `324 ms` | `10,500` | `173` | 改善 |
| `write_node` | `100k` | `1,161,084,718` | `789,703,180` | `519 ms` | `329 ms` | `102,662` | `174` | 改善 |
| `append_node` | `1k` | `868,725,953` | `493,664,007` | `439 ms` | `335 ms` | `108,296` | `173` | 大幅改善 |
| `append_node` | `10k` | `1,004,522,832` | `608,385,743` | `501 ms` | `352 ms` | `568,586` | `174` | 大幅改善 |
| `append_node` | `100k` | `IC0504` | `1,255,622,076` | `failed` | `440 ms` | `failed` | `175` | reply-size failure 解消 |

### Scenario Workload Cost

baseline:

- before: [20260409T224636Z workload summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_workload/20260409T224636Z/summary.txt)
- after: [20260409T235823Z workload summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_workload/20260409T235823Z/summary.txt)

今回の first pass は `create / update / append` のみを再測しました。  
`append` は canister cycles が途中で尽きたため、安定比較は `create / update` に限ります。

| Operation | Payload | Before cycles/request | After cycles/request | Before avg latency | After avg latency | Before avg response bytes | After avg response bytes | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `create` | `1k` | `625,924,719` | `498,216,212` | `395 ms` | `371 ms` | `1,290` | `179` | 改善 |
| `create` | `10k` | `684,434,605` | `522,370,278` | `401 ms` | `424 ms` | `10,507` | `180` | cycles 改善、latency は同程度 |
| `create` | `100k` | `909,753,082` | `728,489,752` | `501 ms` | `392 ms` | `102,669` | `181` | 改善 |
| `update` | `1k` | `1,827,916,871` | `843,499,576` | `520 ms` | `390 ms` | `1,288` | `177` | 大幅改善 |
| `update` | `10k` | `851,466,290` | `1,176,391,383` | `550 ms` | `369 ms` | `10,505` | `178` | latency は改善、cycles はこの run では悪化 |
| `update` | `100k` | `1,298,433,701` | `2,847,251,326` | `464 ms` | `379 ms` | `102,667` | `179` | latency は改善、cycles はこの run では悪化 |

### 解釈

- 一番確実な改善は `avg_response_payload_bytes` です。update 系は payload size に関係なく `~172B-181B` まで縮みました。
- `append_node 100k` が成功するようになったので、以前の `IC0504` は response contract 由来だったと見てよいです。
- `create` と latency 系 `write/append` は、latency と cycles の両方で改善が見えます。
- workload の比較では `measured_cycles_delta` / `cycles_per_measured_request` を主表として読みます。`scenario_total` は seed 汚染や run-to-run 変動を含みうるため補助値です。
- したがって、この変更で確実に言えるのは「reply-size 問題は解消し、wire response は大幅に軽くなった」です。cycles の純粋な update 原価をさらに詰めるなら、次は seed を外した dedicated single-op bench が必要です。

## Single-Op Isolated Cost

isolated mode では shell wrapper が次の 3 点を保存します。

- `setup_cycles_delta`
- `measured_cycles_delta`
- `cycles_per_measured_request`

update-heavy operation はこの isolated table を主表として読みます。  
`scenario_total` は seed 汚染や run-to-run 変動を含むため、補助比較に下げます。  
`search 1MB` のような失敗は setup 混入ではなく、reply size や FTS/snippet 実装由来の別問題として読みます。

### Current Diagnostic Smoke

現在の baseline は `etag = content hash` 実装です。  
比較対象は `baseline` と `fts_disabled_for_bench` の 2 本だけに固定します。
`fts_disabled_for_bench` では FTS 更新を意図的に止めるため、default workload から `search` を外して baseline と比較可能な scenario だけを残します。

- baseline latency: [20260410T011254Z latency summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_latency/20260410T011254Z/summary.txt)
- `fts_disabled_for_bench` latency: [20260410T011417Z latency summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_latency/20260410T011417Z/summary.txt)
- baseline workload: [20260410T011348Z workload summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_workload/20260410T011348Z/summary.txt)
- `fts_disabled_for_bench` workload: [20260410T011427Z workload summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_workload/20260410T011427Z/summary.txt)
- fresh-replica compare wrapper: `bash scripts/bench/run_canister_vfs_fresh_compare.sh`

| Bench | Scenario | baseline cycles/request | FTS off cycles/request | baseline avg latency | FTS off avg latency | Reading |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| latency | `write_node_single_1k` | `15.37M` | `14.01M` | `219 ms` | `225 ms` | この最小 smoke では差は小さい |
| latency | `append_node_single_1k` | `16.23M` | `14.29M` | `219 ms` | `219 ms` | 軽い payload では差分は限定的 |
| workload | `update_flat_n10_p1024_c1` | `16.29M` | `14.33M` | `232 ms` | `251 ms` | isolated mode なので seed と measured を分離済み |

この smoke は `1k` のみ、回数も少ない確認用です。  
FTS の寄与を桁で確定するには、従来どおり `10k / 100k` を含む isolated compare を読む必要があります。  
ただし比較軸自体はこれで固定できていて、今後は `content_hash_etag` を使った分岐比較は行いません。

### Accepted Workload Snapshot

2026-04-10 時点では、次の full workload run を現行の受け入れ値として扱います。

- accepted workload: [20260410T070122Z workload summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_workload/20260410T070122Z/summary.txt)

この run は `n=100`、`1k / 10k / 100k / 1MB`、`isolated_single_op` で `create / update / append / edit / move_same_dir / move_cross_dir` を通しています。  
主表は引き続き `cycles_per_measured_request` と `avg_latency_us` です。

| Operation | Payload | cycles/request | avg latency | avg response bytes | Reading |
| --- | --- | ---: | ---: | ---: | --- |
| `create` | `1k` | `14.57M` | `236 ms` | `239` | create の基準点 |
| `create` | `10k` | `35.71M` | `237 ms` | `240` | payload 増に対して latency はほぼ横ばい |
| `create` | `100k` | `235.92M` | `238 ms` | `241` | cycles は本文サイズに比例して増える |
| `create` | `1MB` | `2,273.51M` | `273 ms` | `242` | 1MB でも ACK は軽いまま |
| `update` | `1k` | `13.79M` | `236 ms` | `237` | create より少し軽い |
| `update` | `10k` | `33.58M` | `241 ms` | `238` | create と近い帯域 |
| `update` | `100k` | `231.10M` | `244 ms` | `239` | create と同程度 |
| `update` | `1MB` | `2,258.58M` | `260 ms` | `240` | 1MB でも安定 |
| `append` | `1k` | `15.34M` | `240 ms` | `237` | create/update より少し重い |
| `append` | `10k` | `36.46M` | `240 ms` | `238` | 10k まではほぼ一定 latency |
| `append` | `100k` | `249.05M` | `271 ms` | `239` | 100k から latency が上振れ |
| `append` | `1MB` | `2,277.66M` | `281 ms` | `240` | 大 payload では append が最重 |
| `edit` | `1k` | `13.56M` | `240 ms` | `238` | 小 payload は overwrite よりわずかに軽い |
| `edit` | `10k` | `18.61M` | `241 ms` | `239` | request 本文が小さいため cycles は抑えめ |
| `edit` | `100k` | `45.96M` | `252 ms` | `240` | content scan の分だけ増える |
| `edit` | `1MB` | `289.87M` | `296 ms` | `241` | 1MB でも write 系よりかなり軽い |
| `move_same_dir` | `1k` | `12.17M` | `243 ms` | `353` | rename は本文サイズにほぼ依存しない |
| `move_same_dir` | `10k` | `13.38M` | `235 ms` | `355` | 同一ディレクトリ rename の基準点 |
| `move_same_dir` | `100k` | `24.52M` | `235 ms` | `357` | setup 側を除けばまだ軽い |
| `move_same_dir` | `1MB` | `140.67M` | `253 ms` | `359` | metadata 系でも 1MB では etag 計算分が見える |
| `move_cross_dir` | `1k` | `12.17M` | `238 ms` | `353` | same-dir とほぼ同水準 |
| `move_cross_dir` | `10k` | `13.37M` | `234 ms` | `355` | 同一 run では差は誤差帯 |

この snapshot から読めることは単純です。

- ACK 化された update 系は、`create / update / append / edit` で response wire bytes がほぼ `237B-242B` に収まっています。
- `edit` は request 本文が固定小サイズなので、`10k` 以上では `write`/`append` よりかなり cycles が低いです。
- `move_*` は本文転送をしないため最安クラスですが、response は `from_path` を含むぶん `~353B-359B` です。
- 1MB 帯では全 operation で latency は増えるものの、今回の accepted run では全 scenario が完走しています。
