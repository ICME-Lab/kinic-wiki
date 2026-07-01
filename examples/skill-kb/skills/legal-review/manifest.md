---
kind: kinic.skill
schema_version: 1
id: legal-review
version: 0.1.0
entry: SKILL.md
summary: Contract review workflow for spotting redlines, risk clauses, and missing approval context
tags:
  - legal
  - contract
  - review
  - risk
use_cases:
  - Review vendor contract redlines before counsel handoff
  - Summarize risky clauses and negotiation blockers
  - Check whether approval, renewal, and liability terms are documented
status: reviewed
replaces: []
related:
  - /Knowledge/legal/contract-review-playbook.md
  - /Sources/github/acme/legal-review
knowledge:
  - /Knowledge/legal/contract-review-playbook.md
permissions:
  file_read: true
  network: false
  shell: false
provenance:
  source: github.com/acme/legal-review
  source_ref: demo
---
# Skill Manifest

This sample shows how a team can keep the searchable registry record in the DB while linking back to GitHub as provenance.
