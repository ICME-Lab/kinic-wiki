# VFS Deployed Canister Benchmarks

## 目的

この文書は、deploy 済み canister を `ic-agent` 経由で直接叩く benchmark の契約をまとめるものです。  
`fio` / `smallfile` / SQLite の host FS benchmark とは分けて読みます。

主評価は host filesystem 風 workload ではなく、実際に使う canister API operation 単位の:

- `cycles`
- `latency`
- `wire IO`

です。

## ベンチ系列

| Bench | 役割 | 主対象 |
| --- | --- | --- |
| `canister_vfs_workload` | API-centric repeated request bench | `create`, `update`, `append`, `edit`, `move_same_dir`, `move_cross_dir`, `delete`, `read`, `list`, `search` |
| `canister_vfs_latency` | single-update latency bench | `write_node`, `append_node` |

`query` は独立 method 名ではなく、文書上は `read / list / search` の総称です。

## 固定条件

| Item | Value |
| --- | --- |
| Payload Sizes | `1k`, `10k`, `100k`, `1MB` |
| Workload File Count | `100` |
| Concurrency | `1` |
| Transport | `ic-agent` |
| Cycles Source | `icp canister status --json` |
| Update Cycles Scope | `isolated_single_op` |
| Query Cycles Scope | `scenario_total` |

`isolated_single_op` は setup phase と measure phase を分けて cycles を取り、measure phase では純粋な API 呼び出しだけを測ります。  
主指標は `measured_cycles_delta` と `cycles_per_measured_request` です。  
`scenario_total` は互換用に残しますが、seed を含む補助値として読みます。

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

cycles が取得できない場合は benchmark を止めず、cycles 値は `null`、理由は `cycles_error` に残します。

## Operation 定義

| Operation | Underlying API | 定義 |
| --- | --- | --- |
| `create` | `write_node` | 新規 path に `expected_etag = None` で書く |
| `update` | `write_node` | 既存 path に `expected_etag = Some(current_etag)` で overwrite |
| `append` | `append_node` | 小さい seed node に対して target payload を append |
| `edit` | `edit_node` | 固定 token を `search/replace` する |
| `move_same_dir` | `move_node` | 同一 parent 内 rename |
| `move_cross_dir` | `move_node` | 別 parent への rename |
| `delete` | `delete_node` | seed 済み node を delete |
| `read` | `read_node` | seed 済み node を read |
| `list` | `list_nodes` | seed 済み prefix を list |
| `search` | `search_nodes` | 共通 token を含む corpus へ hit あり検索 |

`search` は各 file に共通 token と file 固有 token を埋め込み、共通 token で検索します。
`delete` は latency / request_count / wire IO では delete 呼び出しだけを数えますが、cycles は scenario_total を保存するため再 seed 分を含みます。

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
- workload の `update 10k / 100k` は latency は改善していますが、cycles は run-to-run 変動と seed を含む `scenario_total` 差分の影響が残っています。
- したがって、この変更で確実に言えるのは「reply-size 問題は解消し、wire response は大幅に軽くなった」です。cycles の純粋な update 原価をさらに詰めるなら、次は seed を外した dedicated single-op bench が必要です。

## Single-Op Isolated Cost

isolated mode では shell wrapper が次の 3 点を保存します。

- `setup_cycles_delta`
- `measured_cycles_delta`
- `cycles_per_measured_request`

update-heavy operation はこの isolated table を主表として読みます。  
`scenario_total` は seed 汚染や run-to-run 変動を含むため、補助比較に下げます。

### Current Diagnostic Smoke

現在の baseline は `etag = content hash` 実装です。  
比較対象は `baseline` と `fts_disabled_for_bench` の 2 本だけに固定します。
`fts_disabled_for_bench` では FTS 更新を意図的に止めるため、default workload から `search` を外して baseline と比較可能な scenario だけを残します。

- baseline latency: [20260410T011254Z latency summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_latency/20260410T011254Z/summary.txt)
- `fts_disabled_for_bench` latency: [20260410T011417Z latency summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_latency/20260410T011417Z/summary.txt)
- baseline workload: [20260410T011348Z workload summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_workload/20260410T011348Z/summary.txt)
- `fts_disabled_for_bench` workload: [20260410T011427Z workload summary](/Users/0xhude/Desktop/work/llm-wiki/.benchmarks/results/canister_vfs_workload/20260410T011427Z/summary.txt)

| Bench | Scenario | baseline cycles/request | FTS off cycles/request | baseline avg latency | FTS off avg latency | Reading |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| latency | `write_node_single_1k` | `15.37M` | `14.01M` | `219 ms` | `225 ms` | この最小 smoke では差は小さい |
| latency | `append_node_single_1k` | `16.23M` | `14.29M` | `219 ms` | `219 ms` | 軽い payload では差分は限定的 |
| workload | `update_flat_n10_p1024_c1` | `16.29M` | `14.33M` | `232 ms` | `251 ms` | isolated mode なので seed と measured を分離済み |

この smoke は `1k` のみ、回数も少ない確認用です。  
FTS の寄与を桁で確定するには、従来どおり `10k / 100k` を含む isolated compare を読む必要があります。  
ただし比較軸自体はこれで固定できていて、今後は `content_hash_etag` を使った分岐比較は行いません。
