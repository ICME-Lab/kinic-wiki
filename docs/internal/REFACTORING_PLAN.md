# Kinic Wiki リファクタリング計画

Status: 第1ラウンド完了(2026-07-07)。フェーズ0-6 の主要項目を実施済み。
残項目は各フェーズの未チェック項目を参照。

モットー(AGENTS.md): 小さく、明確で、安全なステップ。互換より単純さを優先する。

## ベースライン(2026-07-07 時点, main = 5f85c18f)

- 総行数: 約 166,000(git 追跡ファイル、lockfile 含む)
- 主要内訳: crates 65,989 / wikibrowser 42,661 / workers 11,971 / extensions 10,691 / mobile 8,710 / skill-registry-web 8,566
- CI(`CI` workflow): main で green
- **Canbench workflow: main で恒常 failure**。`__canbench__append_node_scale_n1000` 実行中に
  `vfs_canister::benches::scale::run_append` 内の unwrap が panic(run 28836007608)。
  リファクタとは独立の既存バグとして別タスクで修正する。
- ビルド成果物(artifacts/, outputs/, __pycache__ 等)は git 未追跡であることを確認済み。

## 調査で確認した主要な負債

1. **VFS クライアント / Candid バインディングの6重実装**(`vfs.did` 739行が正)
   - wikibrowser/lib/vfs-client.ts(1,848行)+ vfs-idl.ts
   - skill-registry-web/lib/vfs-client.ts
   - workers/wiki-generator/src/vfs.ts + vfs-idl.ts(wikibrowser 側と内容乖離を md5 で確認済み)
   - workers/wiki-mcp/src/vfs.ts(760行)
   - extensions/wiki-clipper/src/vfs-actor.js
   - iOS 手書き Candid コーデック(VFSCandidEncoder/Decoder/LEB.swift)
2. **巨大ファイル**: vfs_runtime/src/lib.rs 8,513行 / vfs_cli_core/src/commands.rs 2,921行 /
   wiki-browser.tsx 1,787行 / vfs_cli_app の src/ 直下テスト 4,500行超
3. **JS ワークスペース分裂**: lockfile 5本(pnpm×4 + npm×1)、CI の Node 22/24 混在
4. **自前チェックスクリプト24本**(wikibrowser/scripts/check-*, smoke-*)が vitest/playwright と役割重複

## フェーズ0 調査での訂正事項

- `shared/ii-auth` は**使用中**(extensions/wiki-clipper/src/auth-client.js、
  crates/vfs_canister/src/icp_cli_login.js が相対パス import)。削除ではなくフェーズ3で
  workspace パッケージへ昇格する。
- `crates/wiki_domain`(157行)は 5 crate から依存される正当な集約点。**維持**。
- `crates/ic_sqlite_vfs_probe` は pocketic-tests が使用。**維持**。
- `.gitignore` は main で整備済み。不足は `/outputs/` のみ。

## フェーズ一覧

### フェーズ0: 安全網の整備(TS 側完了)
- [x] main の CI ベースライン確認(CI green / Canbench 既存 failure を記録)
- [x] 行数・構成の計測記録(本ファイル)
- [x] TS クライアントの vfs.did ドリフト検査を全数化。
      既存: wikibrowser(生成+検査)/ skill-registry-web(生成+検査)/
      wiki-generator(サブセット検査)/ wiki-clipper(サブセット検査)。
      新規: wiki-mcp に check-candid-drift.mjs と CI ジョブを追加(CI ジョブ自体が未存在だった)。
- [ ] iOS Swift コーデックのゴールデン contract test。
      mobile/ios は進行中ブランチ(feat/ios-vfs-browse)と競合するため、
      同ブランチ着地後に実施する。

### フェーズ1: リポジトリ衛生(完了)
- [x] .gitignore に /outputs/ 追加
- [x] docs/README.md 索引の新設
- [x] 死蔵コード候補の生存確認(shared/ii-auth, wiki_domain, probe → すべて生存)
- [x] cargo machete による Rust 未使用依存の削除(11件削除、false positive 2件は
      package.metadata.cargo-machete に理由付きで登録)
- [ ] knip による JS 未使用コード検出はフェーズ3(モノレポ統合)に統合して実施

### フェーズ2: VFS クライアント単一ソース化(最重要)

フェーズ0 調査での訂正: wikibrowser と skill-registry-web の vfs-idl.ts は既に
generate-vfs-idl.mjs による生成物であり、wiki-generator / wiki-clipper / wiki-mcp の
手書きサブセットもドリフト検査済み。したがって本フェーズの主目的は「壊れた重複の修復」
ではなく「生成器・shape 定義・actor 生成コードを共有パッケージに集約し、コピーを廃止する」
ことに更新する。

- [x] 共有パッケージ `@kinic/candid-tools`(tools/candid)新設: shapes / subset-check /
      generate-vfs-idl を集約。wikibrowser・skill-registry-web・wiki-generator・wiki-mcp が
      workspace 依存として import。
- [x] skill-registry-web の vfs-idl.ts を共有生成器で再生成し、生成一致検査を test に追加
      (wikibrowser と同一の生成物になった)。
