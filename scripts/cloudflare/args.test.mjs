import assert from "node:assert/strict";
import test from "node:test";
import { parseDeployArgs } from "./args.mjs";

test("mode and profile spelling normalize to a single target", () => {
  for (const mode of [["--mode", "staging"], ["--mode=staging"], ["-m", "staging"], ["-m=staging"]]) {
    for (const profile of [["--profile", "production-account"], ["--profile=production-account"]]) {
      assert.deepEqual(parseDeployArgs([...mode, "--dry-run", ...profile], "other-account"), {
        mode: "staging", profile: "production-account",
        args: ["--dry-run", "--mode", "staging", "--profile", "production-account"],
      });
    }
  }
});
test("missing and conflicting routing values fail before any command runs", () => {
  for (const args of [["--mode"], ["--mode="], ["--profile", "--dry-run"], ["--profile="],
    ["--mode=staging", "--mode", "production"], ["--profile=a", "--profile=b"]]) {
    assert.throws(() => parseDeployArgs(args, undefined));
  }
});
