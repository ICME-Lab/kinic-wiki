"""CLI-only Codex adapter contract and portable installation regression tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]

class LearningHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'unrelated-project'
        self.workspace.mkdir()
        self.log = self.root / 'calls.jsonl'
        self.cli = self.root / 'kinic-vfs-cli'
        self.cli.write_text(f'''#!{sys.executable}
import json,os,sys
from pathlib import Path
request=json.load(sys.stdin)
if os.environ.get('FIXTURE_TIMEOUT')=='1':
    import time; time.sleep(10)
if os.environ.get('FIXTURE_FLOOD')=='1':
    print('x'*(1024*1024+1));sys.exit()
with Path(os.environ['FIXTURE_LOG']).open('a') as file:
    file.write(json.dumps({{'argv':sys.argv[1:],'request':request}})+'\\n')
if os.environ.get('FIXTURE_FAIL')=='1':
    sys.stderr.write('sensitive failure token=do-not-copy');sys.exit(1)
if os.environ.get('FIXTURE_BAD_REPLY')=='1':
    print(json.dumps({{'hookSpecificOutput':True}}))
elif os.environ.get('FIXTURE_SKIP')=='1':
    print(json.dumps({{'skipped':True,'reason':'project not configured'}}))
else:
    print(json.dumps({{'additionalContext':'Use the documented condition','receipt_id':'receipt-1','decision':'block','continue':False}} if request['event']=='UserPromptSubmit' else {{'recorded':True}}))
''')
        self.cli.chmod(0o700)
        self.env = {**os.environ, 'PYTHONPATH':str(RUNTIME),'KINIC_VFS_CLI':str(self.cli),'CODEX_PLUGIN_DATA':str(self.root/'data'),'FIXTURE_LOG':str(self.log)}
        self.base = {'session_id':'session-1','cwd':str(self.workspace),'turn_id':'turn-1'}

    def run_hook(self, event='UserPromptSubmit', **fields):
        return subprocess.run([sys.executable,'-m','kinic_agent_runtime.learning_hook'],input=json.dumps({**self.base,'hook_event_name':event,**fields}),text=True,capture_output=True,env=self.env,timeout=10)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_recall_only_returns_supported_context_and_uses_cli_settings(self):
        self.env['KINIC_VFS_CLI_ALLOW_NON_II']='1'
        self.env['KINIC_LEARNING_RECALL_CONFIG']='config/custom.json'
        result=self.run_hook(prompt='Fix the task')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),{'hookSpecificOutput':{'hookEventName':'UserPromptSubmit','additionalContext':'Use the documented condition'}})
        call=self.calls()[0]
        self.assertEqual(call['argv'][:5],['--allow-non-ii-identity','agent','hook','--engine','codex'])
        self.assertEqual(call['request']['task'],'Fix the task')
        self.assertEqual(call['request']['turn_id'],'turn-1')
        self.assertNotIn('run_id',call['request'])
        self.assertEqual(call['argv'][-2:],['--recall-config','config/custom.json'])

    def test_shared_toml_discovery_is_left_to_cli_and_cwd_precedes_connection(self):
        (self.workspace/'.kinic').mkdir()
        (self.workspace/'.kinic/config.toml').write_text('[learning]\nbudget_tokens=2048\n')
        (self.workspace/'.kinic-learning.json').write_text('{"budget_tokens":1024}')
        result=self.run_hook(prompt='task')
        self.assertEqual(result.returncode,0,result.stderr)
        argv=self.calls()[0]['argv'];self.assertNotIn('--recall-config',argv)
        self.assertEqual(argv[argv.index('--cwd')+1],str(self.workspace.resolve()))
        self.assertFalse((self.root/'data').exists())

    def test_transcript_and_original_tool_evidence_forwarded_only_to_cli(self):
        result=self.run_hook('PostToolUse',tool_name='Bash',tool_use_id='call-1',tool_input={'command':'echo token=secret'},tool_response={'output':'password=leak','exit_code':0},transcript_path='/private/session.jsonl')
        request=self.calls()[0]['request']
        self.assertEqual(request['transcript_path'],'/private/session.jsonl')
        self.assertEqual(request['tool_response']['exit_code'],0)
        self.assertEqual(request['tool_input']['command'],'echo token=secret')
        self.assertEqual(json.loads(result.stdout),{})
        self.assertNotIn('password',result.stdout+result.stderr)
        self.assertNotIn('success',request)

    def test_stop_marks_terminal_without_inventing_success(self):
        self.run_hook('Stop',transcript_path='/session.jsonl',last_assistant_message='all tests pass')
        request=self.calls()[0]['request']
        self.assertEqual(request['event'],'Stop')
        self.assertTrue(request['terminal'])
        self.assertEqual(request['transcript_path'],'/session.jsonl')
        self.assertNotIn('success',request)

    def test_cli_failure_diagnostic_never_leaks_or_creates_learning_state(self):
        self.env['FIXTURE_FAIL']='1'
        result=self.run_hook('Stop')
        self.assertEqual(result.returncode,0)
        self.assertEqual(json.loads(result.stdout),{})
        self.assertNotIn('sensitive failure',result.stderr)
        self.assertIn('not acknowledged',result.stderr)
        self.assertFalse((self.root/'data').exists())
        self.assertEqual(list(self.workspace.iterdir()),[])

    def test_missing_project_config_resolution_belongs_to_cli(self):
        self.env['FIXTURE_SKIP']='1'
        result=self.run_hook(prompt='x')
        self.assertEqual(json.loads(result.stdout),{})
        self.assertEqual(len(self.calls()),1)
        self.assertNotIn('--recall-config',self.calls()[0]['argv'])

    def test_cli_owns_session_turn_binding_without_plugin_state(self):
        self.base.pop('turn_id')
        self.run_hook(prompt='first task')
        self.run_hook('PostToolUse',tool_use_id='one')
        self.run_hook(prompt='second task')
        self.run_hook('Stop')
        self.assertTrue(all('run_id' not in call['request'] for call in self.calls()))
        self.assertFalse((self.root/'data').exists())

    def test_malformed_reply_and_oversized_input_fail_open_without_traceback(self):
        self.env['FIXTURE_BAD_REPLY']='1'
        result=self.run_hook(prompt='task')
        self.assertEqual(json.loads(result.stdout),{})
        self.assertNotIn('Traceback',result.stderr)
        before=len(self.calls())
        result=self.run_hook(prompt='x'*(1024*1024))
        self.assertEqual(json.loads(result.stdout),{})
        self.assertEqual(len(self.calls()),before)

    def test_faulty_cli_output_and_timeout_are_bounded_and_fail_open(self):
        import time
        self.env['FIXTURE_FLOOD']='1'
        result=self.run_hook(prompt='task')
        self.assertEqual(json.loads(result.stdout),{})
        self.assertLess(len(result.stderr),200)
        self.env.pop('FIXTURE_FLOOD')
        self.env['FIXTURE_TIMEOUT']='1'
        start=time.monotonic()
        result=self.run_hook('Stop')
        self.assertEqual(json.loads(result.stdout),{})
        self.assertLess(time.monotonic()-start,4)

    def test_installed_shell_wrapper_is_self_contained(self):
        installed=self.root/'installed-plugin'
        scripts=installed/'scripts';scripts.mkdir(parents=True)
        shutil.copy2(RUNTIME.parent/'codex/scripts/learning-hook.sh',scripts/'learning-hook.sh')
        shutil.copytree(RUNTIME/'kinic_agent_runtime',installed/'kinic_agent_runtime')
        env={**self.env};env.pop('PYTHONPATH')
        result=subprocess.run([str(scripts/'learning-hook.sh')],input=json.dumps({**self.base,'hook_event_name':'UserPromptSubmit','prompt':'task'}),text=True,capture_output=True,env=env,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['additionalContext'],'Use the documented condition')

if __name__=='__main__': unittest.main()
