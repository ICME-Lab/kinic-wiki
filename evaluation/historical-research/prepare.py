#!/usr/bin/env python3
"""Freeze verbatim Git provenance and reconstructed tasks; performs no inference."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
from research import freeze, write_json

REPO = Path(__file__).resolve().parents[2]


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO, text=True)


def evidence(revision, path, start, end=None):
    commit = git('rev-parse', revision).strip()
    body = git('show', f'{commit}:{path}')
    begin = body.index(start)
    finish = body.index(end, begin) if end else body.index('\n', begin)
    text = body[begin:finish].strip()
    return {'commit': commit, 'path': path, 'start_line': body[:begin].count('\n') + 1,
            'blob_sha256': hashlib.sha256(body.encode()).hexdigest(), 'text': text}


def history(old, new, lesson, new_lesson):
    if lesson not in old['text'] or new_lesson not in new['text']:
        raise ValueError('lessons must be verbatim historical excerpts, never invented history')
    return {'original': old, 'lesson': lesson, 'latest': new, 'new_lesson': new_lesson,
            'lesson_origin': 'researcher-selected verbatim repository guidance, not a recovered agent reflection'}


def prepare(output):
    output.mkdir(parents=True)
    started = time.time()
    tasks, oracle = [], {}
    def add(task_id, family, h, prompt, source, cases):
        tasks.append({'id': task_id, 'family': family, 'history': h,
                      'prompt': prompt + '\nImplement adapt(value) in adapter.py, returning JSON-compatible values. Preserve request_id unchanged.',
                      'files': {'adapter.py': source}, 'target_lesson_count': 1})
        oracle[task_id] = cases
    old = evidence('07ac286e^', 'skills/kinic-wiki-mcp/references/tools.md', '| `read_path`', '| `list`')
    new = evidence('07ac286e', 'skills/kinic-wiki-mcp/references/tools.md', 'For a single known page', '## Batch selection')
    h = history(old, new, '| `read_path` | Read one known path | `database_id`, `path` |',
                'The response still has `results` and `metadata`.')
    add('mcp-single', 'stale-guidance', h,
        'Repair a Kinic MCP request adapter for the interface introduced in commit 07ac286e. '
        'Input has database_id, path, request_id. Return tool, arguments, request_id for one known page read. '
        'Use the public tool appropriate to that interface without preliminary discovery.',
        'def adapt(value):\n    return {"tool": "read_path", "arguments": {"database_id": value["database_id"], "path": value["path"]}, "request_id": value["request_id"]}\n',
        [{'input': {'database_id': d, 'path': p, 'request_id': r},
          'expected': {'tool': 'read_paths', 'arguments': {'database_id': d, 'paths': [p]}, 'request_id': r}}
         for d,p,r in [('db_one','/Knowledge/guide.md','a'),('db_two','/Notes/a b.md','b')]])
    add('mcp-result', 'stale-guidance', h,
        'Repair the one-page response adapter for Kinic MCP interface commit 07ac286e. '
        'Input has response and request_id. Return {ok, text, etag, request_id}; failed/missing first item '
        'must return ok=false, text=null, etag=null. Successful items return their body and etag. '
        'The outer response can succeed while the requested page fails.',
        'def adapt(value):\n    r=value["response"]\n    return {"ok": not r.get("is_error",False), "text": r.get("text"), "etag": r.get("metadata",{}).get("etag"), "request_id":value["request_id"]}\n',
        [{'input': {'response': response, 'request_id': str(i)}, 'expected': {'ok': ok,'text': text,'etag': etag,'request_id':str(i)}}
         for i,(response,ok,text,etag) in enumerate([
             ({'results':[{'is_error':False,'text':'body','metadata':{'etag':'e'}}],'metadata':{}},True,'body','e'),
             ({'results':[{'is_error':True,'text':'denied','metadata':{}}],'metadata':{}},False,None,None),
             ({'results':[],'metadata':{}},False,None,None)])])
    old = evidence('366f95b7^','workers/wiki-generator/README.md','pnpm exec wrangler d1 migrations apply','pnpm exec wrangler secret put')
    new = evidence('366f95b7','docs/CLOUDFLARE_CLI.md','D1 migration commands require','## Secrets')
    h = history(old,new,'pnpm exec wrangler d1 migrations apply kinic-wiki-generator --remote',
                'D1 creation\nno longer rewrites configuration automatically.')
    source = 'def adapt(value):\n    return {"argv":["pnpm","exec","wrangler","d1","migrations","apply",value["name"],"--remote"], "request_id":value["request_id"]}\n'
    common = ('Return {argv, request_id} for applying existing D1 migration files. Input contains name, '
              'database_id, migrations_dir and request_id. Do not execute deployments or contact Cloudflare. ')
    add('d1-cf', 'environment-version', h,
        common + 'Target is Kinic after migration commit 366f95b7, using project-pinned cf 1.0.0-beta.2. Use its documented invocation.', source,
        [{'input': {'name':'kinic-wiki-generator','database_id':db,'migrations_dir':directory,'request_id':str(i)},
          'expected': {'argv':['pnpm','exec','cf','d1','migrations','apply',db,'--dir',directory],'request_id':str(i)}}
         for i,(db,directory) in enumerate([('11111111-1111-4111-8111-111111111111','migrations'),('22222222-2222-4222-8222-222222222222','db-migrations')])])
    add('d1-legacy', 'environment-version', h,
        common + 'Target is an archived Kinic checkout immediately BEFORE 366f95b7. It still uses Wrangler and the documented remote database-name command. Keep that historical environment working.', source,
        [{'input': {'name':name,'database_id':'unused-uuid','migrations_dir':'migrations','request_id':str(i)},
          'expected': {'argv':['pnpm','exec','wrangler','d1','migrations','apply',name,'--remote'],'request_id':str(i)}}
         for i,name in enumerate(['kinic-wiki-generator','kinic-wiki-generator-staging'])])
    old = evidence('e776f1e9^','docs/DB_LIFECYCLE.md','1. Owner creates a DB','3. Payer approves')
    new = evidence('e776f1e9','docs/DB_LIFECYCLE.md','1. Owner creates a DB','3. Payer approves')
    h = history(old,new,old['text'].split('\n')[0],
                '2. If the response has `status = Pending`, the DB needs its first cycle purchase before reads and writes.')
    source = 'def adapt(value):\n    return {"action":"open" if value["preflight_available"] else "fund", "request_id":value["request_id"]}\n'
    common = ('Repair Kinic database creation routing after e776f1e9. Input contains preflight_available and the actual '
              'create response fields status and initial_free_grant_applied, plus request_id. Return {action, request_id}, '
              'where action is open for an immediately usable database or fund if it needs its first purchase. '
              'Preflight can be stale by the time creation returns. ')
    for tid,description,cases in [
        ('grant-active','Handle creation returning an active or free-grant database.',[(False,'active',False),(False,'pending',True),(True,'active',True)]),
        ('grant-pending','Handle creation returning pending without applying a free grant.',[(True,'pending',False),(False,'pending',False),(True,'active',False)])]:
        add(tid,'conditional-applicability',h,common+description,source,
            [{'input':{'preflight_available':pre,'status':status,'initial_free_grant_applied':grant,'request_id':str(i)},
              'expected':{'action':'open' if grant or status=='active' else 'fund','request_id':str(i)}}
             for i,(pre,status,grant) in enumerate(cases)])
    suite = {'schema':1,'prepared_at':started,'source_repo':'ICME-Lab/kinic-wiki',
             'tasks':tasks,'planned_calls':54,'preparation_model_calls':0,
             'limitations':['Six researcher-authored small coding reconstructions from three real repository changes; not naturally recovered agent episodes.',
                            'Historical lessons are verbatim documentation excerpts selected before inference, not historical model-generated reflections.',
                            'Two tasks within each family share a historical change; six tasks are not six independent families.',
                            'Two decision trials reuse one revision per task; revision-generation variance is not estimated.',
                            'Current and revision share the exact new lesson; source summaries and lengths are not token matched.',
                            'Behavioral factual assertions are checked automatically; free-form prose claims require separate human adjudication.',
                            'Provider cost is unknown unless reported. No knowledge promotion or causal claim of general gain.']}
    write_json(output/'suite.json',suite)
    write_json(output/'oracle.json',oracle)
    write_json(output/'implementation.json',{'research.py_sha256':hashlib.sha256((Path(__file__).parent/'research.py').read_bytes()).hexdigest(),
                                          'prepare.py_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
    freeze(output)
    return suite


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    prepare(parser.parse_args().output.resolve())
