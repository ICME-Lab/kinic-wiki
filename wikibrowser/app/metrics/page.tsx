import type { Metadata } from "next";
import { MetricsClient } from "./metrics-client";

export const metadata: Metadata = {
  title: "Kinic Wiki Metrics",
  description: "Public metrics for Kinic Wiki usage and KINIC charges."
};

export default function MetricsPage() {
  return <MetricsClient canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""} />;
}
