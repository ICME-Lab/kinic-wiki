"""Offline release boundary tests: real git/files/checksums, fake GitHub transport."""
import hashlib
import importlib.util
import json
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('cli_release.py')


class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if SCRIPT.exists():
            spec = importlib.util.spec_from_file_location('cli_release', SCRIPT)
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)

    def setUp(self):
        self.assertTrue(SCRIPT.exists(), 'release safety guard is not implemented')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.tag = 'v2.0.5'
        for name, content in {
            'npm/kinic-vfs-cli/package.json': '{"version":"2.0.5"}',
            'crates/vfs_cli_app/Cargo.toml': '[package]\nname="kinic-vfs-cli"\nversion="2.0.5"\n',
            'Cargo.lock': '[[package]]\nname="kinic-vfs-cli"\nversion="2.0.5"\n',
        }.items():
            p = self.repo / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        self.git('init', '-q')
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
        self.commit = self.git('rev-parse', 'HEAD')
        self.git('tag', self.tag)
        self.remote = self.root / 'remote'
        subprocess.run(['git', 'clone', '-q', '--bare', str(self.repo), str(self.remote)], check=True)
        self.git('remote', 'add', 'origin', str(self.remote))
        self.assets = self.root / 'assets'
        self.assets.mkdir()
        self.remote_assets = self.root / 'remote-assets'
        self.remote_assets.mkdir()
        for platform in ('linux-x86_64', 'macos-arm64'):
            name = f'kinic-vfs-cli-{self.tag}-{platform}'
            data = f'{platform} binary archive fixture'.encode()
            (self.assets / f'{name}.tar.gz').write_bytes(data)
            (self.assets / f'{name}.sha256').write_text(f'{hashlib.sha256(data).hexdigest()}  {name}.tar.gz\n')
        self.release = None
        self.mutations = []
        self.fail_api = False
        self.guard = self.module.Release(self.repo, self.tag, 'owner/repo')
        self.addCleanup(patch.stopall)
        patch.object(self.guard, 'gh', side_effect=self.gh).start()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.repo, text=True).strip()

    def seed_release(self, names=None, draft=False):
        self.release = {'tag_name': self.tag, 'target_commitish': self.commit, 'draft': draft,
                        'prerelease': False, 'assets': []}
        for name in names if names is not None else [p.name for p in self.assets.iterdir()]:
            shutil.copyfile(self.assets / name, self.remote_assets / name)
        self.sync_metadata()

    def sync_metadata(self):
        self.release['assets'] = [{'name': p.name, 'size': p.stat().st_size} for p in self.remote_assets.iterdir()]

    def gh(self, *args):
        if args[0] == 'api':
            if self.fail_api:
                raise subprocess.CalledProcessError(1, args, stderr='gh: forbidden (HTTP 403)')
            if self.release is None:
                raise subprocess.CalledProcessError(1, args, stderr='gh: Not Found (HTTP 404)')
            self.sync_metadata()
            return json.dumps(self.release)
        self.assertEqual(args[0], 'release')
        self.assertIn('--repo', args)
        if args[1] == 'download':
            name = args[args.index('--pattern') + 1]
            shutil.copyfile(self.remote_assets / name, Path(args[args.index('--dir') + 1]) / name)
        elif args[1] == 'create':
            self.assertIn('--verify-tag', args)
            self.assertIn('--draft', args)
            self.assertEqual(args[args.index('--target') + 1], self.commit)
            self.mutations.append(('create', self.tag))
            self.seed_release([], draft=True)
        elif args[1] == 'upload':
            self.assertNotIn('--clobber', args)
            for value in args[3:args.index('--repo')]:
                p = Path(value)
                self.assertFalse((self.remote_assets / p.name).exists(), 'existing asset overwritten')
                shutil.copyfile(p, self.remote_assets / p.name)
                self.mutations.append(('upload', p.name))
        elif args[1] == 'edit':
            self.assertIn('--draft=false', args)
            self.release['draft'] = False
            self.mutations.append(('publish', self.tag))
        else:
            self.fail(f'unexpected GitHub command: {args}')
        return ''

    def test_new_release_is_published_only_with_four_verified_assets(self):
        self.guard.publish(self.assets)
        self.assertFalse(self.release['draft'])
        self.assertEqual(len(list(self.remote_assets.iterdir())), 4)
        self.assertEqual(self.mutations[0], ('create', self.tag))
        self.assertEqual(self.mutations[-1], ('publish', self.tag))

    def test_identical_existing_release_is_a_noop(self):
        self.seed_release()
        self.guard.publish(self.assets)
        self.assertEqual(self.mutations, [])

    def test_partial_release_uploads_only_missing_assets(self):
        present = 'kinic-vfs-cli-v2.0.5-linux-x86_64.tar.gz'
        self.seed_release([present], draft=True)
        self.guard.publish(self.assets)
        self.assertEqual(len([m for m in self.mutations if m[0] == 'upload']), 3)
        self.assertNotIn(('upload', present), self.mutations)
        self.assertFalse(self.release['draft'])

    def test_existing_conflicting_bytes_fail_before_any_missing_upload(self):
        name = 'kinic-vfs-cli-v2.0.5-macos-arm64.tar.gz'
        self.seed_release([name])
        (self.remote_assets / name).write_bytes(b'wrong binary')
        with self.assertRaisesRegex(ValueError, 'differs'):
            self.guard.publish(self.assets)
        self.assertEqual(self.mutations, [])

    def test_existing_checksum_bytes_must_match_too(self):
        name = 'kinic-vfs-cli-v2.0.5-linux-x86_64.sha256'
        self.seed_release([name])
        with (self.remote_assets / name).open('a') as file:
            file.write('\n')
        with self.assertRaisesRegex(ValueError, 'differs'):
            self.guard.publish(self.assets)
        self.assertEqual(self.mutations, [])

    def test_wrong_release_commit_fails_closed(self):
        self.seed_release()
        self.release['target_commitish'] = 'main'
        with self.assertRaisesRegex(ValueError, 'commit'):
            self.guard.publish(self.assets)
        self.assertEqual(self.mutations, [])

    def test_wrong_release_tag_fails_closed(self):
        self.seed_release()
        self.release['tag_name'] = 'v2.0.4'
        with self.assertRaisesRegex(ValueError, 'tag'):
            self.guard.verify_release()

    def test_unexpected_asset_fails_closed(self):
        self.seed_release()
        (self.remote_assets / 'surprise.tar.gz').write_bytes(b'no')
        with self.assertRaisesRegex(ValueError, 'unexpected'):
            self.guard.publish(self.assets)
        self.assertEqual(self.mutations, [])

    def test_network_failure_is_not_treated_as_absent_release(self):
        self.fail_api = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.guard.publish(self.assets)
        self.assertEqual(self.mutations, [])

    def test_invalid_local_checksum_fails_before_create(self):
        (self.assets / 'kinic-vfs-cli-v2.0.5-macos-arm64.tar.gz').write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.guard.publish(self.assets)
        self.assertEqual(self.mutations, [])

    def test_npm_verifies_both_platform_bytes(self):
        self.seed_release()
        self.guard.verify_release()
        (self.remote_assets / 'kinic-vfs-cli-v2.0.5-macos-arm64.tar.gz').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.guard.verify_release()

    def test_npm_rejects_missing_assets(self):
        self.seed_release(['kinic-vfs-cli-v2.0.5-linux-x86_64.tar.gz'])
        with self.assertRaisesRegex(ValueError, 'missing'):
            self.guard.verify_release()

    def test_npm_rejects_unpublished_draft(self):
        self.seed_release(draft=True)
        with self.assertRaisesRegex(ValueError, 'draft'):
            self.guard.verify_release()

    def test_checksum_cannot_name_another_archive(self):
        name = 'kinic-vfs-cli-v2.0.5-linux-x86_64.sha256'
        p = self.assets / name
        p.write_text(p.read_text().replace('linux-x86_64.tar.gz', 'macos-arm64.tar.gz'))
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.guard.publish(self.assets)

    def test_source_checks_local_tag_head_and_expected_commit(self):
        self.assertEqual(self.guard.verify_source(self.commit), self.commit)
        with self.assertRaisesRegex(ValueError, 'commit'):
            self.guard.verify_source('0' * 40)
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'later')
        with self.assertRaisesRegex(ValueError, 'commit'):
            self.guard.verify_source()

    def test_remote_retag_fails_even_if_checkout_tag_matches(self):
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'later')
        other = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', f'{other}:refs/tags/{self.tag}', '--force')
        self.git('checkout', '-q', self.commit)
        with self.assertRaisesRegex(ValueError, 'remote tag'):
            self.guard.publish(self.assets)
        self.assertEqual(self.mutations, [])

    def test_annotated_tag_resolves_to_commit(self):
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'tag', '-fa', self.tag, '-m', 'release')
        self.git('push', '-q', '--force', 'origin', self.tag)
        self.assertEqual(self.guard.verify_source(), self.commit)

    def test_modified_tracked_source_cannot_claim_tag_commit(self):
        p = self.repo / 'npm/kinic-vfs-cli/package.json'
        p.write_text('{"version":"2.0.5", "extra":"modified after tag"}')
        with self.assertRaisesRegex(ValueError, 'modified'):
            self.guard.publish(self.assets)
        self.assertEqual(self.mutations, [])

    def test_cargo_lock_version_drift_is_rejected(self):
        p = self.repo / 'Cargo.lock'
        p.write_text(p.read_text().replace('2.0.5', '2.0.4'))
        with self.assertRaisesRegex(ValueError, 'version'):
            self.guard.verify_source()

    def test_package_version_and_tag_must_agree(self):
        self.guard.tag = 'v2.0.4'
        with self.assertRaisesRegex(ValueError, 'version'):
            self.guard.verify_source()


