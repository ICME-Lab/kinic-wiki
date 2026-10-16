# Kinic Wiki service discoverability

The browser Worker publishes two extensionless discovery endpoints before HTML,
page caching, or the `kinic.xyz` redirect:

| Path | Response |
| --- | --- |
| `/.well-known/ic-architecture` | JSON, schema version `1.0.0`, declaring the environment's Wiki backend canister |
| `/.well-known/ii-derivation-origin` | One HTTPS origin line: `https://<canister-id>.ic0.app` |

Both endpoints use the required runtime `KINIC_WIKI_CANISTER_ID`, support GET and
HEAD, and use `Cache-Control: no-store`. Invalid or absent IDs return 503 without
falling back to production. The Worker itself is not a frontend canister. Both
`https://wiki.kinic.xyz` and `https://kinic.xyz` serve discovery directly.

`get_api_doc : () -> (text) query` is public, static documentation. It embeds
`packages/vfs-client-core/api-guidance.json`, also imported by the existing MCP
Worker. Edit common semantic guidance there; keep MCP transport, tool limits,
OAuth and output-envelope details in MCP. Descriptor hashes must still match
unless an intentional MCP contract change is being made separately. The shared
Candid generator includes `get_api_doc`; build scripts retain public
`candid:service` metadata. No OQL surface or new content APIs are introduced.

## Identity and authorization

The browser's existing `icp0.io` derivation-origin setting is unchanged. II's
frontend normalizes that alias to the legacy `ic0.app` seed origin. Direct II
backend integrations, including the existing Private MCP, use the bare
`ic0.app` origin. The API gateway (`icp0.io`) is not the derivation origin.
Discovery therefore declares the existing Private MCP seed origin, per network:

| Environment | Canister | Declared origin |
| --- | --- | --- |
| Production | `6emaw-iyaaa-aaaay-aacka-cai` | `https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app` |
| Staging | `3ryrw-kyaaa-aaaaf-qgxpq-cai` | `https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app` |

Compare principals for the same II identity **and account** before release;
matching origin strings alone is insufficient. An origin mismatch must not be
worked around by adding members or changing owners. The canister's existing
authorization applies to direct calls. Its full Candid interface includes methods
outside the content-only MCP tool list; discoverability does not enforce that
tool subset or change any permission.

See the [service discoverability guide](https://docs.internetcomputer.org/guides/frontends/service-discoverability/)
and [existing MCP identity contract](mcp.md#private-authentication).

## Local verification

Run from the repository root:

```sh
cargo test -p vfs-canister --locked
pnpm --dir workers/wiki-mcp test
pnpm --dir workers/wiki-mcp typecheck
pnpm --dir wikibrowser test
pnpm --dir wikibrowser typecheck
pnpm --dir packages/vfs-candid test
pnpm --dir tools/candid test
pnpm --dir packages/vfs-client-core test
bash scripts/build-vfs-canister.sh
pnpm --dir workers/wiki-mcp build
pnpm --dir wikibrowser build
pnpm --dir wikibrowser build:worker
```

These build commands produce local artifacts/dry runs; they do not publish the
application. They do not establish live ICP MCP access or principal equality.

## Staging acceptance after a separately authorized deployment

1. Deploy the staging canister first using the existing staging deployment
   procedure in [STAGING.md](STAGING.md). Read its public metadata and guide:

   ```sh
   icp canister metadata 3ryrw-kyaaa-aaaaf-qgxpq-cai candid:service -n ic
   icp canister call 3ryrw-kyaaa-aaaaf-qgxpq-cai get_api_doc '()' --query -n ic
   ```

   Confirm the query returns the guide and the metadata declares
   `get_api_doc : () -> (text) query`. Retain existing deployment safeguards;
   this document does not authorize an upgrade or override them.

2. Publish the staging browser Worker only after that check. Verify discovery:

   ```sh
   curl -fsS -D - https://kinic-wiki-browser-staging.hude.workers.dev/.well-known/ic-architecture
   curl -fsS -D - https://kinic-wiki-browser-staging.hude.workers.dev/.well-known/ii-derivation-origin
   ```

   Require status 200, JSON for the manifest, a single staging backend, and the
   staging `ic0.app` origin. No HTML, production ID, or redirect should appear.

3. Give ICP MCP only the staging browser URL through `open_app`. Require a
   declared canister from `ic-architecture`, no discovery error, and the correct
   derivation origin. Use the returned `app_url` explicitly for subsequent Candid,
   documentation, query and update calls: the manifest lives on the Worker, not
   the derivation-origin canister. Require API documentation to be available and
   ordinary Candid queries to work (no OQL mode).

4. Select the same II identity and account in the browser, existing Private
   staging MCP and ICP MCP. Compare the browser identity principal with ICP MCP's
   `get_app_principal` and the existing MCP's authenticated profile ID. Verify all
   three match. Stop publication on any mismatch; keep principal values out of
   committed logs and do not alter authorization to make the comparison pass.

5. With read permission, use `list_databases`, `memory_manifest`, `query_context`,
   `search_nodes` and `read_nodes` against the same accessible staging database.
   Compare selected page bodies and etags with the existing MCP. Read known paths
   directly; verify a valid missing path returns an item `Ok(None)`, while an
   invalid path returns an item `Err`. Both must preserve successful items in the
   same outer `Ok` batch.

6. For write acceptance, create an isolated temporary fixture in the staging test
   database using the existing smoke-fixture convention and record its current
   etags. With `Actions & questions`, test `write_nodes`, an etag-guarded edit,
   stale-etag rejection, and an atomic mixed batch with a deliberately invalid
   operation. Verify rejected batches leave all fixture nodes unchanged. Use only
   the fixture; do not invoke purchase, publication, administration or live user
   content operations. Clean up the exact fixture nodes using current etags.

7. Repeat access with an account lacking access to the fixture database; private
   reads and writes must fail. With a fresh `Questions only` II authorization,
   verify reads succeed and a fixture update is refused with unchanged content.
   Check the canister result as well as the transport status; `Err` is not success.

Record pass/fail evidence and whether live identity/writes were actually tested.
Local mocks are not evidence of deployed principal equality or II permission
enforcement. No end-to-end claim is made until these steps pass.

## Production publication and rollback

Publishing a valid manifest opts the application into ICP MCP and accepts its
[App Operator Terms](https://internetcomputer.org/icp-mcp/app-operator-terms/).
Public deployment is a separate operator action, not part of implementing this
change.

After staging acceptance and explicit publication authorization, update the
production canister first, confirm public metadata/documentation, then publish the
browser Worker. Check both production domains and confirm the production backend
and seed origin. Monitor Worker discovery 5xx responses, ICP MCP discovery errors,
principal mismatches and unexpected permission failures. Avoid logging tokens,
delegations, private page bodies or user principals.

To stop participation, roll back the browser Worker to the pre-discovery version,
or remove both discovery route handlers and return 404 for the manifest. Check
both production domains (and staging if applicable): neither may still serve a
valid manifest. ICP MCP stops new metadata/query/update calls once it observes
removal; existing metadata caches and already submitted updates are not undone.
The public documentation query can remain installed. Do not downgrade canister
state or roll back a database to disable discovery.
