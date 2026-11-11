Upstream: passkey-auth 0.1.3, https://github.com/marirs/passkey-auth-rs (MIT OR Apache-2.0).
Local changes: IC clock for wasm, fail-closed unsupported synchronous OS entropy. The application constructs states with management raw_rand and does not call start_* helpers. Authentication verification is otherwise unchanged.
The packaged example/integration-test target declarations are omitted; upstream test targets were not copied or claimed as executed. LICENSE and APACHE-LICENSE are included.
