# Kinic Wiki リファクタリング計画

Status: フェーズ0 実施中(2026-07-07 開始)

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

### フェーズ0: 安全網の整備(実施中)
- [x] main の CI ベースライン確認(CI green / Canbench 既存 failure を記録)
- [x] 行数・構成の計測記録(本ファイル)
- [ ] Candid contract test(ゴールデンフィクスチャ)を TS×4 / Swift / Rust に接続

### フェーズ1: リポジトリ衛生
- [x] .gitignore に /outputs/ 追加
- [x] docs/README.md 索引の新設
- [x] 死蔵コード候補の生存確認(shared/ii-auth, wiki_domain, probe → すべて生存)
- [ ] cargo machete / knip による未使用依存の検出と削除

### フェーズ2: VFS クライアント単一ソース化(最重要)
- vfs.did → TS バインディング自動生成(既存 generate-vfs-idl.mjs を土台に)
- 共有パッケージ `@kinic/vfs-client` 新設
- 移行順: wiki-mcp → wiki-generator → skill-registry-web → wiki-clipper → wikibrowser
- iOS Swift コーデックは手書き維持 + contract test 接続(Swift 生成は費用対効果が低い)
- CI に did ドリフト検査(check-candid-drift.mjs を全パッケージへ拡張)
- 完了条件: 手書き IDL 定義ゼロ。vfs.did 変更が 1 コマンドで全クライアントに伝播。

### フェーズ3: JS モノレポ統合
- ルート pnpm workspace(wikibrowser / skill-registry-web / workers/* / extensions / npm / shared)
- lockfile 1本化、Node 24 統一、eslint/tsconfig 共有化
- shared/ii-auth を相対パス import から workspace パッケージへ昇格
- wikibrowser/scripts の check-* を棚卸し: ロジック検証→vitest、UI系→playwright、
  CI ガード(check-candid-drift, check-url-security)のみスクリプト残置
- 完了条件: pnpm install 1回 + lockfile 1本で全 JS パッケージがビルド・テスト可能。

### フェーズ4: Rust 構造整理(フェーズ2-3と並行可)
- vfs_runtime/src/lib.rs(8,513行)を責務単位で分割(挙動変更なし・移動のみ)
- vfs_cli_app の src/ 直下テスト4本を tests/ へ移動
- vfs_cli_core/src/commands.rs をコマンドファミリー単位に分割
- core/app 境界見直し(context_pack.rs / skill_registry.rs の置き場判定)
- 完了条件: tests を除き 2,000行超の Rust ソースがゼロ。canbench 非劣化。

### フェーズ5: フロントエンド巨大コンポーネント分割
- wiki-browser.tsx → ツリー / ドキュメント / 検索 / hooks に分離
- document-pane.tsx、dashboard-ui.tsx、kinic-wallet.ts も同様
- iOS の Browse* 分割と同じ粒度方針
- 完了条件: 800行超の tsx がゼロ。E2E green。

### フェーズ6: 継続ガードレール
- ファイルサイズ上限の CI ガード
- knip / cargo machete の CI 定期実行
- docs リンク切れ検査
- AGENTS.md に構成規約追記

## 進め方の原則

- フェーズ0→1→2 は順序必須。フェーズ4はフェーズ2-3と並行可。
- 各フェーズは挙動変更なし。PR は削除系・移動系・生成系を混ぜない。
- 互換 shim は作らない。旧実装は移行完了時点で即削除。
