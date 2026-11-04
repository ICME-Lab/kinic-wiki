"""Offline fixture and acceptance checks for the real npm upgrade smoke."""
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('smoke_cli_upgrade.py')


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.exists(), 'upgrade smoke helper is not implemented')
        spec = importlib.util.spec_from_file_location('upgrade', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.fixture = self.module.LegacyFixture(self.root)
        self.fixture.seed()

    def report(self):
        return {
            'mode': 'local_read_only',
            'target': {'project_id': '11111111111111111111111111111111',
                       'database_id': 'upgrade-fixture', 'binding': 'resolved',
                       'project_root': str(self.fixture.project)},
            'configuration': {'status': 'observed', 'sources': {
                'portable_or_legacy_config': str(self.fixture.config)}},
            'learning': {'status': 'observed', 'code': 'local_jobs_read',
                         'source': str(self.fixture.database),
                         'jobs': [{'run_id': 'upgrade-legacy-retry', 'state': 'retry',
                                   'reason_code': 'retry_pending', 'attempts': None}]},
        }

    def test_seed_is_legacy_queue_without_new_retry_fields(self):
        with sqlite3.connect(self.fixture.database) as conn:
            body = json.loads(conn.execute('SELECT body FROM jobs').fetchone()[0])
            self.assertEqual(conn.execute('SELECT count(*) FROM owner').fetchone()[0], 0)
        self.assertEqual(body['state'], 'retry')
        self.assertEqual(body['config_path'], str(self.fixture.config))
        self.assertNotIn('retry_policy', body)
        self.assertNotIn('pause', body)
        self.assertFalse(json.loads(self.fixture.config.read_text())['enabled'])
        self.fixture.assert_preserved()

    def test_config_or_database_changes_fail_preservation(self):
        with self.fixture.config.open('a') as file:
            file.write(' ')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.fixture.assert_preserved()

    def test_job_mutation_fails_preservation(self):
        with sqlite3.connect(self.fixture.database) as conn:
            conn.execute('DELETE FROM jobs')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.fixture.assert_preserved()

    def test_added_state_file_fails_preservation(self):
        (self.fixture.state / 'unexpected.sqlite').write_bytes(b'new state')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.fixture.assert_preserved()

    def test_status_requires_actual_selected_legacy_job_and_config(self):
        self.fixture.check_report(self.report(), current=True)
        for section, key, value in [
            ('learning', 'jobs', []),
            ('learning', 'status', 'unknown'),
            ('learning', 'source', '/another/queue.sqlite'),
            ('target', 'project_root', '/another/project'),
            ('target', 'project_id', '22222222222222222222222222222222'),
            ('configuration', 'sources', {}),
        ]:
            report = self.report()
            report[section][key] = value
            with self.subTest(section=section, key=key), self.assertRaises(ValueError):
                self.fixture.check_report(report, current=True)

    def test_current_status_does_not_invent_legacy_attempt_count(self):
        report = self.report()
        report['learning']['jobs'][0]['attempts'] = 0
        with self.assertRaisesRegex(ValueError, 'attempt'):
            self.fixture.check_report(report, current=True)

    def test_child_environment_excludes_credentials_and_actual_homes(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'must-not-inherit',
                                     'NODE_AUTH_TOKEN': 'must-not-inherit',
                                     'KINIC_LEARNING_HOME': '/actual/state',
                                     'HOME': '/actual/home', 'CODEX_HOME': '/actual/codex'}):
            env = self.module.isolated_environment(self.root / 'sandbox')
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertNotIn('NODE_AUTH_TOKEN', env)
        self.assertNotIn('KINIC_LEARNING_HOME', env)
        for key in ('HOME', 'CODEX_HOME', 'ICP_HOME', 'XDG_CONFIG_HOME', 'NPM_CONFIG_USERCONFIG'):
            self.assertTrue(Path(env[key]).is_relative_to(self.root / 'sandbox'))


if __name__ == '__main__':
    unittest.main()
