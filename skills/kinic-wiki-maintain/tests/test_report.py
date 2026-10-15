"""Isolated report scenarios: no remote credentials, API calls or Wiki writes."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('report', Path(__file__).parents[1] / 'scripts/validate-report.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def clean(mode='repair'):
    return dict(target=dict(canister_id='test-canister', database_id='fixture', prefix='/Knowledge/demo', mode=mode),
                budgets=dict(max_passes=3, max_changed_nodes=20, max_minutes=15), passes=1, elapsed_minutes=1,
                coverage=dict(status='complete', inspected_paths=['/Knowledge/demo/article.md'], uninspected_paths=[], evidence=['fixture inventory exhausted']),
                findings=[], changed_paths=[], verification=[], unresolved=[], stop_reason='clean', status='complete')


def issue():
    return dict(id='broken-link', paths=['/Knowledge/demo/index.md'], impact='Moved article cannot be reached', evidence=['index points to missing old.md; new.md read'], status='open')


class ReportTests(unittest.TestCase):
    def test_inspection_is_read_only_and_reports_findings(self):
        report = clean('inspect')
        report.update(findings=[issue()], unresolved=['broken-link'], status='needs_repair', stop_reason='inspection_only')
        self.assertEqual(module.validate(report), [])
        report['changed_paths'] = ['/Knowledge/demo/index.md']
        self.assertIn('inspect mode cannot change nodes', module.validate(report))

    def test_write_ack_is_not_verification(self):
        report = clean()
        report.update(changed_paths=['/Knowledge/demo/index.md'])
        self.assertTrue(module.validate(report))
        finding = issue()
        finding.update(status='resolved', verification='saved catalog read; new.md resolves; affected lint rerun')
        report.update(findings=[finding], verification=[dict(path='/Knowledge/demo/index.md', result='passed', evidence=finding['verification'])])
        self.assertEqual(module.validate(report), [])

    def test_latest_verification_controls_completion(self):
        path = '/Knowledge/demo/index.md'
        passed = dict(path=path, result='passed', evidence='readback and link checks passed')
        failed = dict(path=path, result='failed', evidence='later reinspection found broken link')
        for changed_paths in ([], [path]):
            report = clean()
            report.update(changed_paths=changed_paths, verification=[passed, failed])
            self.assertIn('failed final verification must remain incomplete', module.validate(report))
            report.update(status='incomplete', stop_reason='verification_failed', unresolved=['later reinspection failed'])
            self.assertEqual(module.validate(report), [])

        report = clean()
        report.update(changed_paths=[path], verification=[failed, passed])
        self.assertEqual(module.validate(report), [])

    def test_failed_verification_of_an_unchanged_path_blocks_completion(self):
        report = clean()
        report['verification'] = [dict(path='/Knowledge/demo/article.md', result='failed', evidence='link target missing')]
        self.assertIn('failed final verification must remain incomplete', module.validate(report))

    def test_verification_entries_require_path_result_and_evidence(self):
        for entry in [None, {}, dict(path='relative.md', result='passed', evidence='read'),
                      dict(path='/Knowledge/demo/index.md', result='skipped', evidence='not checked'),
                      dict(path='/Knowledge/demo/index.md', result='passed')]:
            report = clean()
            report['verification'] = [entry]
            self.assertTrue(module.validate(report))

    def test_conflict_permission_and_budget_stops_preserve_partial_progress(self):
        for reason in ('conflict', 'permission_denied', 'node_limit', 'pass_limit', 'time_limit', 'verification_failed'):
            report = clean()
            report.update(status='incomplete', stop_reason=reason, findings=[issue()], unresolved=['broken-link', reason])
            self.assertEqual(module.validate(report), [], reason)
            report.update(status='complete', unresolved=[])
            self.assertTrue(module.validate(report), reason)

    def test_limit_cannot_masquerade_as_complete_inspection(self):
        report = clean()
        report['coverage'].update(status='partial', uninspected_paths=['/Knowledge/demo/remaining'])
        self.assertTrue(module.validate(report))
        report.update(status='incomplete', stop_reason='coverage_incomplete', unresolved=['inventory at limit'])
        self.assertEqual(module.validate(report), [])

    def test_scope_escape_and_duplicate_writes_rejected(self):
        for path in ('/Sources/raw.md', '/Knowledge/demo-other/a.md', '/Knowledge/demo/../other.md'):
            report = clean()
            report['changed_paths'] = [path]
            self.assertTrue(module.validate(report))
        report = clean()
        report['changed_paths'] = ['/Knowledge/demo/index.md'] * 2
        self.assertIn('changed_paths must be unique', module.validate(report))

    def test_clean_repeat_needs_no_rewrite(self):
        self.assertEqual(module.validate(clean()), [])
        self.assertEqual(module.validate(copy.deepcopy(clean())), [])

    def test_malformed_report_rejected(self):
        for value in (None, [], {}, {'target': []}):
            self.assertTrue(module.validate(value))


if __name__ == '__main__':
    unittest.main()
