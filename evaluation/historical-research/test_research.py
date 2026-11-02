import json
from pathlib import Path
import tempfile
import unittest
import research


class ProtocolTests(unittest.TestCase):
    def test_order_balances_each_pair(self):
        for task in range(6):
            self.assertEqual(research.arm_order(task, 1), list(reversed(research.arm_order(task, 0))))
            self.assertEqual(set(research.arm_order(task, 0)), set(research.ARMS))

    def test_budget_counts_failed_calls_and_refuses_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ledger.json'
            ledger = research.Ledger(path, max_calls=2)
            ledger.reserve('revision-1')
            with self.assertRaises(ValueError):
                ledger.reserve('revision-1')
            ledger.reserve('failed-2')
            with self.assertRaises(RuntimeError):
                ledger.reserve('decision-3')
            self.assertEqual(len(json.loads(path.read_text())['calls']), 2)
            with self.assertRaises(FileExistsError):
                research.Ledger(path)

    def test_explicit_correction_preserves_global_budget_and_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ledger.json'
            original = research.Ledger(path, max_calls=2)
            row = original.reserve('failed-original')
            with self.assertRaises(ValueError):
                research.Ledger.continue_explicit(path)
            original.finish(row, {'status': 'failed'})
            corrected = research.Ledger.continue_explicit(path)
            self.assertEqual(corrected.deadline, original.deadline)
            corrected.reserve('corrected')
            with self.assertRaises(RuntimeError):
                corrected.reserve('third')

    def test_global_deadline_prevents_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = research.Ledger(Path(tmp) / 'ledger.json', seconds=0)
            with self.assertRaises(TimeoutError):
                ledger.reserve('late')

    def test_context_keeps_shared_observation_and_revises_only_target(self):
        task = {'history': {'original': {'text': 'source'}, 'lesson': 'old',
                            'latest': {'text': 'new source'}, 'new_lesson': 'fixed'}}
        self.assertEqual(research.context(task, 'none', 'new'), '')
        self.assertEqual(json.loads(research.context(task, 'raw', 'new')),
                         {'original': {'text': 'source'}, 'latest': {'text': 'new source'}})
        current = json.loads(research.context(task, 'current', 'new'))
        revision = json.loads(research.context(task, 'revision', 'new'))
        self.assertEqual(current['new_lesson'], revision['new_lesson'])
        self.assertEqual((current['lesson'], revision['lesson']), ('old', 'new'))

    def test_revision_never_contains_task_or_oracle(self):
        task = {'prompt': 'TASK SECRET', 'tests': 'ORACLE SECRET',
                'history': {'original': {'text': 'source'}, 'lesson': 'old',
                            'latest': {'text': 'new source'}, 'new_lesson': 'fixed'}}
        prompt = research.revision_prompt(task)
        self.assertNotIn('TASK SECRET', prompt)
        self.assertNotIn('ORACLE SECRET', prompt)

    def test_freeze_detects_modified_sources_and_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'suite.json').write_text('{}')
            (root / 'oracle.py').write_text('pass')
            research.freeze(root)
            research.check_freeze(root)
            (root / 'oracle.py').write_text('changed')
            with self.assertRaises(ValueError):
                research.check_freeze(root)

    def test_usage_unknown_is_null(self):
        self.assertIsNone(research.usage_from_events(''))
        self.assertEqual(research.usage_from_events('{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":3}}\n'),
                         {'input_tokens': 4, 'output_tokens': 3})

    def test_model_retry_and_sandbox_policy_are_fixed(self):
        cmd = research.codex_args('/bin/codex', Path('/case'), 'workspace-write')
        self.assertIn('gpt-6.1-sol', cmd)
        self.assertIn('model_reasoning_effort="high"', cmd)
        self.assertIn('workspace-write', cmd)
        self.assertFalse(any('danger' in arg for arg in cmd))
        self.assertFalse(any('model_providers.openai.' in arg for arg in cmd))
        outer = research.codex_args('/bin/codex', Path('/case'), 'workspace-write', outer_enforced=True)
        self.assertIn('danger-full-access', outer)

