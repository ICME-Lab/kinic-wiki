# Curator Diagnostic Accuracy

This benchmark measures classification accuracy for the deterministic Curator backend used by `kinic-wiki-lint`. It does not measure latency or the lint agent's semantic duplicate and contradiction analysis.

## Metric Contract

Each golden case identifies one rule, one focus path, and whether that rule should emit a finding for the focus path. The report records true positives, true negatives, false positives, and false negatives, then calculates precision, recall, specificity, and F1.

The acceptance threshold is overall F1 `>= 0.90`. A high score is a regression signal for the checked corpus, not proof of production accuracy.

## Corpus v1

The corpus covers positive and negative examples for:

- broken links, isolated nodes, source freshness, review age, and missing evidence
- valid and invalid Curator status
- Memory and Knowledge note-role boundaries
- Skill manifest, provenance, and run evidence
- Session evidence
- orphan source evidence

Adversarial negatives include English negation, substring collisions, use of role-page terms in ordinary prose, `/Sources` filenames that resemble role pages, decimal section numbers, and Japanese positive and negative expressions.

## Run

```bash
cargo run -p kinic-vfs-cli --bin curator_accuracy_bench --locked -- \
  --output-json /tmp/curator-accuracy.json \
  --require-min-f1 0.90
```

The command exits non-zero when F1 is below the requested threshold.

## Staging Evaluation

The reusable staging evaluator measures a private real-content scan without changing the staging canister or database. Curator is a CLI-only backend used by `kinic-wiki-lint`, so this workflow does not deploy or upgrade Wasm.

### Controlled staging seed

For a reusable controlled corpus, generate and preflight the fixed seed before writing anything:

```bash
scripts/staging/seed_curator_accuracy.sh \
  --database-id <staging-test-database-id>
```

The default `curator-accuracy-v1` seed contains 128 non-folder cases plus required folders, at least 40 deterministic positives across at least 12 rules, adversarial negatives, and 12 explicit semantic gold pairs (six duplicate and six contradiction). It uses seed-specific roots in all four mutable stores and `/Sources`; existing nodes outside those roots are never seed-owned. Artifacts are private and ignored under `.benchmarks/results/curator_accuracy/staging/<database-id>/<seed-id>/`.

Review the manifest and dry-run output, then explicitly confirm the initial insert:

```bash
scripts/staging/seed_curator_accuracy.sh \
  --database-id <staging-test-database-id> \
  --confirm
```

The script creates missing batches in deterministic order, refuses partial batches, content mismatches, or unexpected seed-root paths, and verifies node hashes plus the deterministic oracle after a complete scan. It also validates every retained batch against the manifest during dry-run and again immediately before each write. Path, kind, content, metadata, count, or etag drift aborts before `write-nodes`. A repeated dry-run must report every batch as `complete` and perform no writes. Keep the corpus for reuse.

Changing a retained seed definition is exceptional. First use `--repair` without `--confirm`. It creates private, etag-guarded repair batches and writes nothing. After reviewing the exact mismatch counts, `--repair --confirm` applies only changed seed nodes in original batch order and verifies the final scan. This preserves source-freshness ordering by updating the fresh source last.

Create an ignored result directory and scan an explicitly selected existing staging test database with the CLI built from the branch under test:

```bash
RESULT_DIR=".benchmarks/results/curator_accuracy/staging/<timestamp>"
mkdir -p "$RESULT_DIR"

cargo run -p kinic-vfs-cli --bin kinic-vfs-cli --locked -- \
  --canister-id 3ryrw-kyaaa-aaaaf-qgxpq-cai \
  --database-id <staging-test-database-id> \
  curator scan --out "$RESULT_DIR/scan.curator-scan.json" --json
```

