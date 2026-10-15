#!/usr/bin/env python3
"""Validate maintenance completion claims without executing Wiki mutations."""
import argparse
import json
from pathlib import Path


def validate(report):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    def paths(value):
        return isinstance(value, list) and all(isinstance(p, str) and p.startswith('/') for p in value)

    if not isinstance(report, dict):
        return ['report must be an object']
    target = report.get('target', {})
    budget = report.get('budgets', {})
    coverage = report.get('coverage', {})
    if not all(isinstance(v, dict) for v in (target, budget, coverage)):
        return ['target, budgets and coverage must be objects']
    for key in ('canister_id', 'database_id'):
        require(isinstance(target.get(key), str) and bool(target[key].strip()), f'target.{key} required')
    prefix = target.get('prefix', '')
    valid_prefix = isinstance(prefix, str) and (prefix == '/Knowledge' or prefix.startswith('/Knowledge/')) and all(p not in ('', '.', '..') for p in prefix.split('/')[1:])
    require(valid_prefix, 'target.prefix must be a normalized Knowledge prefix')
    mode = target.get('mode')
    require(mode in ('inspect', 'repair'), 'target.mode must be inspect or repair')
    for key in ('max_passes', 'max_changed_nodes', 'max_minutes'):
        require(type(budget.get(key)) is int and budget[key] > 0, f'budgets.{key} must be a positive integer')
    passes = report.get('passes')
    elapsed = report.get('elapsed_minutes')
    require(type(passes) is int and 0 <= passes <= budget.get('max_passes', 0) if type(budget.get('max_passes')) is int else False, 'passes must fit budget')
    require(type(elapsed) in (int, float) and elapsed >= 0 and elapsed < float('inf'), 'elapsed_minutes must be finite and non-negative')
    changed = report.get('changed_paths')
    require(paths(changed), 'changed_paths must contain absolute paths')
    if paths(changed):
        require(len(changed) == len(set(changed)), 'changed_paths must be unique')
        require(type(budget.get('max_changed_nodes')) is int and len(changed) <= budget['max_changed_nodes'], 'changed node budget exceeded')
        require(valid_prefix and all(p.startswith(prefix + '/') and all(s not in ('', '.', '..') for s in p.split('/')[1:]) for p in changed), 'changed paths must stay within target prefix')
        require(mode == 'repair' or not changed, 'inspect mode cannot change nodes')
    require(coverage.get('status') in ('complete', 'partial'), 'coverage.status required')
    for key in ('inspected_paths', 'uninspected_paths'):
        require(paths(coverage.get(key)), f'coverage.{key} must contain absolute paths')
    require(isinstance(coverage.get('evidence'), list) and bool(coverage['evidence']), 'coverage evidence required')
    if coverage.get('status') == 'complete':
        require(coverage.get('uninspected_paths') == [], 'complete coverage cannot have uninspected paths')
    findings = report.get('findings')
    require(isinstance(findings, list), 'findings must be a list')
    ids = set()
    open_ids = set()
    for finding in findings if isinstance(findings, list) else []:
        if not isinstance(finding, dict):
            errors.append('finding must be an object')
            continue
        finding_id = finding.get('id')
        require(isinstance(finding_id, str) and bool(finding_id) and finding_id not in ids, 'finding IDs must be nonempty and unique')
        if isinstance(finding_id, str):
            ids.add(finding_id)
        require(paths(finding.get('paths')) and bool(finding['paths']), 'finding paths required')
        require(bool(finding.get('impact')) and bool(finding.get('evidence')), 'finding impact and evidence required')
        require(finding.get('status') in ('open', 'resolved'), 'finding status invalid')
        if finding.get('status') == 'resolved':
            require(bool(finding.get('verification')), 'resolved finding needs reinspection evidence')
        elif isinstance(finding_id, str):
            open_ids.add(finding_id)
    unresolved = report.get('unresolved')
    require(isinstance(unresolved, list) and all(isinstance(v, str) and v for v in unresolved), 'unresolved must list IDs or operational blockers')
    if isinstance(unresolved, list) and all(isinstance(v, str) for v in unresolved):
        require(open_ids.issubset(unresolved), 'all open findings must remain unresolved')
    verification = report.get('verification')
    require(isinstance(verification, list), 'verification must be a list')
    final_verification = {}
    for entry in verification if isinstance(verification, list) else []:
        if not isinstance(entry, dict):
            errors.append('verification entry must be an object')
            continue
        path = entry.get('path')
        result = entry.get('result')
        valid_path = isinstance(path, str) and path.startswith('/')
        require(valid_path, 'verification path must be absolute')
        require(result in ('passed', 'failed'), 'verification result must be passed or failed')
        require(bool(entry.get('evidence')), 'verification evidence required')
        if valid_path:
            # Entries are chronological; a later failed check supersedes a pass.
            final_verification[path] = result
    verified = {path for path, result in final_verification.items() if result == 'passed'}
    failed = {path for path, result in final_verification.items() if result == 'failed'}
    reason = report.get('stop_reason')
    require(reason in ('clean', 'inspection_only', 'pass_limit', 'node_limit', 'time_limit', 'coverage_incomplete', 'permission_denied', 'conflict', 'verification_failed'), 'invalid stop_reason')
    status = report.get('status')
    require(status in ('complete', 'needs_repair', 'incomplete'), 'invalid status')
    if failed:
        require(status == 'incomplete', 'failed final verification must remain incomplete')
    if status in ('complete', 'needs_repair'):
        require(type(passes) is int and passes >= 1, 'finished inspection requires at least one pass')
        require(type(elapsed) in (int, float) and type(budget.get('max_minutes')) is int and elapsed <= budget['max_minutes'], 'finished run exceeds time budget')
    if status == 'complete':
        require(reason == 'clean' and coverage.get('status') == 'complete' and not open_ids and unresolved == [], 'complete requires clean, fully inspected, resolved state')
        require(paths(changed) and set(changed).issubset(verified), 'every changed path needs passed readback/reinspection')
    elif status == 'needs_repair':
        require(mode == 'inspect' and reason == 'inspection_only' and coverage.get('status') == 'complete' and bool(open_ids), 'needs_repair requires inspect findings and complete coverage')
    else:
        require(bool(unresolved) and reason not in ('clean', 'inspection_only'), 'incomplete requires a blocker and its stopping reason')
    if coverage.get('status') == 'partial':
        require(status == 'incomplete', 'partial coverage must remain incomplete')
    if reason in ('permission_denied', 'conflict', 'verification_failed', 'pass_limit', 'node_limit', 'time_limit', 'coverage_incomplete'):
        require(status == 'incomplete', 'stopped runs must remain incomplete')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    try:
        errors = validate(json.loads(args.report.read_text()))
    except (OSError, ValueError, TypeError, KeyError) as error:
        errors = [str(error)]
    for error in errors:
        print(error)
    if errors:
        raise SystemExit(1)
    print('Maintenance report is consistent.')


if __name__ == '__main__':
    main()
