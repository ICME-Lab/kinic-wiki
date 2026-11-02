import importlib.util
import json
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import shutil
import sys
import tempfile
import unittest
from dsh_isolated_runner import sandbox_policy,prepare

@unittest.skipUnless(platform.system()=='Darwin' and Path('/usr/bin/sandbox-exec').exists(),'requires actual macOS sandbox-exec')
class ActualSandboxTests(unittest.TestCase):
 def test_read_write_boundaries_shell_and_native(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();cwd=root/'task';owned=root/'owned';sibling=root/'sibling';evaluator=root/'evaluator';shared=root/'shared-home'
   for d in (cwd,owned,sibling,evaluator,shared):d.mkdir();(d/'secret').write_text('readable only if permitted')
   (cwd/'escape').symlink_to(sibling/'secret')
   # System Perl native open and shell cat both execute within the same outer policy.
   node=shutil.which('node')
   trusted=[] if not node else [Path(node).resolve().parent.parent]
   for readonly in (True,False):
    profile=owned/'sandbox.sb';profile.write_text(sandbox_policy(cwd,owned,trusted,readonly))
    def run(argv):return subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),*argv],cwd=cwd,capture_output=True,text=True)
    self.assertEqual(run(['/bin/cat',str(cwd/'secret')]).returncode,0)
    self.assertEqual(run(['/bin/cat',str(profile)]).returncode,0)
    for path in (sibling/'secret',evaluator/'secret',shared/'secret',cwd/'escape'):
     self.assertNotEqual(run(['/bin/sh','-c','cat "$1"','sh',str(path)]).returncode,0)
     self.assertNotEqual(run(['/usr/bin/perl','-e','open(my $f,"<",$ARGV[0]) or exit 23; print <$f>;',str(path)]).returncode,0)
     if node:self.assertNotEqual(run([node,'-e',"require('fs').readFileSync(process.argv[1])",str(path)]).returncode,0)
    self.assertNotEqual(run(['/bin/ls',str(root)]).returncode,0)
    written=run(['/bin/sh','-c','echo test > "$1"','sh',str(cwd/'new')])
    self.assertEqual(written.returncode==0,not readonly)
    self.assertEqual(run(['/bin/sh','-c','echo test > "$1"','sh',str(owned/'new')]).returncode,0)
    self.assertNotEqual(run(['/bin/sh','-c','echo test > "$1"','sh',str(sibling/'new')]).returncode,0)

 def test_wrapper_preserves_stdio_args_and_applies_outer_mode(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();cwd=root/'task';cwd.mkdir();runs=root/'runs';runs.mkdir();runtime=root/'runtime';runtime.mkdir();secret=root/'evaluator';secret.write_text('DENIED')
   credential=root/'credential.json';credential.write_text(json.dumps({'version':1,'refs':{'DEEPSEEK_API_KEY':'test-only'}}));credential.chmod(0o600)
   script=runtime/'probe.py';script.write_text("import sys,os,json\nfrom pathlib import Path\ntry:\n Path(sys.argv[1]).read_text();blocked=False\nexcept PermissionError:blocked=True\ntry:\n Path('forbidden-write').write_text('x');write_blocked=False\nexcept PermissionError:write_blocked=True\nprint(json.dumps({'input':sys.stdin.read(),'args':sys.argv[2:],'blocked':blocked,'write_blocked':write_blocked,'inner':os.environ['DSH_PERMISSION_MODE']}))\n")
   config={'launcher':[sys.executable,str(script),str(secret)],'trusted_read_roots':[str(runtime),str(Path(sys.executable).resolve().parent.parent)],'invocations_root':str(runs),'credential_source':str(credential)}
   config_path=root/'config.json';config_path.write_text(json.dumps(config));env=os.environ.copy();env.update({'DSH_ISOLATION_CONFIG':str(config_path),'DSH_PERMISSION_MODE':'read-only','DSH_ISOLATION_CONFIG_SHA256':hashlib.sha256(config_path.read_bytes()).hexdigest()})
   result=subprocess.run([sys.executable,str(Path(__file__).with_name('dsh_isolated_runner.py')),'--profile','sdk'],cwd=cwd,env=env,input='SDK STDIN',capture_output=True,text=True)
   self.assertEqual(result.returncode,0,result.stderr)
   drifted=json.loads(config_path.read_text());drifted['trusted_read_roots'].append('/')
   config_path.write_text(json.dumps(drifted))
   denied=subprocess.run([sys.executable,str(Path(__file__).with_name('dsh_isolated_runner.py'))],cwd=cwd,env=env,capture_output=True,text=True)
   self.assertNotEqual(denied.returncode,0);self.assertIn('digest mismatch',denied.stderr)
   data=json.loads(result.stdout);self.assertEqual(data,{'input':'SDK STDIN','args':['--profile','sdk'],'blocked':True,'write_blocked':True,'inner':'danger-full-access'})

class IsolatedHomeTests(unittest.TestCase):
 def test_separate_homes_minimal_credentials_and_no_environment_leak(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);cwd=root/'task';cwd.mkdir();runs=root/'runs';runs.mkdir();credential=root/'credential.json'
   credential.write_text(json.dumps({'version':1,'refs':{'DEEPSEEK_API_KEY':'test-only','UNRELATED':'must-not-copy'},'records':{'sessions':'must-not-copy'}}));credential.chmod(0o600)
   config={'launcher':['/bin/echo'],'trusted_read_roots':[],'invocations_root':str(runs),'credential_source':str(credential)}
   first,_,_,env=prepare(config,cwd,'read-only');second,_,_,_=prepare(config,cwd,'workspace-write')
   self.assertNotEqual(first,second)
   value=json.loads((first/'home/.credentials.yaml').read_text());self.assertEqual(value,{'version':1,'refs':{'DEEPSEEK_API_KEY':'test-only'}})
   self.assertEqual((first/'home/.credentials.yaml').stat().st_mode&0o777,0o600)
   self.assertFalse((first/'home/profiles').exists());self.assertFalse((first/'home/sessions').exists())
   self.assertNotIn('NODE_OPTIONS',env);self.assertEqual(env['HOME'],env['DSH_HOME'])
   with self.assertRaises(ValueError):prepare(config,cwd,'danger-full-access')
   with self.assertRaises(ValueError):prepare({**config,'trusted_read_roots':[str(root)]},cwd,'read-only')
if __name__=='__main__':unittest.main()
