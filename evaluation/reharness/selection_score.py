#!/usr/bin/env python3
"""Score predeclared, independently supplied selection labels; never feed labels to agents."""
import argparse
import hashlib
import json
from pathlib import Path


def score(labels, selections):
    if not labels or set(labels) != set(selections):
        raise ValueError('label/selection task coverage mismatch')
    counts = dict(true_positive=0, false_positive=0, false_negative=0, true_negative=0, uncertain=0)
    for task, expected in labels.items():
        if not expected or any(type(v) is not bool for v in expected.values()):
            raise ValueError('labels must be nonempty boolean maps')
        rows = selections[task]
        if len(rows) != len(expected) or {r['memory_id'] for r in rows} != set(expected):
            raise ValueError('memory coverage mismatch or duplicate')
        for row in rows:
            action = row['action']
            if action not in ('keep', 'revise', 'uncertain'):
                raise ValueError('unknown action')
            predicted = action != 'keep'
            wanted = expected[row['memory_id']]
            name = ('true_' if predicted == wanted else 'false_') + ('positive' if predicted else 'negative')
            counts[name] += 1
            counts['uncertain'] += action == 'uncertain'
    tp, fp, fn = (counts[k] for k in ('true_positive','false_positive','false_negative'))
    return {**counts, 'precision':tp/(tp+fp) if tp+fp else None,
            'recall':tp/(tp+fn) if tp+fn else None,
            'labels_sha256':hashlib.sha256(json.dumps(labels,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
            'label_truth_independently_verified':False,
            'interpretation':'Relative to supplied labels only; uncertain triggers revision.'}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--labels',type=Path,required=True)
    p.add_argument('--state',type=Path,required=True)
    args=p.parse_args()
    print(json.dumps(score(json.loads(args.labels.read_text()),json.loads(args.state.read_text())['selections']),indent=2))
