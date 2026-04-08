# Vendor Layout

このディレクトリは `kepano/obsidian-skills` から選別して取り込む skill の置き場です。

## 取り込む優先順

1. `obsidian-markdown`
2. `obsidian-cli`
3. `defuddle`

## 使い方

- まず `wiki-generate` を親 skill として使う
- Obsidian 記法や vault 操作の詳細が必要な時だけ vendor skill を読む
- vendor skill 自体は一般知識、正本 workflow は `wiki-generate` に置く

## 注意

- upstream 全体をコピーしない
- この repo の canister / CLI / plugin 前提を壊さない
- vendor skill は必要に応じて編集してよい
