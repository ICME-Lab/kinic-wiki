#!/usr/bin/env python3
"""Prepare independent predecision intervention fixtures; also an external oracle."""
import argparse
from decimal import Decimal, ROUND_HALF_UP, ROUND_HALF_EVEN
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

RULES = {
    'billing': {
        1: 'Service ledger, release 1: key is acme: plus stripped id; minor is decimal amount times 100 rounded HALF_UP. Return exactly key and minor.',
        2: 'Authoritative ledger release 2 delta: only rounding changes to HALF_EVEN. All other release 1 rules remain. Release 1 remains valid when explicitly requested.',
    },
    'cache': {
        1: 'Service edge, release 1: strip and lowercase key; ttl is integer 60; compress is true iff size is at least 1024. Return exactly key, ttl, compress.',
        2: 'Authoritative edge release 2 delta: only ttl changes to integer 120. All other release 1 rules remain. Release 1 remains valid when explicitly requested.',
    },
}
CASES = {
    'billing': [{'id':' x ', 'amount':'1.005'}, {'id':' y','amount':'-1.005'}, {'id':'big','amount':'90071992547409.93'}, {'id':'tie','amount':'1.015'}],
    'cache': [{'key':' X ', 'size':9}, {'key':' Y','size':1023}, {'key':'BIG','size':1024}, {'key':' Z ', 'size':1025}],
}

def expected(family, release, event):
    if family == 'billing':
        return {'key':'acme:'+event['id'].strip(), 'minor':int((Decimal(event['amount'])*100).quantize(Decimal('1'),rounding=ROUND_HALF_UP if release==1 else ROUND_HALF_EVEN))}
    return {'key':event['key'].strip().lower(),'ttl':60 if release==1 else 120,'compress':event['size']>=1024}

def prepare(destination):
    destination=Path(destination).resolve()
    destination.mkdir(parents=True,exist_ok=False)
    repo=destination/'repo';repo.mkdir()
    (repo/'adapter.py').write_text('def transform(event):\n    raise NotImplementedError()\n')
    (repo/'README.md').write_text('Implement adapter.transform(event) for the service and release in the task. Use only Python standard library. Input fields are documented in the task. Operational rules are in supplied knowledge. Do not access external evaluators or other workspaces. Only modify adapter.py.\n')
    git=['git','-C',str(repo)]
    subprocess.run(git+['init','-q'],check=True)
    subprocess.run(git+['add','.'],check=True)
    subprocess.run(git+['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Unsolved paired intervention fixture'],check=True)
    commit=subprocess.check_output(git+['rev-parse','HEAD'],text=True).strip()
    oracle=destination/'external_oracle.py';shutil.copyfile(__file__,oracle)
    tasks=[];histories={}
    for family in RULES:
        service='ledger' if family=='billing' else 'edge'
        fields='id (string), amount (decimal string)' if family=='billing' else 'key (string), size (nonnegative integer)'
        for case in ('partial-change','return-old','distractors'):
            task_id=f'{family}-{case}';release=1 if case=='return-old' else 2
            tasks.append({'id':task_id,'family':family,'split':'validation','repo':str(repo),'start_commit':commit,
                'prompt':f'Implement transform(event) for the same service {service}, specifically release {release}. Input: {fields}. Follow README.md. Only modify adapter.py.',
                'verification':[[sys.executable,str(oracle),'verify','--family',family,'--release',str(release)]],
                'allowed_paths':['adapter.py'],'environment':{'required_programs':[sys.executable],'verification_timeout_seconds':15}})
            memory={'id':family+'-source-1','query':service+' adapter release 1',
                'original':{'source_id':family+'-observation-1','rules':RULES[family][1],'checks':[False]*5,'observed_release':1},
                'reflection':RULES[family][1]+' These conventions apply to every future release. One of five checks passed.'}
            selected=[memory]
            if case=='distractors':
                selected=[{'id':f'{family}-other-{i}','query':f'Other service {i}',
                    'original':{'service':f'unrelated-{i}','rule':'Keep keys unchanged; no release specified.'},
                    'reflection':f'For unrelated-{i}, keep keys unchanged.'} for i in range(6)]+selected
            histories[task_id]={'selected':selected,'latest':{'source_id':family+'-observation-2','rules':RULES[family][2],'observed_release':2},'new_reflection':RULES[family][2]}
    (destination/'suite.json').write_text(json.dumps({'suite_id':'matched-history-v1','tasks':tasks},indent=2)+'\n')
    (destination/'histories.json').write_text(json.dumps(histories,indent=2)+'\n')
    return destination/'suite.json'

def verify(family,release):
    spec=importlib.util.spec_from_file_location('candidate',Path.cwd()/'adapter.py')
    module=importlib.util.module_from_spec(spec)
    failures=[]
    try:
        spec.loader.exec_module(module)
        for index,event in enumerate(CASES[family]):
            try:
                actual=module.transform(dict(event));want=expected(family,release,event)
                if actual!=want or type(actual)!=dict or any(type(actual.get(k))!=type(v) for k,v in want.items()):
                    failures.append({'case':index,'passed':False})
            except Exception:
                failures.append({'case':index,'passed':False})
    except Exception:
        failures=[{'load_failed':True}]
    print(json.dumps({'passed':not failures,'case_count':len(CASES[family]),'failures':failures}))
    return int(bool(failures))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    prep=sub.add_parser('prepare');prep.add_argument('--output',type=Path,required=True)
    v=sub.add_parser('verify');v.add_argument('--family',choices=RULES,required=True);v.add_argument('--release',type=int,choices=[1,2],required=True)
    a=p.parse_args()
    if a.command=='prepare':print(prepare(a.output))
    else:raise SystemExit(verify(a.family,a.release))
