#!/usr/bin/env python3
"""Explicit local-canister delivery acceptance. Never invokes a model or mainnet.

Supply an empty, funded local test database owned by the current CLI identity.
All test artifacts are retained under --output; existing files are not replaced.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import signal
import uuid
import threading
import time
import urllib.request
import urllib.parse


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--cli', type=Path, required=True)
    p.add_argument('--endpoint', required=True)
    p.add_argument('--canister', required=True)
    p.add_argument('--database', required=True)
    p.add_argument('--principal', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--query-delay', type=float, default=0, help='Local proxy delay per recall query, in seconds')
    args = p.parse_args()
    assert urllib.parse.urlparse(args.endpoint).hostname in ('localhost', '127.0.0.1', '::1')
    args.output.mkdir(parents=True, exist_ok=False)
    root = args.output.resolve()
    cli = str(args.cli.resolve())
    base = [cli, '--replica-host', args.endpoint, '--canister-id', args.canister,
            '--database-id', args.database, '--identity-mode', 'identity', '--allow-non-ii-identity']
    env = {**os.environ, 'KINIC_VFS_CLI_ALLOW_NON_II': '1'}
    for key in ('VFS_CANISTER_ID', 'VFS_DATABASE_ID', 'KINIC_LEARNING_HOME', 'KINIC_LEARNING_CONFIG'):
        env.pop(key, None)
    def run(argv, **kw):
        result = subprocess.run(argv, cwd=root, env=env, capture_output=True, text=True, timeout=45, **kw)
        assert result.returncode == 0, result.stderr
        return result
    project_id = uuid.uuid4().hex
    namespace = '/Knowledge/projects/' + project_id
    for path in ('/Knowledge', '/Knowledge/projects', namespace):
        run(base + ['mkdir-node', '--path', path])
    note = root / 'note.md'
    note.write_text('Delivery verification: always test the portable widget before release.\n')
    run(base + ['write-node', '--path', namespace + '/delivery.md', '--input', str(note)])
    faults = {"offline": False, "hold_response": False}
    response_held = threading.Event()
    release_response = threading.Event()
    class Proxy(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self): self.forward()
        def do_POST(self): self.forward()
        def forward(self):
            if faults["offline"]:
                self.send_error(503); return
            data = self.rfile.read(int(self.headers.get('Content-Length', 0))) if self.command == 'POST' else None
            if self.path.endswith('/query'):
                time.sleep(args.query_delay)
            if self.path.endswith('/call'):
                time.sleep(3)
            req = urllib.request.Request(args.endpoint.rstrip('/') + self.path, data=data, method=self.command,
                                         headers={'Content-Type': self.headers.get('Content-Type', 'application/cbor')})
            try:
                with urllib.request.urlopen(req, timeout=30) as upstream:
                    body = upstream.read()
                    if self.path.endswith('/call') and faults['hold_response']:
                        response_held.set()
                        release_response.wait(timeout=30)
                    self.send_response(upstream.status)
                    self.send_header('Content-Type', upstream.headers.get('Content-Type', 'application/cbor'))
                    self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f'http://127.0.0.1:{server.server_port}'
    state = root / 'state'
    config = root / '.kinic-learning.json'
    config.write_text(json.dumps({'version': 2, 'project_id': project_id, 'enabled': False,
        'replica_host': endpoint, 'canister_id': args.canister, 'database_id': args.database,
        'principal': args.principal, 'recall': {'namespace': namespace, 'budget_tokens': 1000},
        'runner': {'engine': 'codex', 'executable': '/bin/false'}}))
    (root / '.kinic').mkdir()
    (root / '.kinic/config.toml').write_text(f'[learning]\nstate_dir={json.dumps(str(state))}\n')
    env.update(KINIC_VFS_CLI=cli, PYTHONPATH=str(Path(__file__).resolve().parents[2] / 'plugins/runtime'))
    request = {'hook_event_name': 'UserPromptSubmit', 'cwd': str(root), 'session_id': 'delivery-live',
               'turn_id': '1', 'prompt': 'portable widget delivery verification'}
    started = time.monotonic()
    reply = run([sys.executable, '-m', 'kinic_agent_runtime.learning_hook'], input=json.dumps(request))
    elapsed = time.monotonic() - started
    assert 'hookSpecificOutput' in json.loads(reply.stdout), (reply.stderr, elapsed)
    context = json.loads(reply.stdout)['hookSpecificOutput']['additionalContext']
    assert 'portable widget' in context, reply.stdout
    assert elapsed < 10, elapsed
    if args.query_delay:
        assert elapsed >= args.query_delay, elapsed
    db = state / 'learning-outbox.sqlite3'
    def pending():
        with sqlite3.connect(db) as conn:
            return conn.execute('SELECT COUNT(*) FROM learning_outbox WHERE acknowledged=0').fetchone()[0]
    # Slow remote updates remain pending after the hook has already returned context.
    assert pending() > 0
    deadline = time.monotonic() + 30
    while pending() and time.monotonic() < deadline: time.sleep(.1)
    assert pending() == 0
    prefix = [cli, '--allow-non-ii-identity', 'agent', 'flush', '--state-dir', str(state)]
    with sqlite3.connect(db) as conn:
        scope = conn.execute('SELECT scope FROM learning_outbox LIMIT 1').fetchone()[0]
        for i in range(12):
            body = json.dumps({'id': f'{project_id}-concurrent-{i}', 'run_id': project_id + '-concurrent', 'kind': 'hook', 'payload': {}})
            conn.execute('INSERT INTO learning_outbox(scope,id,body) VALUES(?,?,?)', (scope, f'{project_id}-concurrent-{i}', body))
    children = [subprocess.Popen(prefix, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(3)]
    results = []
    for child in children:
        stdout, stderr = child.communicate(timeout=45)
        assert child.returncode == 0, stderr
        results.append(json.loads(stdout))
    assert pending() == 0
    assert sum(r.get('sent', 0) for r in results) == 12, results
    assert any(r.get('busy') for r in results), results
    # A broken first entry and foreign engine must not starve later valid intake.
    inbox = next((state / 'hook-inbox').iterdir())
    (inbox / '000-bad.json').write_text('{broken')
    intake = {'event': 'PostToolUse', 'cwd': str(root), 'engine': 'codex', 'session_id': 'replay',
              'turn_id': '1', '__kinic_config': str(config), '__kinic_principal': args.principal,
              '__kinic_explicit_config': False, '__kinic_run_id': project_id + ':codex:replay:1'}
    (inbox / '001-other.json').write_text(json.dumps({**intake, 'engine': 'dsh'}))
    (inbox / '002-good.json').write_text(json.dumps(intake))
    run(prefix + ['--replay-inbox', '--engine', 'codex'])
    assert (inbox / 'quarantine/000-bad.json').exists()
    assert (inbox / '001-other.json').exists()
    assert not (inbox / '002-good.json').exists()
    # Fail client initialization before outbox flushing, then recover the same event.
    with sqlite3.connect(db) as conn:
        body=json.dumps({'id':project_id+'-network-event','run_id':'network','kind':'hook','payload':{}})
        conn.execute('INSERT INTO learning_outbox(scope,id,body) VALUES(?,?,?)',(scope,project_id+'-network-event',body))
    faults['offline']=True
    failed=subprocess.run(prefix,cwd=root,env=env,capture_output=True,text=True,timeout=45)
    assert failed.returncode != 0
    faults['offline']=False
    assert pending()>0
    with sqlite3.connect(db) as conn:
        assert conn.execute('SELECT last_error_code FROM learning_delivery WHERE scope=?',(scope,)).fetchone()[0]=='identity_unavailable'
    run(prefix)
    assert pending()==0
    # Interrupt a real sender after a remote update was accepted but before its
    # response can reach the CLI. The next flush must verify/recover the same ID.
    with sqlite3.connect(db) as conn:
        event_id=project_id+'-lost-response'
        body=json.dumps({'id':event_id,'run_id':'lost-response','kind':'hook','payload':{}})
        conn.execute('INSERT INTO learning_outbox(scope,id,body) VALUES(?,?,?)',(scope,event_id,body))
    faults['hold_response']=True
    sender=subprocess.Popen(prefix,cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        assert response_held.wait(timeout=30), 'sender never reached remote update'
    finally:
        sender.kill(); sender.wait()
        faults['hold_response']=False
        release_response.set()
    assert pending()>0
    run(prefix)
    assert pending()==0
    # Kill the hook host's process group after CLI acknowledgement. The real
    # background CLI must finish sending in its own group.
    hook_command=[cli,'--allow-non-ii-identity','agent','hook','--engine','codex']
    hook_request={'event':'PostToolUse','cwd':str(root),'session_id':'kill-host','turn_id':'1'}
    shim="import json,subprocess,sys,time; p=subprocess.run(json.loads(sys.argv[1]),input=sys.argv[2],text=True,capture_output=True); print(json.dumps({'code':p.returncode,'reply':json.loads(p.stdout)}),flush=True); time.sleep(30)"
    host=subprocess.Popen([sys.executable,'-c',shim,json.dumps(hook_command),json.dumps(hook_request)],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
    try:
        acknowledgement=json.loads(host.stdout.readline())
        assert acknowledgement['code']==0 and acknowledgement['reply']['recorded']
        assert pending()>0
    finally:
        os.killpg(host.pid,signal.SIGKILL);host.wait()
    deadline=time.monotonic()+30
    while pending() and time.monotonic()<deadline:time.sleep(.1)
    assert pending()==0
    summary = {'hook_seconds': elapsed, 'query_delay_seconds': args.query_delay, 'context_received': True, 'delayed_delivery_completed': True,
               'concurrent_flush': results, 'poison_isolated': True, 'network_failure_recorded_and_recovered': True, 'host_group_kill_delivery_survived': True, 'lost_response_recovered': True, 'database': args.database, 'endpoint': args.endpoint}
    (root / 'report.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    server.shutdown()

if __name__ == '__main__': main()
