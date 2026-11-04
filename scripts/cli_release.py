#!/usr/bin/env python3
"""Fail-closed CLI release checks. Python 3.11+, git and gh; no third-party modules."""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLATFORMS = ('linux-x86_64', 'macos-arm64')


def version(root):
    npm = json.loads((root / 'npm/kinic-vfs-cli/package.json').read_text())['version']
    cargo = tomllib.loads((root / 'crates/vfs_cli_app/Cargo.toml').read_text())['package']['version']
    locked = [p['version'] for p in tomllib.loads((root / 'Cargo.lock').read_text())['package']
              if p['name'] == 'kinic-vfs-cli']
    if not re.fullmatch(r'\d+\.\d+\.\d+', npm) or cargo != npm or locked != [npm]:
        raise ValueError(f'version mismatch or invalid version: npm={npm}, Cargo={cargo}, lock={locked}')
    return npm


class Release:
    def __init__(self, root, tag, repository):
        self.root = root
        self.tag = tag
        self.repository = repository

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, text=True).strip()

    def gh(self, *args):
        return subprocess.run(['gh', *args], cwd=self.root, text=True, check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def verify_source(self, expected_commit=None):
        if self.tag != f'v{version(self.root)}':
            raise ValueError('release tag does not match package version')
        if self.git('diff', '--name-only', 'HEAD', '--'):
            raise ValueError('tracked source was modified after checkout')
        commit = self.git('rev-parse', '--verify', 'HEAD^{commit}')
        tagged = self.git('rev-parse', '--verify', f'refs/tags/{self.tag}^{{commit}}')
        if tagged != commit or (expected_commit and expected_commit != commit):
            raise ValueError('checkout, release tag and expected commit must match')
        ref = f'refs/tags/{self.tag}'
        remote = dict(line.split()[::-1] for line in
                      self.git('ls-remote', '--exit-code', 'origin', ref, ref + '^{}').splitlines())
        if remote.get(ref + '^{}', remote.get(ref)) != commit:
            raise ValueError('remote tag commit does not match checkout; refusing retagged release')
        return commit

    def names(self):
        return [f'kinic-vfs-cli-{self.tag}-{platform}.{suffix}'
                for platform in PLATFORMS for suffix in ('tar.gz', 'sha256')]

    def check_assets(self, directory):
        for platform in PLATFORMS:
            base = f'kinic-vfs-cli-{self.tag}-{platform}'
            archive = directory / f'{base}.tar.gz'
            checksum = directory / f'{base}.sha256'
            if not archive.is_file() or not checksum.is_file():
                raise ValueError(f'missing release asset for {platform}')
            match = re.fullmatch(r'([a-fA-F0-9]{64})  ' + re.escape(archive.name) + r'\n?',
                                 checksum.read_text())
            with archive.open('rb') as file:
                actual = hashlib.file_digest(file, 'sha256').hexdigest()
            if not match or actual != match[1].lower():
                raise ValueError(f'checksum mismatch or malformed checksum for {archive.name}')

    def metadata(self, commit, allow_missing=False):
        try:
            release = json.loads(self.gh('api', f'repos/{self.repository}/releases/tags/{self.tag}'))
        except subprocess.CalledProcessError as error:
            if allow_missing and '(HTTP 404)' in (error.stderr or ''):
                return None
            raise
        if release['tag_name'] != self.tag:
            raise ValueError('GitHub Release tag mismatch')
        # A mutable branch name is not evidence of the source commit of existing assets.
        if release['target_commitish'] != commit:
            raise ValueError('GitHub Release target commit must be the exact checkout SHA')
        names = [asset['name'] for asset in release['assets']]
        if len(names) != len(set(names)) or set(names) - set(self.names()):
            raise ValueError('duplicate or unexpected GitHub Release assets')
        return release

    def download(self, release, directory):
        for asset in release['assets']:
            self.gh('release', 'download', self.tag, '--pattern', asset['name'],
                    '--dir', str(directory), '--repo', self.repository)

    def verify_release(self, allow_draft=False):
        commit = self.verify_source()
        release = self.metadata(commit)
        if release['draft'] and not allow_draft:
            raise ValueError('npm cannot publish from a draft GitHub Release')
        if set(asset['name'] for asset in release['assets']) != set(self.names()):
            raise ValueError('missing GitHub Release assets')
        with tempfile.TemporaryDirectory(prefix='kinic-release-') as temp:
            directory = Path(temp)
            self.download(release, directory)
            self.check_assets(directory)
        self.verify_source(commit)
        return release

    def publish(self, directory):
        commit = self.verify_source()
        if set(p.name for p in directory.iterdir()) != set(self.names()):
            raise ValueError('missing or unexpected local release assets')
        self.check_assets(directory)
        release = self.metadata(commit, allow_missing=True)
        if release is not None:
            # Compare ALL existing bytes (including checksum files) before any upload.
            # Rebuilding a tag is not assumed to reproduce its original binary bytes.
            with tempfile.TemporaryDirectory(prefix='kinic-existing-release-') as temp:
                downloaded = Path(temp)
                self.download(release, downloaded)
                for asset in release['assets']:
                    name = asset['name']
                    if (downloaded / name).read_bytes() != (directory / name).read_bytes():
                        raise ValueError(f'existing release asset differs: {name}')
        self.verify_source(commit)
        if release is None:
            self.gh('release', 'create', self.tag, '--draft', '--verify-tag', '--target', commit,
                    '--title', self.tag, '--generate-notes', '--repo', self.repository)
            release = self.metadata(commit)
        existing = {asset['name'] for asset in release['assets']}
        missing = [str(directory / name) for name in self.names() if name not in existing]
        if missing:
            # gh refuses conflicting uploads by default, including a concurrent uploader.
            self.gh('release', 'upload', self.tag, *missing, '--repo', self.repository)
        verified = self.verify_release(allow_draft=True)
        if verified['draft']:
            self.gh('release', 'edit', self.tag, '--draft=false', '--repo', self.repository)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('version', 'source', 'publish', 'verify'))
    parser.add_argument('--tag')
    parser.add_argument('--repository')
    parser.add_argument('--commit')
    parser.add_argument('--assets', type=Path)
    args = parser.parse_args()
    if args.command == 'version':
        print(version(ROOT))
        return
    if not args.tag or not args.repository:
        parser.error('--tag and --repository are required')
    release = Release(ROOT, args.tag, args.repository)
    commit = release.verify_source(args.commit)
    if args.command == 'source':
        print(commit)
    elif args.command == 'verify':
        release.verify_release()
    elif args.command == 'publish':
        if args.assets is None:
            parser.error('--assets is required for publish')
        release.publish(args.assets.resolve())


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'release check failed: {error}\n{getattr(error, "stderr", "") or ""}')
