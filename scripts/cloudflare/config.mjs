import { loadAndParseConfig, convertToWranglerConfig } from "@cloudflare/config";
import { resolve } from "node:path";

export async function loadConfig(projectRoot, mode, filename = "cloudflare.config.ts") {
  const parsed = await loadAndParseConfig(resolve(projectRoot, filename), { isPreview: false, mode });
  if (!parsed.result.success) throw new Error(`Invalid cf config: ${JSON.stringify(parsed.result.error.issues)}`);
  return parsed.result.data;
}

// Keep the existing isolation assertions while validating the actual cf deployment config.
export async function loadWorkerConfig(projectRoot, mode, filename) {
  return convertToWranglerConfig(await loadConfig(projectRoot, mode, filename));
}
