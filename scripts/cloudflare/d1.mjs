// Resolve the database UUID from the same mode-specific config used for deployment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.mjs";

const [action, mode, binding = "DB"] = process.argv.slice(2);
assert.ok(["apply", "list"].includes(action), "D1 action must be apply or list");
const { worker } = await loadConfig(process.cwd(), mode);
const database = worker.env?.[binding];
assert.equal(database?.type, "d1");
assert.match(database.id ?? "", /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u, "D1 database ID must be provisioned");
const result = spawnSync("pnpm", ["exec", "cf", "d1", "migrations", action, database.id, "--dir", "migrations", ...(mode ? ["--mode", mode] : [])], { stdio: "inherit" });
process.exit(result.status ?? 1);