class HistoricalTests(unittest.TestCase):
    def test_genuine_sources_six_tasks_and_lesson_quotes(self):
        import prepare
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'frozen'
            suite = prepare.prepare(root)
            self.assertEqual(len(suite['tasks']), 6)
            self.assertEqual(len(set(t['family'] for t in suite['tasks'])), 3)
            for task in suite['tasks']:
                h = task['history']
                self.assertIn(h['lesson'], h['original']['text'])
                self.assertIn(h['new_lesson'], h['latest']['text'])
                self.assertEqual(task['target_lesson_count'], 1)
                self.assertNotIn('oracle', json.dumps(task['files']))
            research.check_freeze(root)
            with self.assertRaises(FileExistsError):
                prepare.prepare(root)

    def test_real_boundary_blocks_oracle_other_arms_and_sessions(self):
        import platform
        if platform.system() != 'Darwin':
            self.skipTest('requires macOS; live run also fails closed')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            inv = root / 'inv'; inv.mkdir()
            auth = root / 'auth.json'; auth.write_text('{}'); auth.chmod(0o600)
            forbidden = []
            for name in ('oracle.json','other-arm.py','normal-chat.json'):
                p = root / name; p.write_text('FORBIDDEN'); forbidden.append(p)
            config = {'launcher':'/bin/cat','trusted_read_roots':['/bin'],
                      'invocations_root':str(inv),'auth_source':str(auth)}
            task = root / 'task'; task.mkdir()
            (task/'own').write_text('OWN')
            first,_,_ = research.prepare_isolation(config,task,'workspace-write')
            _,profile,env = research.prepare_isolation(config,task,'workspace-write')
            import subprocess
            for p in forbidden + [first/'codex/auth.json']:
                result = subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),'/bin/cat',str(p)],env=env,capture_output=True)
                self.assertNotEqual(result.returncode,0)
                self.assertFalse(result.stdout)
            result = subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),'/bin/cat',str(task/'own')],env=env,capture_output=True)
            self.assertEqual(result.stdout,b'OWN',result.stderr.decode())
            write = subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),'/usr/bin/touch',str(task/'allowed')],env=env,capture_output=True)
            self.assertEqual(write.returncode,0)
            denied_write = subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),'/usr/bin/touch',str(root/'forbidden-write')],env=env,capture_output=True)
            self.assertNotEqual(denied_write.returncode,0)
            _,read_profile,read_env = research.prepare_isolation(config,task,'read-only')
            read_write = subprocess.run(['/usr/bin/sandbox-exec','-f',str(read_profile),'/usr/bin/touch',str(task/'revision-write')],env=read_env,capture_output=True)
            self.assertNotEqual(read_write.returncode,0)

    def test_verifier_executes_candidate_without_exposing_oracle(self):
        import platform
        if platform.system() != 'Darwin':
            self.skipTest('macOS verifier sandbox required')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); fixture=root/'fixture'; fixture.mkdir(); task=root/'task'; task.mkdir()
            research.write_json(fixture/'oracle.json',{'test':[{'input':{'x':3},'expected':{'x':3}}]})
            (task/'adapter.py').write_text('def adapt(value):\n    return value\n')
            self.assertTrue(research.verify(fixture,'test',task)['success'])
            (task/'adapter.py').write_text('def adapt(value):\n    return __import__("json").load(open('+repr(str(fixture/'oracle.json'))+'))["test"][0]["expected"]\n')
            self.assertFalse(research.verify(fixture,'test',task)['success'])

class ReviewRegressionTests(unittest.TestCase):
    def test_live_backend_refuses_before_output_or_model_reservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture=root/'fixture';fixture.mkdir();output=root/'output'
            with self.assertRaisesRegex(RuntimeError,'quality execution unavailable'):
                research.run(fixture,output,{})
            self.assertFalse(output.exists())

    def test_verifier_denies_forks_and_detached_subprocesses(self):
        result=research.verifier_preflight()
        self.assertTrue(result['passed'])
        self.assertTrue(result['fork_and_detach_denied'])

    def test_candidate_bytes_are_frozen_before_scoring(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'adapter.py').write_text('def adapt(value):\n    return value\n')
            frozen=research.snapshot_candidate(root)
            (root/'adapter.py').write_text('def adapt(value):\n    return None\n')
            result=research.verify_snapshot(frozen,[{'input':{'x':1},'expected':{'x':1}}])
            self.assertTrue(result['success'])
            self.assertEqual(result['candidate_sha256'],__import__('hashlib').sha256(frozen).hexdigest())

    def test_snapshot_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'secret').write_text('private');(root/'adapter.py').symlink_to(root/'secret')
            with self.assertRaises((OSError,ValueError)):
                research.snapshot_candidate(root)

    def test_verifier_preflight_uses_known_good_and_known_bad(self):
        self.assertTrue(research.verifier_preflight()['passed'])

class VerifierStatusTests(unittest.TestCase):
    def test_infrastructure_failure_is_not_a_model_failure(self):
        from unittest.mock import patch
        with patch.object(research,'verifier_preflight',return_value={'passed':False}):
            result=research.verify_snapshot(b'def adapt(value): return value',[])
        self.assertIsNone(result['success'])
        self.assertIsNone(result['factual_correctness'])
        self.assertEqual(result['verification_status'],'infrastructure_error')

    def test_non_regular_candidate_cannot_block_snapshot(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);os.mkfifo(root/'adapter.py')
            with self.assertRaises(ValueError):research.snapshot_candidate(root)


if __name__ == '__main__':
    unittest.main()
