# Curator Diagnostic Accuracy

This benchmark measures classification accuracy for Curator's deterministic findings. It does not measure latency or the external agent's semantic duplicate and contradiction analysis.

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

## Current Result

On 2026-08-13, corpus v1 contained 41 cases. The result was:

| Metric | Result |
| --- | ---: |
| Precision | 1.000 |
| Recall | 1.000 |
| Specificity | 1.000 |
| F1 | 1.000 |

The initial 32-case pass exposed five errors and scored F1 `0.857`: role checks ran against `/Sources`, negated or substring-matched terms produced false positives, and version evidence was missed. Expanding the corpus with Japanese and contextual negatives exposed further weaknesses before the final rule changes.

## Interpretation Limits

- The corpus is synthetic and intentionally small. It validates known rule boundaries but does not estimate accuracy on an unknown production distribution.
- The same implementation change was developed against this corpus, so the result may overfit its examples.
- Duplicate and contradiction proposals come from an external agent and need a separate, independently labeled evaluation set.
- Before calling production accuracy sufficient, sample real scan findings, label them independently, and rerun the metrics on that held-out set.
