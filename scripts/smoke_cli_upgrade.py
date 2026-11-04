#!/usr/bin/env python3
"""Fresh-install and 2.0.4 upgrade acceptance for one packed npm artifact.

Only npm installs access the network. CLI diagnostics use an isolated environment,
a disabled project, a loopback destination, and no identity or model credentials.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path


PROJECT_ID = '11111111111111111111111111111111'
RUN_ID = 'upgrade-legacy-retry'


def compact(value):
    return json.dumps(value, separators=(',', ':'))


def isolated_environment(root):
    root.mkdir(parents=True, exist_ok=True)
    home = root / 'home'
    home.mkdir(exist_ok=True)
    return {
        'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8',
        'HOME': str(home), 'CODEX_HOME': str(home / '.codex'),
        'ICP_HOME': str(home / 'icp'), 'XDG_CONFIG_HOME': str(home / '.config'),
        'NPM_CONFIG_USERCONFIG': str(home / '.npmrc'),
        'NPM_CONFIG_GLOBALCONFIG': str(home / 'global-npmrc'),
        'NPM_CONFIG_CACHE': str(root / 'npm-cache'),
    }


class LegacyFixture:
    def __init__(self, root):
        self.project = root / 'project'
        self.state = root / 'state'
        self.config = self.project / '.kinic-learning.json'
        # This is the v2.0.4 JobQueue partition hash: JSON([JSON(binding), project]).
        binding = compact(['http://127.0.0.1:1:aaaaa-aa', 'upgrade-fixture', '2vxsx-fae'])
        digest = hashlib.sha256(compact([binding, PROJECT_ID]).encode()).hexdigest()
        self.database = self.state / f'jobs-{digest}.sqlite'

    def seed(self):
        self.project.mkdir(parents=True)
        self.state.mkdir(parents=True)
        self.config.write_text(compact({
            'version': 2, 'project_id': PROJECT_ID, 'enabled': False,
            'replica_host': 'http://127.0.0.1:1', 'canister_id': 'aaaaa-aa',
            'database_id': 'upgrade-fixture', 'principal': '2vxsx-fae',
            'recall': {'namespace': f'/Knowledge/projects/{PROJECT_ID}', 'budget_tokens': 1000},
            'runner': {'engine': 'codex', 'executable': '/bin/false'},
        }))
        # Exact legacy schema/body; intentionally no retry_policy or pause fields.
        with sqlite3.connect(self.database) as conn:
            conn.executescript('''
                CREATE TABLE jobs(run TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL);
                CREATE TABLE wakeup(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
            ''')
            conn.execute('INSERT INTO jobs(run, body) VALUES(?, ?)', (RUN_ID, compact({
                'run_id': RUN_ID, 'cwd': str(self.project), 'config_path': str(self.config),
                'state': 'retry', 'candidate_path': None, 'evaluation_path': None,
                'error': 'legacy fixture failure', 'config_hash': None,
            })))
        self.before = self.snapshot()

    def snapshot(self):
        return {str(path): path.read_bytes() for root in (self.project, self.state)
                for path in root.rglob('*') if path.is_file()}

    def assert_preserved(self):
        if self.snapshot() != self.before:
            raise ValueError('legacy project configuration or job state changed during upgrade/diagnostics')

    def check_report(self, report, current=False):
        target = report.get('target', {})
        config = report.get('configuration', {})
        learning = report.get('learning', {})
        if (report.get('mode') != 'local_read_only'
                or target.get('project_id') != PROJECT_ID
                or target.get('project_root') != str(self.project)
                or target.get('database_id') != 'upgrade-fixture'
                or target.get('binding') != 'resolved'
                or config.get('status') != 'observed'
                or config.get('sources', {}).get('portable_or_legacy_config') != str(self.config)
                or learning.get('status') != 'observed'
                or learning.get('code') != 'local_jobs_read'
                or learning.get('source') != str(self.database)):
            raise ValueError('agent status did not read the selected legacy configuration and queue')
        jobs = learning.get('jobs', [])
        if (len(jobs) != 1 or jobs[0].get('run_id') != RUN_ID
                or jobs[0].get('state') != 'retry' or jobs[0].get('reason_code') != 'retry_pending'):
            raise ValueError('agent status did not preserve the legacy retry job')
        if current and ('attempts' not in jobs[0] or jobs[0]['attempts'] is not None):
            raise ValueError('new CLI must report unknown legacy attempt count')

    def inspect(self, binary, env, current=False):
        report = json.loads(run([str(binary), 'agent', 'status', '--cwd', str(self.project),
                                 '--state-dir', str(self.state), '--json'], self.project, env))
        self.check_report(report, current)
        self.assert_preserved()


def run(args, cwd, env, timeout=30):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    return result.stdout.strip()


def install(package, prefix, cwd, env):
    run(['npm', 'install', '--global', '--prefix', str(prefix),
         '--registry=https://registry.npmjs.org', '--fetch-timeout=60000', '--fetch-retries=1',
         '--no-audit', '--no-fund', str(package)], cwd, env, timeout=240)
    return prefix / 'bin/kinic-vfs-cli'


def assert_version(binary, version, cwd, env):
    if run([str(binary), '--version'], cwd, env) != f'kinic-vfs-cli {version}':
        raise ValueError(f'installed binary did not report expected version {version}')


def smoke(package, version):
    with tempfile.TemporaryDirectory(prefix='kinic-npm-acceptance-') as temporary:
        root = Path(temporary).resolve()
        fresh = root / 'fresh'
        fresh_env = isolated_environment(fresh)
        binary = install(package, fresh / 'prefix', fresh, fresh_env)
        assert_version(binary, version, fresh, fresh_env)
        run([str(binary), 'codex', 'setup', '--help'], fresh, fresh_env)
        setup = json.loads(run([str(binary), 'codex', 'setup', '--json', '--dry-run',
                                '--executable', str(binary)], fresh, fresh_env))
        if (setup.get('status') != 'dry_run' or setup.get('engine') != 'codex'
                or setup.get('activation') != 'unknown' or not setup.get('changes')):
            raise ValueError('fresh-install setup dry-run contract failed')
        print(f'fresh install {version}: version and setup dry-run passed', flush=True)

        upgrade = root / 'upgrade'
        upgrade_env = isolated_environment(upgrade)
        prefix = upgrade / 'prefix'
        binary = install('kinic-vfs-cli@2.0.4', prefix, upgrade, upgrade_env)
        assert_version(binary, '2.0.4', upgrade, upgrade_env)
        fixture = LegacyFixture(upgrade)
        fixture.seed()
        fixture.inspect(binary, upgrade_env)
        # Same installation prefix and same packed tarball as the fresh-install check.
        install(package, prefix, upgrade, upgrade_env)
        assert_version(binary, version, upgrade, upgrade_env)
        fixture.assert_preserved()
        fixture.inspect(binary, upgrade_env, current=True)
        print(f'upgrade 2.0.4 -> {version}: legacy config/job readable and bytes preserved', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    package = args.package.resolve(strict=True)
    if not package.is_file():
        parser.error('--package must be an existing npm tarball')
    smoke(package, args.version)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise SystemExit(f'npm acceptance failed: {error}\n{getattr(error, "stderr", "") or ""}')
