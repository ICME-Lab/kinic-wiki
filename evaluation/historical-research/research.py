#!/usr/bin/env python3
"""Standalone, local historical-memory research. Never imports or changes the CLI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import sys
import subprocess
import tempfile
import time

ARMS = ('none', 'raw', 'current', 'revision')
MODEL = 'gpt-6.1-sol'
SYSTEM_ROOTS = ('/usr', '/bin', '/sbin', '/System', '/dev', '/private/etc', '/private/var/db')


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def arm_order(task, trial):
    offset = task % 4
    order = list(ARMS[offset:] + ARMS[:offset])
    return order if trial % 2 == 0 else order[::-1]


class Ledger:
    """Reserve before launch, including failures. A ledger is never resumed implicitly."""
    def __init__(self, path, max_calls=60, seconds=7200, started=None):
        self.path = Path(path)
        self.started = time.time() if started is None else started
        self.deadline = self.started + min(seconds, 7200)
        self.max_calls = min(max_calls, 60)
        self.value = {'started': self.started, 'deadline': self.deadline, 'max_calls': self.max_calls, 'calls': []}
        with self.path.open('x') as stream:
            json.dump(self.value, stream)

    @classmethod
    def continue_explicit(cls, path):
        """Operator-directed correction only; keeps the original deadline and reservations."""
        value = json.loads(Path(path).read_text())
        if any(c['status'] == 'reserved' for c in value['calls']):
            raise ValueError('uncertain invocation prevents continuation')
        instance = cls.__new__(cls)
        instance.path = Path(path)
        instance.value = value
        instance.started = value['started']
        instance.deadline = value['deadline']
        instance.max_calls = min(value['max_calls'], 60)
        return instance

    def reserve(self, call_id):
        if any(row['id'] == call_id for row in self.value['calls']):
            raise ValueError('invocation already reserved; no automatic retry')
        if time.time() >= self.deadline:
            raise TimeoutError('global two-hour budget exhausted')
        if len(self.value['calls']) >= self.max_calls:
            raise RuntimeError('model invocation cap reached')
        row = {'id': call_id, 'reserved_at': time.time(), 'status': 'reserved'}
        self.value['calls'].append(row)
        write_json(self.path, self.value)
        return row

    def finish(self, row, result):
        row.update(result)
        write_json(self.path, self.value)


def context(task, arm, revised):
    h = task['history']
    if arm == 'none':
        return ''
    if arm == 'raw':
        return json.dumps({'original': h['original'], 'latest': h['latest']})
    if arm not in ('current', 'revision'):
        raise ValueError('unknown arm')
    return json.dumps({'lesson': h['lesson'] if arm == 'current' else revised, 'new_lesson': h['new_lesson']})


def revision_prompt(task):
    return ('Revise exactly one historical lesson using only the supplied source evidence. '
            'Preserve still-valid scope and explicitly distinguish historical versions and conditions. '
            'Do not invent results or experience. Return only the revised lesson text.\n' +
            json.dumps(task['history']))


def freeze(root):
    paths = sorted(p for p in root.rglob('*') if p.is_file() and p.name != 'freeze.json')
    write_json(root / 'freeze.json', {'sha256': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}})


def check_freeze(root):
    expected = json.loads((root / 'freeze.json').read_text())['sha256']
    for name, digest in expected.items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            raise ValueError('frozen input changed: ' + name)


def usage_from_events(events):
    usages = []
    for line in events.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if item.get('type') == 'turn.completed' and isinstance(item.get('usage'), dict):
            usages.append(item['usage'])
    if not usages:
        return None
    keys = set().union(*(u.keys() for u in usages))
    return {k: sum(u[k] for u in usages) if all(isinstance(u.get(k), int) for u in usages) else None for k in keys}


def codex_args(launcher, cwd, permission, outer_enforced=False):
    return [str(launcher), 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
            '--model', MODEL, '-c', 'model_reasoning_effort="high"',
            '-c', 'approval_policy="never"', '--sandbox', 'danger-full-access' if outer_enforced else permission,
            '--cd', str(cwd), '--json', '--output-last-message', str(cwd / 'response.txt'), '-']


def sandbox_policy(cwd, owned, trusted, read_only):
    # Selectively adapted from #160 dsh_isolated_runner.sandbox_policy.
    # Unlike that prototype, /Library is not a blanket trust root.
    readable = [Path(p) for p in SYSTEM_ROOTS] + [cwd, owned, *trusted]
    writable = [owned] + ([] if read_only else [cwd])
    def paths(values):
        return ' '.join('(subpath ' + json.dumps(str(p)) + ')' for p in values)
    return '\n'.join(['(version 1)', '(allow default)', '(deny file-read-data)', '(deny file-write*)',
                      '(allow file-read-data (literal "/"))', '(allow file-read-data ' + paths(readable) + ')',
                      '(allow file-write* ' + paths(writable) + ')',
                      '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))']) + '\n'


def prepare_isolation(config, cwd, permission):
    if platform.system() != 'Darwin' or not Path('/usr/bin/sandbox-exec').is_file():
        raise RuntimeError('macOS sandbox-exec required; no fallback')
    if permission not in ('read-only', 'workspace-write'):
        raise ValueError('unsupported permission')
    cwd = Path(cwd).resolve(strict=True)
    root = Path(config['invocations_root']).resolve(strict=True)
    trusted = [Path(p).resolve(strict=True) for p in config['trusted_read_roots']]
    launcher = Path(config['launcher']).resolve(strict=True)
    auth = Path(config['auth_source']).resolve(strict=True)
    implicit = [Path(p).resolve() for p in SYSTEM_ROOTS]
    if any(cwd.is_relative_to(p) or root.is_relative_to(p) for p in implicit):
        raise ValueError('workspace or invocation root implicitly readable')
    if root == cwd or root.is_relative_to(cwd):
        raise ValueError('invocations must be outside task workspace')
    forbidden = {Path('/'), Path('/Users'), Path('/Volumes'), Path('/private'), Path('/private/tmp'), Path.home().resolve()}
    if any(p in forbidden or cwd.is_relative_to(p) or root.is_relative_to(p) for p in trusted):
        raise ValueError('trusted runtime exposes experiment or user data')
    if not any(launcher.is_relative_to(p) for p in trusted):
        raise ValueError('launcher outside trusted runtime')
    if stat.S_IMODE(auth.stat().st_mode) & 0o077:
        raise ValueError('authentication source must be owner-only')
    owned = Path(tempfile.mkdtemp(prefix='invocation-', dir=root))
    owned.chmod(0o700)
    for name in ('home', 'codex', 'tmp'):
        (owned / name).mkdir(mode=0o700)
    with os.fdopen(os.open(owned / 'codex/auth.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(auth.read_bytes())
    profile = owned / 'sandbox.sb'
    profile.write_text(sandbox_policy(cwd, owned, trusted, permission == 'read-only'))
    env = {'HOME': str(owned / 'home'), 'CODEX_HOME': str(owned / 'codex'),
           'TMPDIR': str(owned / 'tmp') + '/', 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8'}
    return owned, profile, env


def containment_probe(config, root, forbidden):
    """No model call: prove actual file-content denials and own-workspace access."""
    cwd = root / 'containment-probe'
    cwd.mkdir()
    (cwd / 'own.txt').write_text('current-task-visible')
    first, _, _ = prepare_isolation(config, cwd, 'workspace-write')
    owned, profile, env = prepare_isolation(config, cwd, 'workspace-write')
    results = []
    for path in [*forbidden, first / 'codex/auth.json']:
        proc = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), '/bin/cat', str(path)],
                              env=env, capture_output=True, timeout=10)
        results.append({'target': str(path), 'denied': proc.returncode != 0 and not proc.stdout})
    own = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), '/bin/cat', str(cwd / 'own.txt')],
                         env=env, capture_output=True, timeout=10)
    version = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), config['launcher'], '--version'],
                             env=env, capture_output=True, timeout=10)
    result = {'denials': results, 'own_read': own.stdout == b'current-task-visible',
              'runtime_starts': version.returncode == 0, 'runtime_version': version.stdout.decode().strip(),
              'diagnostic': version.stderr.decode()[-1000:] if version.returncode else None}
    result['passed'] = all(r['denied'] for r in results) and result['own_read'] and result['runtime_starts']
    return result


def run(fixture, output, config, continue_budget=None):
    # No override: local file denial alone cannot isolate remote account tools or
    # descendants that detach from the agent's process group.
    raise RuntimeError(
        'quality execution unavailable: provider-only egress, remote-tool denial, '
        'and descendant lifetime containment require a supported verified backend; '
        'no model invocation or output reservation performed')


def snapshot_candidate(cwd):
    path = Path(cwd) / 'adapter.py'
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('candidate must be a regular file')
        data = stream.read(65537)
    if len(data) > 65536:
        raise ValueError('candidate exceeds 65536-byte ceiling')
    return data


def verifier_process(source, values, parent):
    """No expected outputs enter this process; candidate writes/network/forks denied."""
    if platform.system() != 'Darwin':
        return {'status': 'infrastructure_error', 'reason': 'macOS verifier boundary unavailable'}
    with tempfile.TemporaryDirectory(prefix='verifier-', dir=parent) as temporary:
        root = Path(temporary).resolve()
        snapshot = root / 'snapshot'; snapshot.mkdir()
        owned = root / 'runtime'; owned.mkdir()
        candidate = snapshot / 'adapter.py'; candidate.write_bytes(source)
        profile = owned / 'sandbox.sb'
        profile.write_text(sandbox_policy(snapshot, owned, [Path(sys.prefix).resolve()], True) +
                           '(deny network*)\n(deny process-fork)\n')
        code = """import importlib.util,json,sys,resource