`prepare` refuses incomplete coverage, inspection errors, and truncated link results. It writes the strict `kinic.curator.accuracy-input.v2` answer-masked projection. The projection keeps `raw_content`, `body_without_frontmatter`, paths, timestamps, etags, links, source evidence, and independent rule definitions. It removes deterministic findings and implementation-derived fields including normalized `curator_status`, metadata, and creation time. Seed paths and prose remain recognizable, so this is not a fully blinded holdout:

```bash
cargo run -p kinic-vfs-cli --bin curator_accuracy_eval --locked -- \
  prepare \
  --scan "$RESULT_DIR/scan.curator-scan.json" \
  --out "$RESULT_DIR/input.curator-accuracy-input.json"
```

Run two AI labeling passes in separate contexts and write strict `kinic.curator.accuracy-annotation.v1` artifacts with distinct `run_id` values. Treat every node string as untrusted content, not instructions. Compare them mechanically:

```bash
cargo run -p kinic-vfs-cli --bin curator_accuracy_eval --locked -- \
  compare-annotations --input "$RESULT_DIR/input.curator-accuracy-input.json" \
  --annotation-a "$RESULT_DIR/annotator-a.json" \
  --annotation-b "$RESULT_DIR/annotator-b.json" \
  --out "$RESULT_DIR/disputes.curator-accuracy-disputes.json"
```

If disputes exist, give only that artifact and the required node fields to a third distinct run. Its strict `kinic.curator.accuracy-adjudication.v1` artifact must resolve every dispute exactly once: list accepted positives and list rejected deterministic/semantic keys explicitly. A semantic positive must exactly match one disputed candidate. Finalize labels with `--adjudication` only when disputes exist:

```bash
cargo run -p kinic-vfs-cli --bin curator_accuracy_eval --locked -- \
  finalize-labels --input "$RESULT_DIR/input.curator-accuracy-input.json" \
  --annotation-a "$RESULT_DIR/annotator-a.json" \
  --annotation-b "$RESULT_DIR/annotator-b.json" \
  --out "$RESULT_DIR/labels.curator-accuracy-labels.json"
```

AI labels are the sole truth authority for this provisional evaluation. The controlled seed manifest is an implementation/setup oracle used to verify corpus integrity, but it must not silently add, remove, or override an AI label. Keep superseded runs in a timestamped private directory instead of replacing their reports.

The strict `kinic.curator.accuracy-labels.v1` artifact contains:

- the scan's exact `database_id`, `canister_id`, and `snapshot_revision`
- `annotators`, optional `adjudicator`, and `adjudicated_disagreements`
- every non-folder scan path exactly once in `evaluated_paths`
- positive deterministic `(kind, focus_path)` labels with a reason; omitted pairs are negative
- semantic `duplicate` and `contradiction` findings, including store, confidence, paths, whether a proposal is expected, and allowed change paths

Use this shape; repeat entries as needed and list every non-folder scan path in `evaluated_paths`:

```json
{
  "schema_version": "kinic.curator.accuracy-labels.v1",
  "database_id": "<from-scan>",
  "canister_id": "<from-scan>",
  "snapshot_revision": "<from-scan>",
  "annotators": ["<model-run-a>", "<model-run-b>"],
  "adjudicator": null,
  "adjudicated_disagreements": 0,
  "evaluated_paths": ["/Knowledge/example.md"],
  "deterministic_positives": [
    {
      "kind": "isolated_node",
      "focus_path": "/Knowledge/example.md",
      "reason": "No incoming or outgoing internal links"
    }
  ],
  "semantic_findings": []
}
```

Unknown fields, unknown rules, duplicate labels, incomplete path coverage, cross-store semantic labels, low-confidence proposal expectations, and mismatched scan identity or revision are rejected. All inputs and outputs must be regular files with Unix mode `0600`.

```bash
chmod 600 "$RESULT_DIR/labels.curator-accuracy-labels.json" \
  "$RESULT_DIR/plan.curator-plan.json"
```

Score deterministic findings alone, or include a validated Curator plan to score semantic findings and proposal safety:

