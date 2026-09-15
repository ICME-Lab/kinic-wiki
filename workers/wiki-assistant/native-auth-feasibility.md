# Native preview authentication

The approved design uses one configured Wiki canister per environment. The Worker accepts a direct ICRC-167 delegation to its public key without requiring signed canister targets. Any targets present must allow the configured canister. Query-only permission, chain signatures (verified by the replica through a signed query), expiry, final key, invitation, principal equality and database access remain required.

The earlier target-restriction gate and temporary client-key proposal are superseded. No existing iOS private key is exported. Native and Web authorization entry points are separate; native sessions cannot refresh through the Web MCP grant flow.

Source evidence: [II delegation codec](https://github.com/dfinity/internet-identity/blob/3cd91d621bb060308d04ff41155f378f1bc857cb/src/frontend/src/lib/utils/transport/utils.ts#L205-L260). It preserves query-only permissions without requiring targets.

Real II authorization, GPT-Live, same-principal access and physical-device background audio remain release gates. Offline tests are not evidence that these live gates passed.
