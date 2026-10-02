// The command is a fixed package.json script; user options never enter shell text.
// Set the profile before any guard in a multi-command deployment starts.
import { spawnSync } from "node:child_process";
import { parseDeployArgs } from "./args.mjs";

const [command, ...input] = process.argv.slice(2);
if (!command) throw new Error("A deployment command is required");
const { args, profile } = parseDeployArgs(input);
if (args.length !== (profile === undefined ? 0 : 2)) {
  throw new Error("Package deployment scripts accept only --profile; use deploy.mjs for build options");
}
const result = spawnSync(command, {
  shell: true,
  stdio: "inherit",
  env: { ...process.env, ...(profile === undefined ? {} : { KINIC_CF_PROFILE: profile }) },
});
process.exit(result.status ?? 1);