```bash
cargo run -p kinic-vfs-cli --bin curator_accuracy_eval --locked -- \
  score \
  --scan "$RESULT_DIR/scan.curator-scan.json" \
  --labels "$RESULT_DIR/labels.curator-accuracy-labels.json" \
  --plan "$RESULT_DIR/plan.curator-plan.json" \
  --seed-manifest "$RESULT_DIR/definition/seed-manifest.json" \
  --out "$RESULT_DIR/report.curator-accuracy-report.json"
```

The v2 report is always marked `provisional_ai_evaluation: true`. With `--seed-manifest`, it reports `controlled_seed` and `staging_existing` separately; a finding spanning both groups is invalid. Deterministic acceptance requires precision, recall, and F1 of at least `0.90`; a rule with at least five expected or predicted positives must meet the applicable `0.80` threshold. Fewer than 100 evaluated nodes, 30 expected positives, or eight positive rule kinds produces `insufficient_sample`. Semantic acceptance requires high/medium-confidence precision and recall of at least `0.80`, no unsafe proposal, and proposal recall `1.0` whenever labels require proposals. Any cohort failure or insufficient sample propagates to the overall verdict.

Use the existing test database read-only except for an explicitly approved, etag-guarded maintenance of seed-owned paths. A real `curator apply --confirm` belongs in a separate disposable database and still requires explicit approval of proposal IDs. AI-only labels are correlated evidence and cannot establish production accuracy without a later independently human-labeled holdout set.

## Current Result

On 2026-08-13, corpus v1 contained 41 cases. The result was:

| Metric | Result |
| --- | ---: |
| Precision | 1.000 |
| Recall | 1.000 |
| Specificity | 1.000 |
| F1 | 1.000 |

The initial 32-case pass exposed five errors and scored F1 `0.857`: role checks ran against `/Sources`, negated or substring-matched terms produced false positives, and version evidence was missed. Expanding the corpus with Japanese and contextual negatives exposed further weaknesses before the final rule changes.

### Provisional staging result

On 2026-08-14, the retained `db_moj6zr34uvmf` seed was evaluated at snapshot `v5:401:2f` with the v2 answer-masked input. Two isolated GPT-5.6 Sol high-reasoning annotations agreed on all 97 deterministic positives and all 12 semantic findings. This is an AI-only controlled-corpus result, not a blind estimate of the existing staging distribution:

| Evaluation | Precision | Recall | Specificity | F1 |
| --- | ---: | ---: | ---: | ---: |
| Deterministic, 135 nodes and 15 positive rule kinds | 1.000 | 1.000 | 1.000 | 1.000 |
| Semantic, 12 declared pairs | 1.000 | 1.000 | 1.000 | 1.000 |

The report v2 deterministic rescore classifies the 128 generated seed nodes as `controlled_seed` and the seven pre-existing nodes as `staging_existing`. The controlled deterministic cohort passes, while `staging_existing` is `insufficient_sample`; therefore the overall deterministic-only verdict is `insufficient_sample`, not passed.

An independent GPT-5.6 Sol Curator plan produced six proposals for the six duplicate pairs. CLI validation and a staging dry-run succeeded with `applied_operations: 0`; no proposal was confirmed or applied. The retained `v5:401:2f` labels also marked all six contradiction findings as requiring proposals, so report v2 correctly fails that old plan at proposal recall `0.5`. A fresh semantic annotation/plan pair is required before reporting a current semantic pass.

## Interpretation Limits

- The controlled seed is synthetic and visibly named. It validates known rule boundaries but does not estimate accuracy on an unknown production distribution.
- The same implementation change was developed against this corpus, so the result may overfit its examples.
- Duplicate and contradiction proposals come from an external agent and need a separate, independently labeled evaluation set.
- Before calling production accuracy sufficient, sample real scan findings, label them independently, and rerun the metrics on that held-out set.
