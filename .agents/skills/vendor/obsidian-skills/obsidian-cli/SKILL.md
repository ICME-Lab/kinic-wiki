---
name: obsidian-cli
description: Interact with Obsidian vaults and running Obsidian instances from the command line. Use when the task is to inspect vault content, manage notes, or reason about Obsidian-side operations from a CLI workflow.
---

# Obsidian CLI

This is a vendor-adapted skill derived from ideas in `kepano/obsidian-skills`, narrowed for this repo.

Use this skill when the user wants to:

- inspect or reason about vault content from the command line
- coordinate CLI work with Obsidian note workflows
- operate on notes while keeping Obsidian compatibility in mind

In this repo:

- human review happens in Obsidian
- agent operations happen through filesystem edits and `wiki-cli`
- plugin-specific behavior still belongs to the plugin code and repo-specific skills

## Guidance

- treat the vault as user-facing content, not a scratch directory
- preserve paths and names that Obsidian users rely on
- prefer explicit note operations over hidden background rewrites
- when working on managed wiki pages, follow the shared mirror contract from [`references/shared-rules.md`](../../../references/shared-rules.md)

Read [references/vault-operations.md](references/vault-operations.md) when you need note-operation guidance.