- [x] CI パスフィルタ: tools/candid 変更で4クライアントのジョブが発火。
- [ ] actor 層まで含む `@kinic/vfs-client` への統合は次ラウンド。各アプリの
      認証・キャッシュ・エラー処理が絡むため、e2e 網を整えてから行う。
- [ ] iOS Swift コーデックの contract test 接続(feat/ios-vfs-browse 着地待ち)。
- 完了条件(更新): ツール・shape・生成器の単一ソース化 ✅ / クライアント実装の統合は継続。

### フェーズ3: JS モノレポ統合(主要部完了)
- [x] ルート pnpm workspace(wikibrowser / skill-registry-web / workers×2 / wiki-clipper /
      tools/candid)。lockfile 5本 → 1本。npm/kinic-vfs-cli と pocketic-tests は
      publish/CI フローを壊さないため意図的に除外。
- [x] Node 24 統一(CI)。拡張機能ジョブと canister login-page ジョブも npm → pnpm 化。
- [ ] eslint/tsconfig の共有ベース化は次ラウンド。
- [ ] shared/ii-auth の workspace パッケージ昇格(相対 import のままでも動作するため低優先)。
- [ ] check-* スクリプトの vitest/playwright 移植と knip 導入は次ラウンド。
      現状の check スクリプトは分割後のファイル群を連結して読む方式に更新済みで、
      ファイル配置に依存しない。
- 完了条件: pnpm install 1回 + lockfile 1本で全 JS パッケージがビルド・テスト可能 ✅

### フェーズ4: Rust 構造整理(フェーズ2-3と並行可、主要部完了)
- [x] vfs_runtime/src/lib.rs(8,513行)を責務単位で分割:
      tests / market / cycles / billing / metrics / index_schema / sessions / databases の
      8モジュールに抽出し、lib.rs は 1,315行。全ファイル 2,000行未満。
- [x] vfs_cli_app の src/ 直下テスト整理: agent_tools_tests は crate 内部を使わない
      純粋な統合テストだったため tests/agent_tools.rs へ移動。残り3本
      (commands_fs / commands_maintenance / skill_registry)は private API を
      検証する正当な unit test なので src/ に維持(#[cfg(test)] ファイルモジュール)。
- [x] vfs_cli_core/src/commands.rs(2,921行)を分割:
      commands/{tests,market,database,cycles}.rs へ抽出し、本体 984行。
- [x] fs_store.rs(2,810行)→ fs_store/{context,marketplace,sql_json,sync}.rs 分割で 1,775行。
- [x] context_pack.rs(2,521行)/ cli.rs(2,494行)→ インラインテストを
      ファイルモジュール化してそれぞれ 1,369行 / 1,305行。
- [x] vfs_canister/src/lib.rs(2,518行)は例外として維持: 薄い endpoint 70個の列挙で
      ロジックは vfs_runtime に分離済み。check-file-sizes.mjs のラチェットで凍結。
- [ ] core/app 境界見直し(context_pack.rs / skill_registry.rs の置き場判定)は次ラウンド。
- [ ] canbench 非劣化確認(main の既存 failure 修正後に実施)。
- 完了条件: tests と vfs_canister endpoint 表面を除き 2,000行超ゼロ ✅

### フェーズ5: フロントエンド巨大コンポーネント分割(主要部完了)
- [x] wiki-browser.tsx(1,787行)→ explorer-pane.tsx / top-bar.tsx を分離し 1,019行。
- [x] vfs-client.ts(1,848行)→ raw-types / actor / cycles / market に分割し 692行。
      lib/vfs-client.ts はバレルとして全 import 経路を維持。
- [x] ソース文字列を検査する check スクリプト3本は分割ファイル群の連結を読む方式に更新
      (アサーションは全件維持)。
- [ ] kinic-wallet.ts(1,018)/ dashboard-ui.tsx(886)/ document-pane.tsx(872)は
      1,100行ガード内に収まっているため次ラウンド。E2E 網を整えてから分割する。
- 完了条件(更新): 1,100行超の TS/TSX ゼロ ✅(check-file-sizes.mjs が恒久ガード)

### フェーズ6: 継続ガードレール(完了)
- [x] scripts/check-file-sizes.mjs: Rust 2,000行 / TS 1,100行の上限 + 既存大型ファイルの
      ラチェット(縮小のみ許可)。CI の regression-groups-check で毎 PR 実行。
- [x] cargo machete を rust-check ジョブに追加。
- [x] scripts/check-docs-links.mjs: docs/ と README の相対リンク切れ検査。
- [ ] knip の導入は eslint/tsconfig 共有化(フェーズ3残)とセットで次ラウンド。
- [ ] AGENTS.md は gitignore 対象(ローカル専用)のため、構成規約は本ファイルに記載:
      新規モジュールは分割済みの構成(vfs_runtime/billing 等、wikibrowser/lib/vfs-client/ 等)に
      追加する。lib.rs / vfs-client.ts などの親ファイルを再び太らせない。

## 進め方の原則

- フェーズ0→1→2 は順序必須。フェーズ4はフェーズ2-3と並行可。
- 各フェーズは挙動変更なし。PR は削除系・移動系・生成系を混ぜない。
- 互換 shim は作らない。旧実装は移行完了時点で即削除。
