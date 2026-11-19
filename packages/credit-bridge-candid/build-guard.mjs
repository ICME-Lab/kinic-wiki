import { configuredBridgeOrigins } from "./browser.ts";
// Local message origins must never enter a production package by accident.
export function assertCreditBridgeBuild(command, mode, env) {
  configuredBridgeOrigins({ ...env, MODE: mode });
  if (
    env.VITE_CREDIT_BRIDGE_LOCAL_TEST &&
    env.VITE_CREDIT_BRIDGE_LOCAL_TEST !== "1"
  )
    throw Error("Invalid credit bridge local-test flag");
  if (
    env.VITE_CREDIT_BRIDGE_LOCAL_TEST === "1" &&
    command === "build" &&
    mode !== "bridge-local-test"
  )
    throw Error(
      "Local credit bridge origins require --mode bridge-local-test; production packaging is forbidden",
    );
}
