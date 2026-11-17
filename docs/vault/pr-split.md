# Vault PR dependencies

|PR|Purpose|Base|
|---|---|---|
|[#181](https://github.com/ICME-Lab/kinic-wiki/pull/181)|Local workflow state and generated store assets|main|
|[#182](https://github.com/ICME-Lab/kinic-wiki/pull/182)|MCP fixed-window test|main|
|[#183](https://github.com/ICME-Lab/kinic-wiki/pull/183)|Shared UI plus standalone extension workspace scope|main|
|[#184](https://github.com/ICME-Lab/kinic-wiki/pull/184)|Rust backend and production ledger reconciliation|#183|
|[#185](https://github.com/ICME-Lab/kinic-wiki/pull/185)|Candid, crypto and client|#184|
|[#177](https://github.com/ICME-Lab/kinic-wiki/pull/177)|Vault browser, certified distribution and combined acceptance|#185|

The first three are independently reviewable prerequisites. Rust builds and its official-ledger acceptance do not need Vault browser or client sources. The client has its own frozen lockfile and contracts/types/tests. The final integration removes the two interim backend/client workflows in favor of the shared three-job pipeline.

Prepare and validate the whole Vault stack before merging any Vault implementation. Prerequisites may be reviewed separately. Merge order after review is181/182/183,184,185,177; update bases as predecessors land. No automatic merge, deployment, DNS or live transfer is included.

Original PR177 history is retained by an additive merge commit. The final commit combines the verified implementation tree with the client/prerequisite parents; no rebase or force push is needed. Small prerequisite housekeeping/MCP changes may remain visible in177 until their independent PRs land.
