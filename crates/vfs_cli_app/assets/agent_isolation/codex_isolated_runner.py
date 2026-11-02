#!/usr/bin/env python3
"""Fresh Codex auth/home with a mandatory macOS file-content boundary.

Shares the tested DSH sandbox policy; launcher metadata/network remain allowed.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import sys
import tempfile
from dsh_isolated_runner import canonical, sandbox_policy, SYSTEM_READ_ROOTS

def prepare(config,cwd,permission):
    if permission not in ('read-only','workspace-write'):raise ValueError('invalid permission')
    cwd=canonical(cwd);root=canonical(config['invocations_root'])
    if any(cwd.is_relative_to(Path(p).resolve()) or root.is_relative_to(Path(p).resolve()) for p in SYSTEM_READ_ROOTS):
        raise ValueError('workspace/invocation root lies inside implicitly readable system paths')
    if root==cwd or root.is_relative_to(cwd):raise ValueError('invocations root must be outside workspace')
    trusted=[canonical(p) for p in config['trusted_read_roots']]
    prohibited={Path('/'),Path('/Users'),Path('/Volumes'),Path('/private'),Path('/private/tmp'),Path.home().resolve()}
    if any(p in prohibited or cwd.is_relative_to(p) or root.is_relative_to(p) for p in trusted):
        raise ValueError('trusted roots expose experiment or user data')
    launcher=canonical(config['launcher'][0])
    if len(config['launcher'])!=1:raise ValueError('Codex launcher must be one executable')
    if not any(launcher.is_relative_to(t) for t in trusted):raise ValueError('launcher must be inside trusted runtime')
    source=canonical(config['auth_source'])
    if stat.S_IMODE(source.stat().st_mode)&0o077:raise ValueError('auth source must be owner-only')
    owned=Path(tempfile.mkdtemp(prefix='invocation-',dir=root));owned.chmod(0o700)
    home=owned/'home';home.mkdir(mode=0o700)
    codex=owned/'codex';codex.mkdir(mode=0o700)
    tmp=owned/'tmp';tmp.mkdir(mode=0o700)
    with os.fdopen(os.open(codex/'auth.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:f.write(source.read_bytes())
    profile=owned/'sandbox.sb';profile.write_text(sandbox_policy(cwd,owned,trusted,permission=='read-only'));profile.chmod(0o600)
    env={k:os.environ[k] for k in ('LANG','LC_ALL','TERM','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY') if k in os.environ}
    tool_bins=[canonical(p) for p in config.get('tool_bin_dirs',[])]
    if any(not any(p==t or p.is_relative_to(t) for t in trusted) for p in tool_bins):raise ValueError('tool bins outside trusted runtime')
    env.update({'HOME':str(home),'CODEX_HOME':str(codex),'TMPDIR':str(tmp)+'/', 'PATH':os.pathsep.join([*map(str,tool_bins),'/usr/bin','/bin','/usr/sbin','/sbin'])})
    (owned/'invocation.json').write_text(json.dumps({'cwd':str(cwd),'permission':permission,'trusted_read_roots':list(map(str,trusted)),'filesystem_policy':'deny outside file contents and writes; allow metadata/network'},indent=2)+'\n')
    return owned,profile,[str(launcher)],env

def main():
    if platform.system()!='Darwin' or not Path('/usr/bin/sandbox-exec').is_file():raise ValueError('macOS sandbox-exec required; no fallback')
    raw=Path(os.environ['KINIC_ISOLATION_CONFIG']).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=os.environ['KINIC_ISOLATION_CONFIG_SHA256']:raise ValueError('isolation config digest mismatch')
    config=json.loads(raw);args=sys.argv[1:]
    if config['engine']=='dsh':
        from dsh_isolated_runner import prepare as dsh_prepare
        _,profile,launcher,env=dsh_prepare(config,Path.cwd(),os.environ.get('DSH_PERMISSION_MODE',''))
    else:
        if '--sandbox' not in args:raise ValueError('explicit sandbox argument required')
        index=args.index('--sandbox')+1
        _,profile,launcher,env=prepare(config,Path.cwd(),args[index])
        # Outer boundary controls reads and writes; do not nest seatbelt profiles.
        args[index]='danger-full-access'
    os.execve('/usr/bin/sandbox-exec',['/usr/bin/sandbox-exec','-f',str(profile),*launcher,*args],env)

if __name__=='__main__':
    try:main()
    except Exception:
        print('Kinic isolation setup failed',file=sys.stderr);raise SystemExit(1)
