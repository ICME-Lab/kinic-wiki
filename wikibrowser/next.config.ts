import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

type PublicVars = {
  NEXT_PUBLIC_WIKI_IC_HOST?: string;
  NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID?: string;
};

function readWranglerPublicVars(): PublicVars {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "wrangler.jsonc");
  const config: { vars?: PublicVars } = JSON.parse(readFileSync(configPath, "utf8"));
  return config.vars ?? {};
}

const wranglerVars = readWranglerPublicVars();

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  env: {
    NEXT_PUBLIC_WIKI_IC_HOST: process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? wranglerVars.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io",
    NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID: process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? wranglerVars.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? ""
  },
  reactStrictMode: true
};

export default nextConfig;
