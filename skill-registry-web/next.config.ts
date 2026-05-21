import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  env: {
    NEXT_PUBLIC_WIKI_IC_HOST: process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io",
    NEXT_PUBLIC_II_PROVIDER_URL: process.env.NEXT_PUBLIC_II_PROVIDER_URL ?? "https://id.ai",
    NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID: process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? ""
  },
  reactStrictMode: true
};

export default nextConfig;
