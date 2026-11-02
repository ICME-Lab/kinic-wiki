import json
from pathlib import Path
import tempfile
import unittest
import paired_fixture
import grounding

class PairedTests(unittest.TestCase):
    def test_python_report_reader_rejects_plumbing_quality(self):
        from run_comparison import sample_rows
        with self.assertRaises(ValueError):
            sample_rows({'schema_version':2,'quality_eligible':False,'samples':[]})

    def test_partial_change_preserves_other_fields_and_old_environment(self):
        old = paired_fixture.expected('billing', 1, {'id':' x ', 'amount':'1.005'})
        new = paired_fixture.expected('billing', 2, {'id':' x ', 'amount':'1.005'})
        self.assertEqual(old['key'], new['key'])
        self.assertEqual((old['minor'], new['minor']), (101,100))
        self.assertEqual(paired_fixture.expected('cache',1,{'key':' X ', 'size':9}), {'key':'x','ttl':60,'compress':False})
        self.assertEqual(paired_fixture.expected('cache',2,{'key':' X ', 'size':9}), {'key':'x','ttl':120,'compress':False})

    def test_fixture_is_predecision_and_nonoverwriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'fixture'
            paired_fixture.prepare(output)
            suite=json.loads((output/'suite.json').read_text())
            histories=json.loads((output/'histories.json').read_text())
            self.assertEqual(len(suite['tasks']), 6)
            for task in suite['tasks']:
                h=histories[task['id']]
                self.assertNotIn('verification',json.dumps(h))
                self.assertNotIn(task['id'], [m['id'] for m in h['selected']])
                self.assertIn('same service', task['prompt'])
            self.assertEqual(len(histories['billing-distractors']['selected']),7)
            with self.assertRaises(FileExistsError): paired_fixture.prepare(output)

    def test_grounding_requires_exact_quote_and_evidence_reference(self):
        memories={'old':{'reflection':'One of five checks passed.', 'original':{'checks':[False]*5}}}
        annotations=[{'memory_id':'old','quote':'One of five checks passed.','verdict':'contradicted','evidence_pointer':'/checks','rationale':'All five false'}]
        result=grounding.score(memories,annotations)
        self.assertEqual(result['contradicted'],1)
        self.assertFalse(result['exhaustiveness_verified'])
        annotations[0]['quote']='invented'
        with self.assertRaises(ValueError): grounding.score(memories,annotations)
        annotations[0]['quote']='One of five checks passed.'
        annotations[0]['evidence_pointer']='/absent'
        with self.assertRaises(ValueError): grounding.score(memories,annotations)

if __name__=='__main__': unittest.main()

class IsolationTests(unittest.TestCase):
    @unittest.skipUnless(__import__('platform').system()=='Darwin','macOS seatbelt')
    def test_parent_sibling_contexts_and_prior_session_reads_denied(self):
        import subprocess
        from codex_isolated_runner import prepare
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();cwd=root/'task';cwd.mkdir()
            inv=root/'invocations';inv.mkdir()
            auth=root/'auth.json';auth.write_text('{}');auth.chmod(0o600)
            (cwd/'own.txt').write_text('owned')
            for name in ('histories.json','contexts.json','sibling-answer'):(root/name).write_text('withheld')
            config={'launcher':['/bin/cat'],'invocations_root':str(inv),'trusted_read_roots':['/bin'],'auth_source':str(auth)}
            with self.assertRaises(ValueError):
                prepare({**config,'invocations_root':'/Library'},cwd,'workspace-write')
            first=prepare(config,cwd,'workspace-write');second=prepare(config,cwd,'workspace-write')
            profile=second[1]
            for forbidden in (root/'histories.json',root/'contexts.json',root/'sibling-answer',first[0]/'codex/auth.json'):
                p=subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),'/bin/cat',str(forbidden)],capture_output=True)
                self.assertNotEqual(p.returncode,0)
                self.assertNotIn(b'withheld',p.stdout)
            p=subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),'/bin/cat',str(cwd/'own.txt')],capture_output=True)
            self.assertEqual(p.stdout,b'owned')
            self.assertEqual(p.returncode,0)
