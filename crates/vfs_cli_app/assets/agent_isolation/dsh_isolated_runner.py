#!/usr/bin/env python3
"""Per-invocation DSH home inside a mandatory macOS filesystem sandbox."""
import json
import hashlib
import os
from pathlib import Path
import platform
import shutil
import stat
import sys
import tempfile

SYSTEM_READ_ROOTS = ('/usr', '/bin', '/sbin', '/System', '/Library', '/dev', '/private/etc', '/private/var/db')


def quoted(path):
    return json.dumps(str(path))


def canonical(path):
    return Path(path).expanduser().resolve(strict=True)


def sandbox_policy(cwd, owned, trusted, read_only):
    """Metadata lookup is allowed; file contents/listing and writes default deny."""
    readable = [Path(p) for p in SYSTEM_READ_ROOTS] + [cwd, owned] + list(trusted)
    writable = [owned] + ([] if read_only else [cwd])
    lines = ['(version 1)', '(allow default)', '(deny file-read-data)', '(deny file-write*)', '(allow file-read-data (literal "/"))']
    lines += ['(allow file-read-data ' + ' '.join('(subpath '+quoted(p)+')' for p in readable) + ')']
    lines += ['(allow file-write* ' + ' '.join('(subpath '+quoted(p)+')' for p in writable) + ')']
    # Node and shell stdio use inherited descriptors and device handles.
    lines += ['(allow file-write* (literal "/dev/null") (literal "/dev/tty"))']
    return '\n'.join(lines) + '\n'


def private_credentials(source, destination):
    source = canonical(source)
    if stat.S_IMODE(source.stat().st_mode) & 0o077:
        raise ValueError('credential source must be owner-only')
    value = json.loads(source.read_text())
    key = value.get('refs', {}).get('DEEPSEEK_API_KEY')
    if not isinstance(key, str) or not key:
        raise ValueError('minimal credential JSON needs DEEPSEEK_API_KEY ref')
    document = {'version': value.get('version', 1), 'refs': {'DEEPSEEK_API_KEY': key}}
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(document, stream)


def prepare(config, cwd, permission):
    if permission not in ('read-only', 'workspace-write'):
        raise ValueError('outer mode must be read-only or workspace-write')
    cwd = canonical(cwd)
    root = canonical(config['invocations_root'])
    if any(cwd.is_relative_to(Path(p).resolve()) or root.is_relative_to(Path(p).resolve()) for p in SYSTEM_READ_ROOTS):
        raise ValueError('workspace/invocation root lies inside implicitly readable system paths')
    # The invocation root must not be in the task: that would expose sibling homes.
    if root == cwd or root.is_relative_to(cwd):
        raise ValueError('invocations_root must be outside the task workspace')
    trusted = [canonical(p) for p in config['trusted_read_roots']]
    prohibited = {Path('/'), Path('/Users'), Path('/Volumes'), Path('/private'), Path('/private/tmp'), Path.home().resolve()}
    if any(p in prohibited or cwd.is_relative_to(p) or root.is_relative_to(p) for p in trusted):
        raise ValueError('trusted roots must not expose user home, sibling tasks or invocations')
    launcher = [str(canonical(config['launcher'][0])), *config['launcher'][1:]]
    tool_bins = [canonical(p) for p in config.get('tool_bin_dirs', [])]
    if any(not any(p == t or p.is_relative_to(t) for t in trusted) for p in tool_bins):
        raise ValueError('tool binary directories must be inside explicit trusted read roots')
    owned = Path(tempfile.mkdtemp(prefix='invocation-', dir=root))
    owned.chmod(0o700)
    home = owned/'home';home.mkdir(mode=0o700)
    tmp = owned/'tmp';tmp.mkdir(mode=0o700)
    private_credentials(config['credential_source'], home/'.credentials.yaml')
    # Only shipped bundle declarations are initialized; no active profile is copied.
    if config.get('shipped_modules_dirs'):
        module_roots = [canonical(p) for p in config['shipped_modules_dirs']]
        if any(not any(p.is_relative_to(t) for t in trusted) for p in module_roots):
            raise ValueError('shipped modules must be inside a trusted runtime root')
        sdk = home/'profiles'/'sdk';sdk.mkdir(parents=True)
        (sdk/'package.json').write_text(json.dumps({'name':'dsh-profile-sdk','private':True,'dependencies':{},'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-sdk-app']}}}))
        (sdk/'cordis.yml').write_text('[]\n')
        (sdk/'cordis.patch.yml').write_text('[]\n')
        # Explicit installed-package resolution avoids searching denied ancestor trees.
        target = sdk/'node_modules';target.mkdir()
        for modules in module_roots:
            for entry in modules.iterdir():
                if entry.name.startswith('.'):
                    continue
                packages = list(entry.iterdir()) if entry.name.startswith('@') and entry.is_dir() else [entry]
                for package in packages:
                    resolved = package.resolve()
                    if not any(resolved.is_relative_to(t) for t in trusted):
                        raise ValueError('shipped package escapes trusted runtime roots')
                    link = target/package.relative_to(modules)
                    link.parent.mkdir(exist_ok=True)
                    if not link.exists():link.symlink_to(resolved,target_is_directory=True)
    profile = owned/'sandbox.sb'
    profile.write_text(sandbox_policy(cwd, owned, trusted, permission == 'read-only'))
    profile.chmod(0o600)
    inherited = ('LANG', 'LC_ALL', 'TERM', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY')
    env = {k:os.environ[k] for k in inherited if k in os.environ}
    env.update({'PATH': os.pathsep.join([str(Path(launcher[0]).parent), *map(str,tool_bins), '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
                'HOME':str(home), 'DSH_HOME':str(home), 'TMPDIR':str(tmp)+'/',
                'DSH_TELEMETRY_MODE':'DISABLED', 'DSH_TELEMETRY_DISABLED':'1',
                'DSH_PRIMARY_RUNTIME':'', 'DSH_PERMISSION_MODE':'danger-full-access'})
    metadata = {'cwd':str(cwd),'outer_permission':permission,'home':str(home),'trusted_read_roots':[str(p) for p in trusted],
                'filesystem_policy':'default deny contents/listing and writes; metadata allowed',
                'inner_permission':'danger-full-access only inside outer sandbox','launcher':launcher}
    (owned/'invocation.json').write_text(json.dumps(metadata,indent=2)+'\n')
    return owned, profile, launcher, env


def main():
    if platform.system() != 'Darwin' or not Path('/usr/bin/sandbox-exec').is_file():
        raise RuntimeError('macOS sandbox-exec is required; no unsandboxed fallback')
    filename = os.environ.get('DSH_ISOLATION_CONFIG')
    if not filename:
        raise ValueError('DSH_ISOLATION_CONFIG must name the private runner configuration')
    expected = os.environ.get('DSH_ISOLATION_CONFIG_SHA256', '')
    if len(expected) != 64:
        raise ValueError('DSH_ISOLATION_CONFIG_SHA256 is required')
    raw = Path(filename).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('isolation configuration digest mismatch')
    config = json.loads(raw)
    owned, profile, launcher, env = prepare(config, Path.cwd(), os.environ.get('DSH_PERMISSION_MODE',''))
    # exec preserves SDK stdin/stdout and the owned process group; sandbox failure is fatal.
    os.execve('/usr/bin/sandbox-exec', ['/usr/bin/sandbox-exec','-f',str(profile),*launcher,*sys.argv[1:]], env)

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('DSH isolation failed: '+str(exc), file=sys.stderr)
        sys.exit(1)