class PackagingTests(unittest.TestCase):
    def test_packaging_is_reproducible_and_rejects_wrong_binary_version(self):
        import os
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / 'cli'
            binary.write_text('#!/bin/sh\necho "kinic-vfs-cli 2.0.5"\n')
            binary.chmod(0o755)
            script = Path(__file__).with_name('package_kinic_vfs_cli.sh').resolve()
            for output, timestamp in [('first', 100), ('second', 200)]:
                os.utime(binary, (timestamp, timestamp))
                subprocess.run(['bash', str(script), 'v2.0.5', 'macos-arm64', str(binary), str(root / output)],
                               cwd=script.parent.parent, check=True, capture_output=True)
            name = 'kinic-vfs-cli-v2.0.5-macos-arm64.tar.gz'
            self.assertEqual((root / 'first' / name).read_bytes(), (root / 'second' / name).read_bytes(),
                             'archive metadata must not change bytes on a packaging retry')
            with tarfile.open(root / 'first' / name, 'r:gz') as archive:
                self.assertEqual(archive.getnames(), ['kinic-vfs-cli', 'README.md', 'LICENSE'])
                self.assertEqual(archive.getmember('kinic-vfs-cli').mode, 0o755)
                self.assertEqual(archive.extractfile('kinic-vfs-cli').read(), binary.read_bytes())
            result = subprocess.run(['bash', str(script), 'v2.0.6', 'macos-arm64', str(binary), str(root / 'wrong')],
                                    cwd=script.parent.parent, capture_output=True)
            self.assertNotEqual(result.returncode, 0, 'package must reject a binary with another version')


if __name__ == '__main__':
    unittest.main()
