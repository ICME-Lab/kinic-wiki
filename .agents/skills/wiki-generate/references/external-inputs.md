# External Inputs

This skill should borrow ideas selectively from two external projects, without replacing the repo's own source-of-truth model.

## `graphify`

Repository: [safishamsi/graphify](https://github.com/safishamsi/graphify)

Useful ideas to borrow:

- folder-to-graph analysis
- graph/report/wiki draft generation
- query/path/explain style exploration over local material

How to use it here:

- as an optional preprocessing or drafting step
- to suggest page boundaries and relationships
- to produce candidate wiki content before human review

Do not use it as:

- the source of truth
- the revision system
- the sync/conflict engine

## `obsidian-skills`

Repository: [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)

Useful ideas to borrow:

- Obsidian-oriented skill phrasing
- markdown and vault handling conventions
- skill organization patterns around Obsidian workflows

How to use it here:

- as style and workflow inspiration for Obsidian-facing behavior
- as guidance for agent interaction with vault content
- by selectively vendoring a small subset of skills into this repo

Recommended vendor priority:

- `obsidian-markdown`
- `obsidian-cli`
- `defuddle`

Do not import it wholesale as a dependency. Keep this skill specific to the repo's canister + CLI + plugin architecture.

See also: [../VENDOR_PLAN.md](../VENDOR_PLAN.md)
