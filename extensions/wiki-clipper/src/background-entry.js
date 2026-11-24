// Where: extensions/wiki-clipper/src/background-entry.js
// What: Unified MV3 service worker entrypoint loading Wiki Clipper and Vault AutoFill handlers.
// Why: Keeps Wiki and Vault service-worker modules strictly separated while sharing one extension.
import "./service-worker.js";
import "./vault/service-worker.ts";