resource.setrlimit(resource.RLIMIT_CPU,(3,3))
resource.setrlimit(resource.RLIMIT_FSIZE,(1048576,1048576))
s=importlib.util.spec_from_file_location("candidate",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
values=json.load(sys.stdin);out=[]
for value in values:
 try: out.append(m.adapt(value))
 except Exception: out.append(None)
print(json.dumps(out))
"""
        try:
            stdout_path, stderr_path = owned / 'stdout', owned / 'stderr'
            with stdout_path.open('w') as stdout, stderr_path.open('w') as stderr:
                process = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), sys.executable,
                                      '-I', '-c', code, str(candidate)],
                                     input=json.dumps(values), stdout=stdout, stderr=stderr, text=True, timeout=10,
                                     cwd=snapshot, start_new_session=True,
                                     env={'PATH':'/usr/bin:/bin','HOME':str(owned),'TMPDIR':str(owned)})
        except subprocess.TimeoutExpired:
            return {'status': 'candidate_timeout'}
        except OSError as error:
            return {'status': 'infrastructure_error', 'reason': type(error).__name__}
        output, diagnostic = stdout_path.read_text(errors='replace'), stderr_path.read_text(errors='replace')
        if process.returncode != 0:
            # Do not turn a broken Python/sandbox launch into a model failure.
            if 'sandbox_apply' in diagnostic:
                return {'status': 'infrastructure_error', 'reason': 'verifier sandbox/runtime rejected execution'}
            return {'status': 'candidate_error'}
        try:
            actual = json.loads(output)
        except ValueError:
            return {'status': 'candidate_error'}
        if not isinstance(actual, list):
            return {'status': 'candidate_error'}
        return {'status': 'completed', 'actual': actual}


def verifier_preflight():
    """Actual known-good/bad and fork-denial checks, with no model calls."""
    good = verifier_process(b'def adapt(value):\n    return value\n', [{'x':3}], None)
    bad = verifier_process(b'def adapt(value):\n    return None\n', [{'x':3}], None)
    fork_probe = b"""import os,subprocess,sys
def adapt(value):
    denied = 0
    try:
        pid = os.fork()
    except PermissionError:
        denied += 1
    else:
        if pid == 0: os._exit(0)
        os.waitpid(pid,0)
    try:
        p = subprocess.Popen([sys.executable,'-c','pass'],start_new_session=True)
        p.wait(timeout=2)
    except PermissionError:
        denied += 1
    return denied
"""
    fork = verifier_process(fork_probe, [{}], None)
    return {'passed': good == {'status':'completed','actual':[{'x':3}]} and
            bad == {'status':'completed','actual':[None]} and
            fork == {'status':'completed','actual':[2]},
            'known_good': good['status'], 'known_bad': bad['status'],
            'fork_and_detach_denied': fork == {'status':'completed','actual':[2]}}


def verify_snapshot(source, cases, parent=None):
    digest = hashlib.sha256(source).hexdigest()
    preflight = verifier_preflight()
    if not preflight['passed']:
        return {'success': None, 'factual_correctness': None, 'verification_status':'infrastructure_error',
                'candidate_sha256': digest, 'preflight': preflight}
    result = verifier_process(source, [c['input'] for c in cases], parent)
    if result['status'] == 'infrastructure_error':
        return {'success': None, 'factual_correctness': None, 'verification_status':'infrastructure_error',
                'candidate_sha256': digest}
    actual = result.get('actual', [])
    outcomes = [a == c['expected'] for a,c in zip(actual,cases)]
    return {'success': len(outcomes) == len(cases) and all(outcomes),
            'verification_status': result['status'], 'candidate_sha256': digest,
            'factual_correctness': {'passed':sum(outcomes),'total':len(cases),
                                    'scope':'frozen behavioral assertions; prose not adjudicated'}}


def verify(fixture, task_id, cwd):
    cases = json.loads((fixture / 'oracle.json').read_text())[task_id]
    try:
        source = snapshot_candidate(cwd)
    except (OSError, ValueError):
        return {'success':None,'factual_correctness':None,'verification_status':'invalid_snapshot'}
    return verify_snapshot(source, cases, cwd.parent)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--continue-budget', type=Path, help='Explicit operator-directed correction; preserves all reservations and original deadline')
    args = parser.parse_args()
    run(args.fixture.resolve(), args.output.resolve(), json.loads(args.config.read_text()), args.continue_budget)


if __name__ == '__main__':
    main()
