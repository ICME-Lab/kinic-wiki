# Vault PR dependencies

The current follow-up dependency is [#190](https://github.com/ICME-Lab/kinic-wiki/pull/190) before [#189](https://github.com/ICME-Lab/kinic-wiki/pull/189). PR189 integrates the public PR190 head `41db6180d74a6cb34db0892cb65f4bd131a5ca55` through an additive merge, preserving both histories. Merge PR190 first, then synchronize PR189 against the resulting main commit and rerun its required checks if that changes the integrated tree. A squash merge of PR190 needs particular care because its commits will not be ancestors of main. The prepared integration does not itself merge either PR into main.

The combined backend initializes schema13 and migrates both preceding team and subsidy layouts. Publish that backend before the Wiki/Vault clients; rollback requires a validated schema13-compatible binary. Do not downgrade to either parent store version. All workspace, picker and embed views use 30-minute idle expiry and retain validated nonextractable browser device keys across local close/sign-out.

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
