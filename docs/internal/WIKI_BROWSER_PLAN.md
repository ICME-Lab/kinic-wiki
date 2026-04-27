# Wiki Browser Implementation Plan

## Summary

`wikibrowser/` に Next.js App Router の public read-only UI を追加する。UI は VSC 風 3 ペインで、任意 canister ID の `/Wiki` / `/Sources` を閲覧・検索できる。初期は認証なし、編集導線なし。将来 Internet Identity と asset canister deploy を追加できる構造にする。

主要方針:

- Framework: Next.js App Router + pnpm
- UI: shadcn/ui + Tailwind + lucide-react
- Markdown: `react-markdown` + `remark-gfm`
- Canister access: Next API route -> `@dfinity/agent`
- URL: `/site/[canisterId]/[...nodePath]`
- Default path: `/site/[canisterId]` -> `/site/[canisterId]/Wiki`
- IC host: `WIKI_IC_HOST` env。production default は `https://icp0.io`
- canister allowlist: なし。API route で principal 形式のみ検証

## Key Changes

- VFS API に `list_children` query を追加する。
  - direct children only
  - absolute path only
  - trailing slash は正規化
  - sort は directories first + name asc
  - virtual directory も返す
  - virtual directory metadata は `null`
  - schema / migration 変更なし

- `list_children` を canister / Rust client / CLI に通す。
  - canister query: `list_children`
  - Rust client method: `list_children(path)`
  - CLI command: `list-children --path ... --json`
  - response は path/name/kind/etag/updated_at/size_bytes/is_virtual を持つ

- `wikibrowser/` に Next.js app を追加する。
  - route: `/site/[canisterId]/[...nodePath]`
  - API:
    - `GET /api/site/[canisterId]/node?path=/Wiki/...`
    - `GET /api/site/[canisterId]/children?path=/Wiki/...`
    - `GET /api/site/[canisterId]/search-path?q=...`
    - `GET /api/site/[canisterId]/search?q=...`
    - `GET /api/site/[canisterId]/recent?limit=...`
  - JSON の bigint 系値は string で返す

- UI は read-only 3 ペインにする。
  - 左: Explorer / Search / Recent tabs
  - 中央: Markdown Preview / Raw 切替
  - 右: Inspector
  - mobile は drawer 化する desktop-first responsive
  - tree は shadcn Collapsible + Button + lucide icons の recursive TreeNode

- Inspector には軽量情報を出す。
  - path, kind, size, updated_at, etag
  - inferred note role
  - outgoing links
  - provenance link
  - client-side canonicality hints
  - hints は lightweight heuristic のみ。本格 lint は呼ばない

## Interfaces

```ts
type ChildNode = {
  path: string
  name: string
  kind: "file" | "directory"
  etag: string | null
  updatedAt: string | null
  sizeBytes: string | null
  isVirtual: boolean
}
```

URL state:

- selected node: route path
- `view=preview|raw`
- `tab=explorer|search|recent`
- `q=...`
- expanded tree state は URL に載せない

## Test Plan

- Rust / canister:
  - `list_children("/Wiki")` が直下だけ返す
  - nested path から virtual directory を返す
  - file path は `not a directory`
  - relative path は拒否
  - `/Wiki/` は `/Wiki` に正規化
  - sort が directories first + name asc
  - CLI `list-children --path /Wiki --json` が通る

- Next API:
  - invalid canister ID は 400
  - missing `path` / `q` は 400
  - bigint 系 JSON は string
  - local `.env.local` の `WIKI_IC_HOST=http://127.0.0.1:8000` で読める
  - production default は `https://icp0.io`

- UI:
  - `/site/[canisterId]` が `/Wiki` を開く
  - `/site/[canisterId]/Wiki/...` が該当 node を開く
  - tree 展開、search、recent、preview/raw 切替が動く
  - inspector が metadata / links / hints を表示する
  - Playwright で desktop と mobile 表示を確認する

## Assumptions

- 初期版は read-only。編集 UI、write API、II 認証、権限制御は含めない。
- public Vercel deploy を初期ターゲットにする。
- 任意 canister ID を許可する。read-only proxy になるリスクは許容する。
- `list_children` は既存 node path 情報から計算し、DB schema は変更しない。
- shadcn/ui の導入に必要な frontend 依存は `wikibrowser/` 内に閉じる。

