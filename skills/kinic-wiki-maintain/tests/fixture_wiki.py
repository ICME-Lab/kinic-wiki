#!/usr/bin/env python3
"""Offline rehearsal adapter. Models VFS reads/etag writes; never connects to a canister.

Use only for skill rehearsal, not as a production VFS client or proof of canister behavior.
"""
import argparse
import hashlib
import json
from pathlib import Path


def etag(content):
    return hashlib.sha256(content.encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--mode', choices=['inspect', 'repair'], default='inspect')
    parser.add_argument('command', choices=['init', 'inventory', 'read', 'write'])
    parser.add_argument('--path')
    parser.add_argument('--content-file', type=Path)
    parser.add_argument('--expected-etag')
    args = parser.parse_args()
    if args.command == 'init':
        if args.state.exists():
            parser.error('refusing to overwrite a rehearsal')
        args.state.parent.mkdir(parents=True, exist_ok=True)
        docs = {
            '/Knowledge/demo/index.md': '# Index\n\nA reading guide to the deployment decision.\n\n- [Decision](old.md)\n',
            '/Knowledge/demo/overview.md': '# Demo\n\nAll costs in these notes are in USD.\n',
            '/Knowledge/demo/decision.md': '# Deployment decision\n\nThe team selected a staged rollout.\n',
        }
        args.state.write_text(json.dumps({'nodes': {path: {'content': content, 'etag': etag(content)} for path, content in docs.items()}, 'writes': []}, indent=2))
        print('Offline fixture initialized')
        return
    state = json.loads(args.state.read_text())
    if args.command == 'inventory':
        print(json.dumps({'paths': sorted(state['nodes']), 'complete': True, 'writes': state['writes']}))
    elif args.command == 'read':
        print(json.dumps({'path': args.path, 'node': state['nodes'].get(args.path)}))
    else:
        if args.mode != 'repair':
            parser.error('inspect mode cannot write')
        if args.path not in state['nodes'] or not args.path.startswith('/Knowledge/demo/') or '..' in args.path.split('/'):
            parser.error('write outside fixture repair set')
        current = state['nodes'][args.path]
        if current['etag'] != args.expected_etag:
            parser.error('etag conflict')
        if not args.content_file:
            parser.error('--content-file required')
        content = args.content_file.read_text()
        if content != current['content']:
            state['nodes'][args.path] = {'content': content, 'etag': etag(content)}
            state['writes'].append(args.path)
            args.state.write_text(json.dumps(state, indent=2))
        print(json.dumps({'path': args.path, 'node': state['nodes'][args.path]}))


if __name__ == '__main__':
    main()
