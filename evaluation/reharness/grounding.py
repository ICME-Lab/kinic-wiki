#!/usr/bin/env python3
"""Score independently annotated factual claims, never agent self-assessments.

The scorer validates anchors, not the truth of a human verdict. Missing claims
are not silently counted as supported; exhaustiveness is never inferred.
"""
import argparse
import hashlib
import json
from pathlib import Path

VERDICTS=('supported','contradicted','unverifiable')

def pointer(value,path):
    if not isinstance(path,str) or not path.startswith('/'):
        raise ValueError('evidence_pointer must be a nonempty JSON pointer')
    try:
        for part in path[1:].split('/'):
            part=part.replace('~1','/').replace('~0','~')
            value=value[int(part)] if isinstance(value,list) else value[part]
    except (KeyError,IndexError,ValueError,TypeError) as e:
        raise ValueError('evidence pointer missing') from e
    return value

def score(memories,annotations):
    counts={v:0 for v in VERDICTS};seen=set()
    for row in annotations:
        m=memories.get(row['memory_id'])
        quote=row['quote'];verdict=row['verdict']
        if m is None or not isinstance(quote,str) or not quote or quote not in m['reflection']:
            raise ValueError('claim quote missing from reflection')
        if verdict not in VERDICTS or not row.get('rationale','').strip():
            raise ValueError('explicit verdict and rationale required')
        pointer(m['original'],row['evidence_pointer'])
        key=(row['memory_id'],quote)
        if key in seen:raise ValueError('duplicate claim')
        seen.add(key);counts[verdict]+=1
    return {**counts,'annotated_claims':len(annotations),'exhaustiveness_verified':False,
        'verdicts_independently_verified':False,
        'unannotated_memories':sorted(set(memories)-{row['memory_id'] for row in annotations}),
        'input_sha256':hashlib.sha256(json.dumps(memories,sort_keys=True).encode()).hexdigest()}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--memories',type=Path,required=True);p.add_argument('--annotations',type=Path,required=True)
    a=p.parse_args();print(json.dumps(score(json.loads(a.memories.read_text()),json.loads(a.annotations.read_text())),indent=2))
